import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config } from './config.js'
import type { WarpManager } from './warp-manager.js'
import type { ProxyServer } from './proxy-server.js'
import type { MetricsCollector } from './metrics.js'
import type { Logger } from './logger.js'

interface Ctx { config: Config; warp: WarpManager; proxy: ProxyServer; metrics: MetricsCollector; logger: Logger }

/** Tiny REST router. All paths under /api/... */
export async function handleApi(req: IncomingMessage, res: ServerResponse, ctx: Ctx) {
  const url = new URL(req.url || '/', 'http://localhost')
  const path = url.pathname
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const readBody = () => new Promise<string>((resolve) => {
    let b = ''
    req.on('data', (d) => (b += d))
    req.on('end', () => resolve(b))
  })

  try {
    if (path === '/api/status' && req.method === 'GET') {
      return send(200, {
        warp: ctx.warp.getStatus(),
        proxy: ctx.proxy.getStats(),
        process: ctx.metrics.latest(),
        config: ctx.config.safePublic(),
      })
    }
    if (path === '/api/metrics/history' && req.method === 'GET') {
      const limit = Math.min(600, Number(url.searchParams.get('limit') || 300))
      return send(200, ctx.metrics.history_(limit))
    }
    if (path === '/api/logs' && req.method === 'GET') {
      const limit = Math.min(2000, Number(url.searchParams.get('limit') || 200))
      return send(200, ctx.logger.recent(limit))
    }
    if (path === '/api/warp/connect' && req.method === 'POST') {
      const r = await ctx.warp.connect()
      return send(r.ok ? 200 : 502, r)
    }
    if (path === '/api/warp/disconnect' && req.method === 'POST') {
      const r = await ctx.warp.disconnect()
      return send(r.ok ? 200 : 502, r)
    }
    if (path === '/api/warp/restart' && req.method === 'POST') {
      const r = await ctx.warp.restart()
      return send(r.ok ? 200 : 502, r)
    }
    if (path === '/api/warp/register' && req.method === 'POST') {
      const body = JSON.parse((await readBody()) || '{}')
      if (body.license) ctx.config.license = String(body.license)
      const r = await ctx.warp.connect()
      return send(r.ok ? 200 : 502, r)
    }
    if (path === '/api/trace' && req.method === 'POST') {
      const r = await ctx.warp.trace()
      return send(r.ok ? 200 : 502, r)
    }
    if (path === '/api/health' && req.method === 'GET') {
      return send(200, { ok: true, t: Date.now() })
    }
    send(404, { error: 'not found', path })
  } catch (e) {
    ctx.logger.error('api', `${path}: ${(e as Error).message}`)
    send(500, { error: (e as Error).message })
  }
}
