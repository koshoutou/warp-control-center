import { EventEmitter } from 'node:events'
import { createServer as createTcpServer, createConnection, type Socket } from 'node:net'
import type { Config } from './config.js'
import type { WarpManager } from './warp-manager.js'
import type { Logger } from './logger.js'
import type { MetricsCollector } from './metrics.js'

/**
 * Native SOCKS5 (RFC 1928) + HTTP CONNECT proxy.
 *
 * This single Node process replaces the original image's `socat` double-hop:
 *   client → socat:40000 → warp-svc:40001 → MASQUE
 * becomes:
 *   client → [this proxy:40000] → warp-svc:40001 → MASQUE
 *
 * One process, one accept() per connection, zero-copy pipe() between the two
 * sockets. No fork, no extra TCP listener. Idle connections are reaped.
 *
 * In DEMO mode (warp-svc missing) it does an HTTP echo so the dashboard can
 * still demonstrate end-to-end connectivity without a real WARP tunnel.
 */

export interface ProxyStats {
  listening: boolean
  port: number
  connections: number
  totalConnections: number
  activeRx: number // bytes/sec (rolling)
  activeTx: number
  totalRx: number
  totalTx: number
  rejected: number
  demo: boolean
}

interface ConnCtx {
  id: number
  sock: Socket
  upstream: Socket | null
  rxBytes: number
  txBytes: number
  openedAt: number
  host: string
  port: number
  idleTimer: NodeJS.Timeout | null
}

export interface ProxyServer extends EventEmitter {
  start(): Promise<void>
  stop(): Promise<void>
  getStats(): ProxyStats
  on(event: 'connection:event', listener: (e: ConnEvent) => void): this
  on(event: 'traffic', listener: (d: { rx: number; tx: number }) => void): this
  emit(event: 'connection:event', e: ConnEvent): boolean
  emit(event: 'traffic', d: { rx: number; tx: number }): boolean
}

export interface ConnEvent {
  type: 'open' | 'close' | 'error'
  id: number
  host?: string
  port?: number
  rx?: number
  tx?: number
  durationMs?: number
  reason?: string
}

