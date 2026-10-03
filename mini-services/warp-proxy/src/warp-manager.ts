import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lookup } from 'node:dns/promises'

export type WarpState = 'unknown' | 'disconnected' | 'connecting' | 'connected' | 'error' | 'demo'

export interface WarpStatus {
  state: WarpState
  installed: boolean
  cliInstalled: boolean
  running: boolean
  mode: string
  port: number
  version: string
  demo: boolean
  pid?: number
  lastChecked: number
  lastError?: string
}

export interface WarpManagerOpts {
  autoConnect?: boolean
}

/**
 * Manages the official `warp-svc` daemon + `warp-cli` control tool.
 *
 * Responsibilities (replaces entrypoint.sh):
 *  - detect whether warp-svc / warp-cli are installed
 *  - if running as root: optionally start warp-svc ourselves; otherwise attach to existing
 *  - register (consumer) or honor mdm.xml (Zero Trust)
 *  - set proxy mode + port (40001)
 *  - connect / disconnect / restart
 *  - poll status so the dashboard is always accurate
 *
 * When warp-svc is unavailable → DEMO mode (state='demo'), so the rest of the stack still works.
 */
export class WarpManager extends EventEmitter {
  private status: WarpStatus
  private svcProc: ChildProcessWithoutNullStreams | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private startedByUs = false

  constructor(private cfg: import('./config.js').Config, private logger: import('./logger.js').Logger) {
    super()
    this.status = {
      state: 'unknown',
      installed: false,
      cliInstalled: false,
      running: false,
      mode: 'proxy',
      port: cfg.upstreamPort,
      version: '',
      demo: false,
      lastChecked: 0,
    }
  }

  isDemo(): boolean { return this.status.demo }

  getStatus(): WarpStatus { return { ...this.status } }

  async init() {
    this.status.installed = await which(this.cfg.warpSvcPath)
    this.status.cliInstalled = await which(this.cfg.warpCliPath)
    const mdmPresent = existsSync(this.cfg.mdmFile)
    this.logger.info('warp', `detection: warp-svc=${this.status.installed} warp-cli=${this.status.cliInstalled} mdm.xml=${mdmPresent}`)

    if (this.cfg.forceDemo || (!this.status.installed && !this.status.cliInstalled)) {
      this.enterDemo()
      return
    }

    // Try to bring warp-svc up if it isn't already. We can only spawn it directly when we
    // have the binary on PATH; in containers it usually runs as PID 1 already.
    if (this.status.installed && !await this.isSvcRunning()) {
      // Attempt to spawn (may fail without root / dbus — that's fine, we degrade to demo).
      try {
        this.svcProc = spawn(this.cfg.warpSvcPath, [], { stdio: ['ignore', 'pipe', 'pipe'] })
        this.startedByUs = true
        this.status.pid = this.svcProc.pid
        this.logger.info('warp', `spawned warp-svc pid=${this.svcProc.pid}`)
        this.svcProc.stdout.on('data', (d) => this.logger.debug('warp-svc:out', d.toString().trim()))
        this.svcProc.stderr.on('data', (d) => this.logger.debug('warp-svc:err', d.toString().trim()))
        this.svcProc.on('exit', (code) => {
          this.logger.warn('warp', `warp-svc exited code=${code}`)
          this.status.running = false
          this.status.state = 'disconnected'
          this.emit('status', this.getStatus())
        })
        // give it a moment
        await sleep(1500)
      } catch (e) {
        this.logger.warn('warp', `could not spawn warp-svc: ${(e as Error).message}`)
      }
    }

    // Probe version + status via warp-cli
    await this.refresh()

    if (this.cfg.autoConnect && this.status.cliInstalled && !this.status.demo) {
      await this.connect()
    }
    this.startPolling()
  }

  private enterDemo() {
    this.status.demo = true
    this.status.state = 'demo'
    this.status.running = false
    this.status.installed = false
    this.logger.warn('warp', 'DEMO mode active — warp-svc unavailable. Proxy will run in echo/passthrough demo mode.')
    this.emit('status', this.getStatus())
  }

  private async isSvcRunning(): Promise<boolean> {
    try {
      const out = await run(this.cfg.warpCliPath, ['--accept-tos', 'status'], 4000)
      // outputs like "Status update: Connected" or "Unable to connect to WARP daemon"
      return !/unable to connect|not running/i.test(out)
    } catch {
      // If warp-cli isn't installed, try checking the process list.
      return false
    }
  }

  private async refresh() {
    if (this.status.demo) return
    this.status.lastChecked = Date.now()
    if (this.status.cliInstalled) {
      try {
        const v = await run(this.cfg.warpCliPath, ['--accept-tos', '--version'], 3000)
        this.status.version = (v || '').trim()
      } catch { /* ignore */ }
      try {
        const out = await run(this.cfg.warpCliPath, ['--accept-tos', 'status'], 4000)
        this.status.running = !/unable to connect/i.test(out)
        if (/connected/i.test(out)) this.status.state = 'connected'
        else if (/connecting/i.test(out)) this.status.state = 'connecting'
        else if (/disconnected/i.test(out)) this.status.state = 'disconnected'
        else this.status.state = this.status.running ? 'connecting' : 'disconnected'
      } catch (e) {
        this.status.lastError = (e as Error).message
        this.status.state = 'error'
      }
    } else if (this.svcProc) {
      this.status.running = !this.svcProc.killed
      this.status.state = this.status.running ? 'connecting' : 'disconnected'
    }
    this.emit('status', this.getStatus())
  }

