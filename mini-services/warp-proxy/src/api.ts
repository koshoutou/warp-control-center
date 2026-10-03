import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config } from './config.js'
import type { WarpManager } from './warp-manager.js'
import type { ProxyServer } from './proxy-server.js'
import type { MetricsCollector } from './metrics.js'
import type { Logger } from './logger.js'

interface Ctx { config: Config; warp: WarpManager; proxy: ProxyServer; metrics: MetricsCollector; logger: Logger; startedAt: number }

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
    if (path === '/api/warp/settings' && req.method === 'GET') {
      return send(200, {
        maxConnections: ctx.config.maxConnections,
        idleTimeoutMs: ctx.config.idleTimeoutMs,
        metricsIntervalMs: ctx.config.metricsIntervalMs,
        logBufferSize: ctx.config.logBufferSize,
        autoConnect: ctx.config.autoConnect,
        licenseConfigured: !!ctx.config.license,
      })
    }
    if (path === '/api/warp/settings' && req.method === 'PUT') {
      const body = JSON.parse((await readBody()) || '{}')
      const changes: Record<string, { from: unknown; to: unknown; applied: boolean; reason?: string }> = {}
      // 可运行时修改的配置项
      if (body.maxConnections != null) {
        const v = Number(body.maxConnections)
        if (Number.isFinite(v) && v >= 1 && v <= 100000) {
          changes.maxConnections = { from: ctx.config.maxConnections, to: v, applied: true }
          ctx.config.maxConnections = v
        } else {
          changes.maxConnections = { from: ctx.config.maxConnections, to: body.maxConnections, applied: false, reason: '需为 1-100000 的数字' }
        }
      }
      if (body.idleTimeoutMs != null) {
        const v = Number(body.idleTimeoutMs)
        if (Number.isFinite(v) && v >= 5000 && v <= 3600000) {
          changes.idleTimeoutMs = { from: ctx.config.idleTimeoutMs, to: v, applied: true }
          ctx.config.idleTimeoutMs = v
        } else {
          changes.idleTimeoutMs = { from: ctx.config.idleTimeoutMs, to: body.idleTimeoutMs, applied: false, reason: '需为 5000-3600000 的毫秒数' }
        }
      }
      if (body.metricsIntervalMs != null) {
        const v = Number(body.metricsIntervalMs)
        if (Number.isFinite(v) && v >= 500 && v <= 60000) {
          changes.metricsIntervalMs = { from: ctx.config.metricsIntervalMs, to: v, applied: true }
          ctx.config.metricsIntervalMs = v
          ctx.metrics.setInterval?.(v)
        } else {
          changes.metricsIntervalMs = { from: ctx.config.metricsIntervalMs, to: body.metricsIntervalMs, applied: false, reason: '需为 500-60000 的毫秒数' }
        }
      }
      if (body.logBufferSize != null) {
        const v = Number(body.logBufferSize)
        if (Number.isFinite(v) && v >= 50 && v <= 10000) {
          changes.logBufferSize = { from: ctx.config.logBufferSize, to: v, applied: true }
          ctx.config.logBufferSize = v
          ctx.logger.setMax?.(v)
        } else {
          changes.logBufferSize = { from: ctx.config.logBufferSize, to: body.logBufferSize, applied: false, reason: '需为 50-10000 的数字' }
        }
      }
      ctx.logger.info('api', `settings PUT: ${JSON.stringify(changes)}`)
      // 持久化到文件（仅当至少一项 applied 时）
      const anyApplied = Object.values(changes).some((c) => (c as any).applied)
      if (anyApplied) {
        ctx.config.persist?.()
        ctx.logger.info('api', 'settings 已持久化到文件')
      }
      return send(200, { ok: true, changes })
    }
    if (path === '/api/uptime' && req.method === 'GET') {
      return send(200, { startedAt: ctx.startedAt, uptime: Math.floor((Date.now() - ctx.startedAt) / 1000) })
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
