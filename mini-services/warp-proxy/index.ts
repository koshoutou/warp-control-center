/**
 * WarpProxy — optimized Node.js rewrite of seiry/cloudflare-warp-proxy.
 *
 * What this replaces from the original Docker image:
 *  - `socat TCP-LISTEN:40000,fork TCP:localhost:40001`  →  native Node SOCKS5 + HTTP-CONNECT proxy
 *  - `bash entrypoint.sh`                                →  typed Node supervisor
 *  - separate `socat` process per connection             →  single event-loop, zero-copy pipe()
 *
 * The official `warp-svc` (Rust daemon from the `cloudflare-warp` apt package) is still required
 * to actually speak the MASQUE protocol — that part is NOT reimplementable in pure Node.
 * This service *manages* warp-svc efficiently and provides the proxy front-end.
 *
 * If warp-svc is unavailable (e.g. no root / no CAP_NET_ADMIN), it runs in clearly-labeled
 * DEMO mode so the dashboard + architecture can still be evaluated.
 */
import { createServer } from 'node:http'
import { Server as IoServer, type Socket } from 'socket.io'
import { createProxyServer } from './src/proxy-server.js'
import { WarpManager } from './src/warp-manager.js'
import { MetricsCollector } from './src/metrics.js'
import { Logger } from './src/logger.js'
import { Config } from './src/config.js'
import { handleApi } from './src/api.js'

const config = Config.load()
const logger = new Logger(config.logBufferSize)
const metrics = new MetricsCollector()
const warp = new WarpManager(config, logger)
const proxy = createProxyServer({ config, warp, logger, metrics })

// ---- HTTP + WS server (port 3030 — control plane) --------------------------
//
// IMPORTANT: socket.io path MUST be "/" so Caddy can route by the XTransformPort query.
// But path "/" makes engine.io match EVERY request (every URL starts with "/").
// So we let socket.io auto-attach, then use io.engine.use() middleware to intercept
// /api/* and /admin/* routes BEFORE engine.io's transport validation kicks in.
// Non-intercepted requests fall through to engine.io (handshake/polling/upgrade).
//
const httpServer = createServer()

const io = new IoServer(httpServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// Intercept REST API routes before engine.io tries to parse them as transports.
io.engine.use((req: any, res: any, next: any) => {
  res.setHeader?.('Access-Control-Allow-Origin', '*')
  res.setHeader?.('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader?.('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.writeHead?.(204)
    res.end?.()
    return
  }
  const u = new URL(req.url || '/', 'http://localhost')
  if (u.pathname.startsWith('/api/') || u.pathname === '/api/health') {
    handleApi(req, res, { config, warp, proxy, metrics, logger }).catch((e) => {
      res.writeHead?.(500, { 'Content-Type': 'application/json' })
      res.end?.(JSON.stringify({ error: (e as Error).message }))
    })
    return // do NOT call next() — engine.io must not see this request
  }
  next()
})

// Pipe log + metric events to every dashboard subscriber.
logger.on('log', (line) => io.emit('log', line))
metrics.on('tick', (sample) => io.emit('metrics', sample))
warp.on('status', (status) => io.emit('warp:status', status))
proxy.on('connection:event', (evt) => io.emit('connection:event', evt))
proxy.on('traffic', (delta) => io.emit('traffic', delta))

io.on('connection', (socket: Socket) => {
  logger.info('ws', `dashboard connected (${socket.id})`)
  socket.emit('snapshot', {
    status: warp.getStatus(),
    proxy: proxy.getStats(),
    process: metrics.latest(),
    config: config.safePublic(),
    logs: logger.recent(50),
    history: metrics.history_(120),
  })
  socket.on('disconnect', () => logger.info('ws', `dashboard disconnected (${socket.id})`))
})

// ---- Boot sequence ---------------------------------------------------------
async function boot() {
  await proxy.start() // listening on 40000
  await warp.init() // detect warp-svc / warp-cli; do NOT auto-connect (let user / dashboard decide)

  httpServer.listen(config.controlPort, () => {
    logger.info('boot', `WarpProxy control plane listening on :${config.controlPort}`)
    logger.info('boot', `Proxy (SOCKS5 + HTTP CONNECT) listening on :${config.proxyPort}`)
    logger.info('boot', `Mode: ${warp.isDemo() ? 'DEMO (warp-svc not available)' : 'LIVE (warp-svc detected)'}`)
  })

  metrics.start(() => ({
    pid: process.pid,
    proxy: proxy.getStats(),
    warp: warp.getStatus(),
  }))
}

boot().catch((err) => {
  logger.error('boot', `Fatal: ${err?.stack || err}`)
  process.exit(1)
})

// ---- Graceful shutdown -----------------------------------------------------
async function shutdown(sig: string) {
  logger.info('shutdown', `received ${sig}, draining…`)
  io.close()
  await proxy.stop()
  await warp.stop()
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
