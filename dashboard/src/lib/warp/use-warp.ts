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
 * 部署模式说明：
 *
 * 1) 同源模式（生产推荐）：dashboard 与 mini-service 通过反向代理（Nginx/Caddy/Traefik）
 *    部署在同一域名下。此时 fetch('/api/...') 与 io('/') 直接命中反向代理，
 *    由反向代理按路径转发到 mini-service:3030。
 *    通过设置 NEXT_PUBLIC_WARP_API_BASE=/api 可启用此模式（默认）。
 *
 * 2) 网关查询模式（沙箱/开发）：通过 XTransformPort 查询参数指定后端端口，
 *    适用于 Caddy 网关环境。设置 NEXT_PUBLIC_WARP_CONTROL_PORT=3030 启用。
 *
 * 3) 直连模式：直接连接 mini-service 的地址。设置
 *    NEXT_PUBLIC_WARP_BASE_URL=http://127.0.0.1:3030 启用（浏览器需可访问）。
 */
const CONTROL_PORT = Number(process.env.NEXT_PUBLIC_WARP_CONTROL_PORT || 0)
const BASE_URL = process.env.NEXT_PUBLIC_WARP_BASE_URL || ''

function apiUrl(path: string): string {
  // path 形如 '/api/status'
  if (BASE_URL) return `${BASE_URL}${path}`
  if (CONTROL_PORT) return `${path}?XTransformPort=${CONTROL_PORT}`
  return path // 同源模式
}

function socketUrl(): string {
  if (BASE_URL) return BASE_URL
  if (CONTROL_PORT) return `/?XTransformPort=${CONTROL_PORT}`
  return '/' // 同源模式
}

const PROXY_PORT = Number(process.env.NEXT_PUBLIC_WARP_PROXY_PORT || 40000)

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
  // 操作
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  restart: () => Promise<void>
  register: (license: string) => Promise<void>
  trace: () => Promise<TraceResult | null>
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

  const appendLogs = useCallback((line: LogLine) => {
    logsRef.current = [...logsRef.current.slice(-199), line]
    setLogs(logsRef.current)
  }, [])
  const appendConn = useCallback((evt: ConnEvent) => {
    connsRef.current = [evt, ...connsRef.current].slice(0, 60)
    setConns(connsRef.current)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        const res = await fetch(apiUrl('/api/status'))
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

    const socket = io(socketUrl(), {
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
      setProxy((prev) => prev ? { ...prev } : prev)
    })
    socket.on('warp:status', (st: WarpStatus) => setWarp(st))
    const poll = setInterval(async () => {
      try {
        const r = await fetch(apiUrl('/api/status'))
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
    const res = await fetch(apiUrl(path), {
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
    clearLogs,
    proxyUrl: `socks5h://127.0.0.1:${PROXY_PORT}`,
    controlUrl: BASE_URL || (CONTROL_PORT ? `http://127.0.0.1:${CONTROL_PORT}` : 'http://127.0.0.1:3030'),
  }
}