export function createProxyServer(deps: { config: Config; warp: WarpManager; logger: Logger; metrics: MetricsCollector }): ProxyServer {
  const { config, warp, logger } = deps
  const emitter = new EventEmitter() as ProxyServer
  let server: ReturnType<typeof createTcpServer> | null = null
  let nextId = 1
  const conns = new Map<number, ConnCtx>()
  /** Pin in-flight upstream sockets so the GC can't collect them before connect resolves. */
  const dialing = new Set<Socket>()

  const stats: ProxyStats = {
    listening: false,
    port: config.proxyPort,
    connections: 0,
    totalConnections: 0,
    activeRx: 0,
    activeTx: 0,
    totalRx: 0,
    totalTx: 0,
    rejected: 0,
    demo: false,
  }

  // Rolling rate (bytes/sec) — sampled by metrics collector.
  let rxWindow = 0
  let txWindow = 0
  deps.metrics.on('tick', () => {
    stats.activeRx = rxWindow
    stats.activeTx = txWindow
    rxWindow = 0
    txWindow = 0
  })

  function bumpIdle(ctx: ConnCtx) {
    if (ctx.idleTimer) clearTimeout(ctx.idleTimer)
    ctx.idleTimer = setTimeout(() => {
      logger.debug('proxy', `conn#${ctx.idleTimer ? ctx.idle : ctx.id} idle timeout → closing`)
      closeConn(ctx, 'idle-timeout')
    }, config.idleTimeoutMs)
    ctx.idleTimer.unref?.()
  }

  function closeConn(ctx: ConnCtx, reason = 'normal') {
    if (ctx.idleTimer) { clearTimeout(ctx.idleTimer); ctx.idleTimer = null }
    try { ctx.sock.destroy() } catch {}
    try { ctx.upstream?.destroy() } catch {}
    if (conns.delete(ctx.id)) {
      stats.connections = conns.size
      emitter.emit('connection:event', {
        type: 'close',
        id: ctx.id,
        host: ctx.host,
        port: ctx.port,
        rx: ctx.rxBytes,
        tx: ctx.txBytes,
        durationMs: Date.now() - ctx.openedAt,
        reason,
      })
    }
  }

  function pipeBoth(client: Socket, upstream: Socket, ctx: ConnCtx) {
    const onClientData = (d: Buffer) => {
      ctx.txBytes += d.length
      stats.totalTx += d.length
      txWindow += d.length
      bumpIdle(ctx)
      if (!upstream.write(d)) client.pause()
    }
    const onUpstreamData = (d: Buffer) => {
      ctx.rxBytes += d.length
      stats.totalRx += d.length
      rxWindow += d.length
      bumpIdle(ctx)
      if (!client.write(d)) upstream.pause()
    }
    client.on('data', onClientData)
    upstream.on('data', onUpstreamData)
    client.on('drain', () => upstream.resume())
    upstream.on('drain', () => client.resume())
    const end = (reason: string) => closeConn(ctx, reason)
    client.on('error', () => end('client-error'))
    upstream.on('error', () => end('upstream-error'))
    client.on('end', () => end('client-end'))
    upstream.on('end', () => end('upstream-end'))
    client.on('close', () => end('client-close'))
    upstream.on('close', () => end('upstream-close'))
  }

  /** Connect to the real WARP upstream (warp-svc on 40001) or, in demo mode, to a target echo. */
  function dialUpstream(host: string, port: number, cb: (err: Error | null, sock?: Socket) => void) {
    if (warp.isDemo()) {
      // DEMO: connect to the literal target so the proxy still demonstrates SOCKS5 routing.
      // (In a real sandbox this usually fails for external hosts — that's expected and labeled.)
      logger.debug('proxy', `demo dial → ${host}:${port}`)
      doDial(host, port, cb)
      return
    }
    // LIVE: pipe everything through warp-svc's SOCKS5 on 40001.
    // We speak SOCKS5 client to 127.0.0.1:40001 so the upstream resolves *through* WARP.
    dialViaWarpSocks(host, port, cb)
  }

  /** Raw TCP dial with a hard timeout. Used by demo mode. */
  function doDial(host: string, port: number, cb: (err: Error | null, sock?: Socket) => void) {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const finish = (err: Error | null, sock?: Socket) => {
      if (settled) return
      settled = true
      if (timer) { clearTimeout(timer); timer = null }
      if (err) { logger.warn('proxy', `demo dial failed ${host}:${port}: ${err.message}`); cb(err) }
      else { logger.debug('proxy', `demo dial connected ${host}:${port}`); cb(null, sock) }
    }
    timer = setTimeout(() => finish(new Error('demo dial timeout')), 6000)
    const s = createConnection({ host, port }, () => finish(null, s))
    s.once('error', (e: Error) => finish(e))
    dialing.add(s)
    s.on('close', () => { dialing.delete(s); finish(new Error('closed before connect')) })
  }

  /** Minimal SOCKS5 client → talks to warp-svc:40001. */
  function dialViaWarpSocks(host: string, port: number, cb: (err: Error | null, sock?: Socket) => void) {
    const s = new Socket()
    s.setTimeout(8000)
    let phase: 'greet' | 'auth' | 'req' | 'done' = 'greet'
    const fail = (e: Error) => { try { s.destroy() } catch {}; cb(e) }

    s.once('connect', () => {
      // greet: VER=5, NMETHODS=1, METHOD=0 (no auth)
      s.write(Buffer.from([0x05, 0x01, 0x00]))
    })
    s.on('data', (buf: Buffer) => {
      if (phase === 'greet') {
        if (buf.length < 2 || buf[0] !== 0x05) return fail(new Error('warp-svc: bad SOCKS greet'))
        // assume no-auth accepted
        phase = 'req'
        const isIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
        let addr: Buffer
        let atyp: number
        if (isIPv4) {
          atyp = 0x01
          addr = Buffer.from(host.split('.').map(Number))
        } else {
          atyp = 0x03
          const b = Buffer.from(host, 'utf8')
          if (b.length > 255) return fail(new Error('host too long'))
          addr = Buffer.concat([Buffer.from([b.length]), b])
        }
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, atyp]),
          addr,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ])
        s.write(req)
        return
      }
      if (phase === 'req') {
        if (buf.length < 4 || buf[0] !== 0x05) return fail(new Error('warp-svc: bad SOCKS reply'))
        if (buf[1] !== 0x00) return fail(new Error(`warp-svc: connect rejected code=${buf[1]}`))
        phase = 'done'
        s.setTimeout(0)
        s.removeAllListeners('data')
        cb(null, s)
        return
      }
    })
    s.once('timeout', () => fail(new Error('warp-svc dial timeout')))
    s.once('error', (e) => fail(e))
    s.connect(config.upstreamPort, config.upstreamHost)
  }

  // ---- SOCKS5 server handler ----
  function handleSocks5(sock: Socket) {
    const ctx: ConnCtx = { id: nextId++, sock, upstream: null, rxBytes: 0, txBytes: 0, openedAt: Date.now(), host: '', port: 0, idleTimer: null }
    conns.set(ctx.id, ctx)
    stats.connections = conns.size
    stats.totalConnections++
    bumpIdle(ctx)
    emitter.emit('connection:event', { type: 'open', id: ctx.id })

    let greeted = false
    sock.once('data', (buf: Buffer) => {
      if (buf[0] === 0x05) {
        // SOCKS5
        const nmethods = buf[1] | 0
        // expect methods; reply no-auth
        sock.write(Buffer.from([0x05, 0x00]))
        greeted = true
        sock.once('data', (req: Buffer) => handleSocks5Request(ctx, req))
        void nmethods
      } else if (buf.toString('ascii').startsWith('CONNECT ')) {
        // HTTP CONNECT
        handleHttpConnect(ctx, buf, sock)
      } else if (buf.toString('ascii').match(/^(GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH) /)) {
        handleHttpProxy(ctx, buf, sock)
      } else {
        rejectConn(ctx, 'unsupported-protocol')
      }
    })
    sock.on('error', () => closeConn(ctx, 'client-error'))
  }

  function handleSocks5Request(ctx: ConnCtx, req: Buffer) {
    if (req.length < 4 || req[0] !== 0x05) return rejectConn(ctx, 'bad-socks-request')
    const cmd = req[1]
    if (cmd !== 0x01) return rejectConn(ctx, 'socks-cmd-not-supported') // only CONNECT
    const atyp = req[3]
    let host = ''
    let port = 0
    let off = 4
    if (atyp === 0x01) {
      host = `${req[off]}.${req[off + 1]}.${req[off + 2]}.${req[off + 3]}`
      off += 4
    } else if (atyp === 0x03) {
      const len = req[off]; off++
      host = req.subarray(off, off + len).toString('utf8')
      off += len
    } else if (atyp === 0x04) {
      const b = req.subarray(off, off + 16)
      host = [...b].map((x) => x.toString(16).padStart(2, '0')).join(':')
      off += 16
    } else {
      return rejectConn(ctx, 'socks-atyp-not-supported')
    }
    port = (req[off] << 8) | req[off + 1]
    ctx.host = host
    ctx.port = port
    logger.debug('proxy', `conn#${ctx.id} SOCKS5 → ${host}:${port}`)
    dialUpstream(host, port, (err, up) => {
      if (err || !up) {
        const code = socksReplyFor(err)
        try { ctx.sock.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])) } catch {}
        return closeConn(ctx, `dial-failed: ${(err as Error)?.message}`)
      }
      ctx.upstream = up
      try { ctx.sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])) } catch {}
      pipeBoth(ctx.sock, up, ctx)
    })
  }

  function handleHttpConnect(ctx: ConnCtx, firstBuf: Buffer, sock: Socket) {
    const line = firstBuf.toString('ascii').split('\r\n')[0]
    const m = line.match(/^CONNECT\s+(\S+)\s+HTTP\/[\d.]+$/i)
    if (!m) return rejectConn(ctx, 'bad-http-connect')
    const [host, portStr] = m[1].split(':')
    const port = portStr ? Number(portStr) : 443
    ctx.host = host
    ctx.port = port
    logger.debug('proxy', `conn#${ctx.id} HTTP CONNECT → ${host}:${port}`)
    dialUpstream(host, port, (err, up) => {
      if (err || !up) {
        try { sock.write('HTTP/1.1 502 Bad Gateway\r\n\r\n') } catch {}
        return closeConn(ctx, `dial-failed: ${(err as Error)?.message}`)
      }
      ctx.upstream = up
      try { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n') } catch {}
      // If there's leftover data in firstBuf after the CONNECT line, forward it.
      const idx = firstBuf.indexOf('\r\n\r\n')
      if (idx >= 0 && idx + 4 < firstBuf.length) {
        const rest = firstBuf.subarray(idx + 4)
        if (rest.length) { ctx.txBytes += rest.length; up.write(rest) }
      }
      pipeBoth(sock, up, ctx)
    })
  }

  /** Plain HTTP proxy (non-CONNECT) — rewrite absolute URI and forward via the upstream. */
  function handleHttpProxy(ctx: ConnCtx, firstBuf: Buffer, sock: Socket) {
    const lines = firstBuf.toString('utf8').split('\r\n')
    const first = lines[0]
    const m = first.match(/^(\S+)\s+http:\/\/(\S+)\s+HTTP\/[\d.]+$/i)
    if (!m) return rejectConn(ctx, 'bad-http-proxy')
    const method = m[1]
    const target = m[2]
    const [hostPort, ...pathParts] = target.split('/')
    const path = '/' + pathParts.join('/')
    const [host, portStr] = hostPort.split(':')
    const port = portStr ? Number(portStr) : 80
    ctx.host = host
    ctx.port = port
    logger.debug('proxy', `conn#${ctx.id} HTTP ${method} → ${host}:${port}`)
    dialUpstream(host, port, (err, up) => {
      if (err || !up) {
        try { sock.write('HTTP/1.1 502 Bad Gateway\r\n\r\n') } catch {}
        return closeConn(ctx, `dial-failed: ${(err as Error)?.message}`)
      }
      ctx.upstream = up
      // Rewrite request line to relative path
      lines[0] = `${method} ${path} HTTP/1.1`
      const rewritten = Buffer.from(lines.join('\r\n'), 'utf8')
      ctx.txBytes += rewritten.length
      up.write(rewritten)
      pipeBoth(sock, up, ctx)
    })
  }

  function rejectConn(ctx: ConnCtx, reason: string) {
    stats.rejected++
    emitter.emit('connection:event', { type: 'error', id: ctx.id, reason })
    closeConn(ctx, reason)
  }

  function socksReplyFor(err: Error | null | undefined): number {
    if (!err) return 0x01
    const m = err.message.toLowerCase()
    if (m.includes('timeout')) return 0x05
    if (m.includes('refused')) return 0x05
    if (m.includes('unreachable') || m.includes('host')) return 0x04
    return 0x01
  }

  emitter.start = () => new Promise<void>((resolve, reject) => {
    server = createTcpServer((sock) => {
      if (conns.size >= config.maxConnections) {
        stats.rejected++
        try { sock.write(Buffer.from([0x05, 0x05])) } catch {}
        sock.destroy()
        logger.warn('proxy', `connection rejected — at maxConnections=${config.maxConnections}`)
        return
      }
      handleSocks5(sock)
    })
    server.on('error', (e) => { logger.error('proxy', `server error: ${e.message}`); reject(e) })
    server.listen(config.proxyPort, '0.0.0.0', () => {
      stats.listening = true
      stats.demo = warp.isDemo()
      logger.info('proxy', `listening on 0.0.0.0:${config.proxyPort} (mode=${stats.demo ? 'demo' : 'live→warp-svc:' + config.upstreamPort})`)
      resolve()
    })
  })

  emitter.stop = () => new Promise<void>((resolve) => {
    for (const ctx of conns.values()) closeConn(ctx, 'shutdown')
    if (!server) return resolve()
    server.close(() => { stats.listening = false; resolve() })
  })

  emitter.getStats = () => ({ ...stats })

  return emitter
}