  private startPolling() {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => { this.refresh().catch(() => {}) }, 5000)
  }

  /** Register (consumer) + set proxy mode + connect. Idempotent. */
  async connect(): Promise<{ ok: boolean; message: string }> {
    if (this.status.demo) return { ok: false, message: 'DEMO mode — warp-svc not available' }
    if (!this.status.cliInstalled) return { ok: false, message: 'warp-cli not installed' }
    try {
      // Register (ignore "Old registration is still around")
      try {
        const r = await run(this.cfg.warpCliPath, ['--accept-tos', 'registration', 'new'], 8000)
        this.logger.info('warp', `registration: ${r.trim()}`)
      } catch (e) {
        const m = (e as Error).message
        if (!/old registration/i.test(m)) throw e
        this.logger.info('warp', 'registration already exists, reusing')
      }
      // Apply license if provided
      const lic = this.cfg.license.replace(/^["']|["']$/g, '')
      if (lic) {
        try { await run(this.cfg.warpCliPath, ['--accept-tos', 'registration', 'license', lic], 8000) }
        catch (e) { this.logger.warn('warp', `license apply failed: ${(e as Error).message}`) }
      }
      await run(this.cfg.warpCliPath, ['--accept-tos', 'mode', 'proxy'], 5000).catch(() => {})
      await run(this.cfg.warpCliPath, ['--accept-tos', 'proxy', 'port', String(this.cfg.upstreamPort)], 5000).catch(() => {})
      const c = await run(this.cfg.warpCliPath, ['--accept-tos', 'connect'], 8000)
      this.logger.info('warp', `connect: ${c.trim()}`)
      await this.refresh()
      return { ok: true, message: c.trim() || 'connect issued' }
    } catch (e) {
      this.status.lastError = (e as Error).message
      this.status.state = 'error'
      this.emit('status', this.getStatus())
      this.logger.error('warp', `connect failed: ${(e as Error).message}`)
      return { ok: false, message: (e as Error).message }
    }
  }

  async disconnect(): Promise<{ ok: boolean; message: string }> {
    if (this.status.demo) return { ok: false, message: 'DEMO mode' }
    if (!this.status.cliInstalled) return { ok: false, message: 'warp-cli not installed' }
    try {
      const out = await run(this.cfg.warpCliPath, ['--accept-tos', 'disconnect'], 5000)
      await this.refresh()
      return { ok: true, message: out.trim() }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  }

  async restart(): Promise<{ ok: boolean; message: string }> {
    if (this.status.demo) return { ok: false, message: 'DEMO mode' }
    await this.disconnect()
    await sleep(500)
    return this.connect()
  }

  /** Run `curl .../cdn-cgi/trace` through the local proxy to PROVE WARP is actually on. */
  async trace(): Promise<{ ok: boolean; trace?: string; warp?: string; demo?: boolean }> {
    if (this.status.demo) {
      // In demo mode, synthesize a trace so the dashboard shows what success looks like.
      return {
        ok: true,
        demo: true,
        trace: demoTrace(),
        warp: 'on',
      }
    }
    try {
      const url = 'https://www.cloudflare.com/cdn-cgi/trace'
      // Prefer curl with socks5h resolver
      const out = await run('curl', ['-s', '--max-time', '8', '-x', `socks5h://127.0.0.1:${this.cfg.proxyPort}`, url], 10000)
      const m = out.match(/^warp=(\w+)/m)
      return { ok: true, trace: out, warp: m ? m[1] : 'unknown' }
    } catch (e) {
      return { ok: false, trace: '', warp: 'unknown' }
    }
  }

  async stop() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    if (this.startedByUs && this.svcProc) {
      try { this.svcProc.kill('SIGTERM') } catch {}
    }
  }
}

// ---- helpers ---------------------------------------------------------------
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

async function which(cmd: string): Promise<boolean> {
  // Allow absolute paths
  if (cmd.includes('/')) {
    try { await import('node:fs/promises').then((f) => f.access(cmd)); return true } catch { return false }
  }
  return new Promise((resolve) => {
    const p = spawn('sh', ['-c', `command -v ${cmd}`], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.on('exit', () => resolve(out.trim().length > 0))
    p.on('error', () => resolve(false))
  })
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch {} reject(new Error(`timeout after ${timeoutMs}ms`)) }, timeoutMs)
    p.stdout.on('data', (d) => (out += d.toString()))
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('exit', (code) => {
      clearTimeout(t)
      if (code === 0) resolve(out)
      else reject(new Error(err.trim() || `exit ${code}`))
    })
    p.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

function demoTrace(): string {
  const ip = `${1 + Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`
  return [
    `fl=${Math.random().toString(36).slice(2, 12)}r`,
    `h=www.cloudflare.com`,
    `ip=${ip}`,
    `ts=${new Date().toISOString()}`,
    `visit_scheme=https`,
    `uag=curl/8.x`,
    `colo=SJC`,
    `sliver=none`,
    `http=http/2`,
    `loc=US`,
    `tls=TLSv1.3`,
    `sni=plaintext`,
    `warp=on`,
    `gateway=off`,
    `rbi=`,
    `kex=X25519`,
  ].join('\n') + '\n'
}

// keep lookup import used (future: DNS-over-WARP verification)
void lookup
