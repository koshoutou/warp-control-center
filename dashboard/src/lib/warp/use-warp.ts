'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { io, type Socket } from 'socket.io-client'
import type {
  WarpStatus,
  ProxyStats,
  MetricSample,
  PublicConfig,
  LogLine,
  ConnEvent,
  TraceResult,
} from './types'

/**
 * Backend mini-service port. Routed through Caddy via XTransformPort query.
 * Control plane (REST + WS) = 3030.  Proxy (SOCKS5/HTTP) = 40000.
 */
const CONTROL_PORT = 3030
const PROXY_PORT = 40000

const apiBase = (path: string) => `${path}?XTransformPort=${CONTROL_PORT}`

export interface WarpHookState {
  connected: boolean
  warp: WarpStatus | null
  proxy: ProxyStats | null
  process: MetricSample | null
  config: PublicConfig | null
  history: MetricSample[]
  logs: LogLine[]
  conns: ConnEvent[]
  loading: boolean
  error: string | null
  // actions
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  restart: () => Promise<void>
  register: (license: string) => Promise<void>
  trace: () => Promise<TraceResult | null>
  getSettings: () => Promise<any>
  getUptime: () => Promise<{ startedAt: number; uptime: number }>
  updateSettings: (s: Record<string, number>) => Promise<{ applied: Record<string, boolean>; reasons: Record<string, string> }>
  clearLogs: () => void
  proxyUrl: string
  controlUrl: string
}

export function useWarp(): WarpHookState {
  const [connected, setConnected] = useState(false)
  const [warp, setWarp] = useState<WarpStatus | null>(null)
  const [proxy, setProxy] = useState<ProxyStats | null>(null)
  const [processSample, setProcessSample] = useState<MetricSample | null>(null)
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [history, setHistory] = useState<MetricSample[]>([])
  const [logs, setLogs] = useState<LogLine[]>([])
  const [conns, setConns] = useState<ConnEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const socketRef = useRef<Socket | null>(null)
  const logsRef = useRef<LogLine[]>([])
  const connsRef = useRef<ConnEvent[]>([])

  // keep refs in sync for capped appends
  const appendLogs = useCallback((line: LogLine) => {
    logsRef.current = [...logsRef.current.slice(-199), line]
    setLogs(logsRef.current)
  }, [])
  const appendConn = useCallback((evt: ConnEvent) => {
    connsRef.current = [evt, ...connsRef.current].slice(0, 60)
    setConns(connsRef.current)
  }, [])

  // initial REST fetch + WS connect
  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        const res = await fetch(apiBase('/api/status'))
        if (!res.ok) throw new Error(`status ${res.status}`)
        const snap = await res.json()
        if (cancelled) return
        setWarp(snap.warp)
        setProxy(snap.proxy)
        setProcessSample(snap.process)
        setConfig(snap.config)
        if (snap.history) setHistory(snap.history)
        setLoading(false)
      } catch (e) {
        setError((e as Error).message)
        setLoading(false)
      }
    }
    init()

    const socket = io(`/?XTransformPort=${CONTROL_PORT}`, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    })
    socketRef.current = socket

    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))
    socket.on('snapshot', (s: any) => {
      if (cancelled) return
      setWarp(s.status)
      setProxy(s.proxy)
      setProcessSample(s.process)
      setConfig(s.config)
      if (s.logs) { logsRef.current = s.logs; setLogs(s.logs) }
      if (s.history) setHistory(s.history)
    })
    socket.on('metrics', (m: MetricSample) => {
      setProcessSample(m)
      setHistory((prev) => [...prev.slice(-299), m])
    })
    socket.on('log', (line: LogLine) => appendLogs(line))
    socket.on('connection:event', (evt: ConnEvent) => {
      appendConn(evt)
      // bump proxy connection counters from events for snappy UI
      setProxy((prev) => prev ? { ...prev } : prev)
    })
    socket.on('warp:status', (st: WarpStatus) => setWarp(st))
    // proxy stats refresh — poll /api/status every 2s for counter accuracy
    const poll = setInterval(async () => {
      try {
        const r = await fetch(apiBase('/api/status'))
        if (!r.ok) return
        const s = await r.json()
        if (cancelled) return
        setProxy(s.proxy)
        setWarp(s.warp)
      } catch {}
    }, 2000)

    return () => {
      cancelled = true
      clearInterval(poll)
      socket.disconnect()
      socketRef.current = null
    }
  }, [appendLogs, appendConn])

  const call = useCallback(async (path: string, method = 'POST', body?: unknown) => {
    const res = await fetch(apiBase(path), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok && !json.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`)
    return json
  }, [])

  const connect = useCallback(async () => { await call('/api/warp/connect') }, [call])
  const disconnect = useCallback(async () => { await call('/api/warp/disconnect') }, [call])
  const restart = useCallback(async () => { await call('/api/warp/restart') }, [call])
  const register = useCallback(async (license: string) => { await call('/api/warp/register', 'POST', { license }) }, [call])
  const trace = useCallback(async () => { return (await call('/api/trace', 'POST')) as TraceResult }, [call])
  const getSettings = useCallback(async () => {
    return (await call('/api/warp/settings', 'GET'))
  }, [call])
  const getUptime = useCallback(async () => {
    return (await call('/api/uptime', 'GET'))
  }, [call])
  const updateSettings = useCallback(async (s: Record<string, number>) => {
    const res = await call('/api/warp/settings', 'PUT', s)
    const changes = res.changes || {}
    const applied: Record<string, boolean> = {}
    const reasons: Record<string, string> = {}
    for (const [k, v] of Object.entries(changes)) {
      applied[k] = !!(v as any).applied
      if ((v as any).reason) reasons[k] = (v as any).reason
    }
    return { applied, reasons }
  }, [call])
  const clearLogs = useCallback(() => { logsRef.current = []; setLogs([]) }, [])

  return {
    connected,
    warp,
    proxy,
    process: processSample,
    config,
    history,
    logs,
    conns,
    loading,
    error,
    connect,
    disconnect,
    restart,
    register,
    trace,
    getSettings,
    getUptime,
    updateSettings,
    clearLogs,
    proxyUrl: `socks5h://127.0.0.1:${PROXY_PORT}`,
    controlUrl: `http://127.0.0.1:${CONTROL_PORT}`,
  }
}
