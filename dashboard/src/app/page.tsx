'use client'

/* WARP Control Center — single-route dashboard.
 * Consumes useWarp() (REST + socket.io) and renders a polished,
 * dark, "mission control" UI. All backend traffic is relative with
 * ?XTransformPort=3030 — handled inside the hook.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Shield, Globe, Network, MemoryStick, ArrowDownUp, ArrowDown, ArrowUp,
  Power, PowerOff, RefreshCw, Terminal, Trash2, Copy, Check,
  Loader2, Activity, CircleAlert, ChevronDown, Zap, KeyRound,
  Boxes, Scale, Gauge,
} from 'lucide-react'
import {
  AreaChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ResponsiveContainer,
} from 'recharts'
import { toast, Toaster as SonnerToaster } from 'sonner'

import { useWarp } from '@/lib/warp/use-warp'
import type {
  WarpState,
  LogLine,
  LogLevel,
  ConnEvent,
  TraceResult,
} from '@/lib/warp/types'

import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Tooltip as UiTooltip, TooltipContent, TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/* ------------------------------------------------------------------ */
/*  Format helpers                                                     */
/* ------------------------------------------------------------------ */

function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s'
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatDuration(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${m}m ${s}s`
}

function fmtTime(t: number): string {
  const d = new Date(t)
  return d.toLocaleTimeString('en-US', { hour12: false })
}

function fmtClock(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour12: false })
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

async function copyToClipboard(text: string, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(label, { description: text })
  } catch {
    toast.error('Clipboard unavailable')
  }
}

/* ------------------------------------------------------------------ */
/*  State → style maps                                                 */
/* ------------------------------------------------------------------ */

interface StateMeta {
  label: string
  color: string
  dot: string
  ring: string
  glow: string
}

function warpStateMeta(state: WarpState | string | undefined): StateMeta {
  switch (state) {
    case 'connected':
      return { label: 'Connected', color: 'text-emerald-400', dot: 'bg-emerald-400', ring: 'ring-emerald-500/30', glow: 'shadow-emerald-500/10' }
    case 'connecting':
      return { label: 'Connecting', color: 'text-amber-400', dot: 'bg-amber-400', ring: 'ring-amber-500/30', glow: 'shadow-amber-500/10' }
    case 'disconnected':
      return { label: 'Disconnected', color: 'text-slate-300', dot: 'bg-slate-500', ring: 'ring-slate-500/30', glow: '' }
    case 'error':
      return { label: 'Error', color: 'text-rose-400', dot: 'bg-rose-500', ring: 'ring-rose-500/30', glow: 'shadow-rose-500/10' }
    case 'demo':
      return { label: 'Demo', color: 'text-amber-400', dot: 'bg-amber-400', ring: 'ring-amber-500/30', glow: 'shadow-amber-500/10' }
    default:
      return { label: 'Unknown', color: 'text-slate-500', dot: 'bg-slate-600', ring: 'ring-slate-500/20', glow: '' }
  }
}

function logLevelMeta(level: LogLevel): { tag: string; bg: string } {
  switch (level) {
    case 'debug': return { tag: 'text-slate-400', bg: 'bg-slate-500/10' }
    case 'info': return { tag: 'text-teal-300', bg: 'bg-teal-500/10' }
    case 'warn': return { tag: 'text-amber-300', bg: 'bg-amber-500/10' }
    case 'error': return { tag: 'text-rose-300', bg: 'bg-rose-500/10' }
    default: return { tag: 'text-slate-400', bg: 'bg-slate-500/10' }
  }
}

function connTypeMeta(type: ConnEvent['type']): { label: string; cls: string } {
  switch (type) {
    case 'open': return { label: 'OPEN', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' }
    case 'close': return { label: 'CLOSE', cls: 'border-slate-500/30 bg-slate-500/10 text-slate-300' }
    case 'error': return { label: 'ERROR', cls: 'border-rose-500/30 bg-rose-500/10 text-rose-300' }
    default: return { label: '—', cls: 'border-slate-500/30 bg-slate-500/10 text-slate-300' }
  }
}

/* ------------------------------------------------------------------ */
/*  Comparison data                                                    */
/* ------------------------------------------------------------------ */

const COMPARISON_ROWS: { label: string; original: string; node: string }[] = [
  { label: 'Image base size', original: '~150 MB (debian:bullseye-slim + cloudflare-warp pkg)', node: '~0 MB extra (host warp-svc + ~30 MB Node supervisor)' },
  { label: 'Processes per connection path', original: '2 (socat + warp-svc)', node: '1 (Node proxy → warp-svc)' },
  { label: 'TCP hops per connection', original: '2 (client → socat → warp-svc)', node: '1 (client → Node → warp-svc, zero-copy pipe)' },
  { label: 'Idle supervisor RSS', original: '~110 MB (warp-svc + socat + bash)', node: '~30 MB (Node supervisor only, heap ~4 MB)' },
  { label: 'socat dependency', original: 'required', node: 'eliminated (native SOCKS5/HTTP in Node)' },
  { label: 'Backpressure / limits', original: 'none', node: 'maxConnections + idleTimeout + ulimits' },
  { label: 'Real-time monitoring', original: 'none (docker logs only)', node: 'live WebSocket dashboard' },
]

/* ------------------------------------------------------------------ */
/*  Tiny presentational components                                     */
/* ------------------------------------------------------------------ */

function LiveDot({ on, className }: { on: boolean; className?: string }) {
  return (
    <span className={cn('relative flex size-2', className)}>
      {on && (
        <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-75', on ? 'bg-emerald-400' : 'bg-amber-400')} />
      )}
      <span className={cn('relative inline-flex size-2 rounded-full', on ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse')} />
    </span>
  )
}

function WsPill({ connected }: { connected: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-wide',
        connected
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          : 'border-amber-500/30 bg-amber-500/10 text-amber-300',
      )}
    >
      <LiveDot on={connected} />
      {connected ? 'LIVE' : 'connecting…'}
    </span>
  )
}

function ModeBadge({ demo }: { demo: boolean }) {
  if (demo) {
    return (
      <UiTooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-help items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-300">
            <CircleAlert className="size-3" /> DEMO MODE
          </span>
        </TooltipTrigger>
        <TooltipContent>warp-svc not installed on this host</TooltipContent>
      </UiTooltip>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300">
      <span className="size-1.5 rounded-full bg-emerald-400" /> LIVE
    </span>
  )
}

function Sparkline({ data, dataKey, color }: { data: { [k: string]: number | string }[]; dataKey: string; color: string }) {
  const id = `spark-${dataKey}`
  return (
    <ResponsiveContainer width="100%" height={32}>
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.5} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.5} fill={`url(#${id})`} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

/* ------------------------------------------------------------------ */
/*  Section: Header                                                    */
/* ------------------------------------------------------------------ */

function Header({ connected, demo }: { connected: boolean; demo: boolean }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <header className="sticky top-0 z-50 border-b border-white/5 bg-slate-950/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 shadow-lg shadow-orange-600/30">
            <Shield className="size-5 text-white" />
          </div>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold text-slate-50 sm:text-base">
              WARP Control Center
            </h1>
            <p className="text-[11px] text-slate-400">
              Node.js rewrite of seiry/cloudflare-warp-proxy
            </p>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2 sm:gap-3">
          <span className="hidden font-mono text-xs tabular-nums text-slate-400 sm:inline">
            {fmtClock(now)}
          </span>
          <WsPill connected={connected} />
          <ModeBadge demo={demo} />
        </div>
      </div>
    </header>
  )
}

/* ------------------------------------------------------------------ */
/*  Section: KPI row                                                   */
/* ------------------------------------------------------------------ */

interface KpiCardProps {
  title: string
  icon: React.ComponentType<{ className?: string }>
  iconClass?: string
  value: React.ReactNode
  sub?: React.ReactNode
  pulse?: boolean
  glow?: string
  children?: React.ReactNode
}

function KpiCard({ title, icon: Icon, iconClass, value, sub, pulse, glow, children }: KpiCardProps) {
  return (
    <Card
      className={cn(
        'relative overflow-hidden rounded-xl border-white/5 bg-slate-900/60 p-5 shadow-lg shadow-black/20 backdrop-blur transition-colors',
        glow,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">{title}</p>
          <div className="mt-2 flex items-end gap-2">
            <span className="truncate font-mono text-3xl font-semibold leading-none text-slate-50 tabular-nums">
              {value}
            </span>
            {pulse && <LiveDot on={pulse} className="mb-1" />}
          </div>
          {sub && <p className="mt-1.5 truncate font-mono text-xs text-slate-500">{sub}</p>}
        </div>
        <div className={cn('rounded-lg p-2 ring-1', iconClass ?? 'bg-amber-500/10 text-amber-400 ring-amber-500/20')}>
          <Icon className="size-5" />
        </div>
      </div>
      {children && <div className="mt-3">{children}</div>}
    </Card>
  )
}

function KpiRow({
  warpState, warpDemo, warpVersion, warpRunning, warpPid, warpLastError,
  connsActive, connsTotal, connsRejected,
  rssMB, heapUsed, heapTotal,
  rxRate, txRate, rxTotal, txTotal,
  history,
}: {
  warpState: WarpState | string | undefined
  warpDemo: boolean
  warpVersion: string
  warpRunning: boolean
  warpPid?: number
  warpLastError?: string
  connsActive: number
  connsTotal: number
  connsRejected: number
  rssMB: number
  heapUsed: number
  heapTotal: number
  rxRate: number
  txRate: number
  rxTotal: number
  txTotal: number
  history: { rss: number; [k: string]: number | string }[]
}) {
  const meta = warpStateMeta(warpState)
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <KpiCard
        title="WARP State"
        icon={Globe}
        iconClass={cn('ring-1', meta.ring, 'bg-amber-500/10 text-amber-400')}
        value={<span className={meta.color}>{meta.label}</span>}
        sub={
          warpDemo
            ? 'demo mode — warp-svc unavailable'
            : warpState === 'error' && warpLastError
              ? warpLastError
              : [
                  warpVersion && `v${warpVersion}`,
                  warpRunning ? 'running' : 'stopped',
                  warpPid && `pid ${warpPid}`,
                ].filter(Boolean).join(' · ') || 'idle'
        }
        glow={meta.glow}
      />
      <KpiCard
        title="Active Connections"
        icon={Network}
        iconClass="bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20"
        value={connsActive}
        sub={
          <span className="flex gap-3">
            <span>{connsTotal} total</span>
            {connsRejected > 0 && <span className="text-rose-400">{connsRejected} rejected</span>}
          </span>
        }
        pulse={connsActive > 0}
      />
      <KpiCard
        title="Memory (RSS)"
        icon={MemoryStick}
        iconClass="bg-orange-500/10 text-orange-400 ring-1 ring-orange-500/20"
        value={`${rssMB.toFixed(1)} MB`}
        sub={`heap ${heapUsed.toFixed(1)} / ${heapTotal.toFixed(1)} MB`}
      >
        {history.length > 1 && <Sparkline data={history} dataKey="rss" color="#f59e0b" />}
      </KpiCard>
      <KpiCard
        title="Throughput"
        icon={ArrowDownUp}
        iconClass="bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20"
        value={
          <span className="flex flex-col gap-0.5 text-lg leading-tight">
            <span className="flex items-center gap-1.5 text-emerald-400">
              <ArrowDown className="size-3.5" /> {formatRate(rxRate)}
            </span>
            <span className="flex items-center gap-1.5 text-rose-400">
              <ArrowUp className="size-3.5" /> {formatRate(txRate)}
            </span>
          </span>
        }
        sub={
          <span className="flex gap-3">
            <span>↓ {formatBytes(rxTotal)}</span>
            <span>↑ {formatBytes(txTotal)}</span>
          </span>
        }
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Section: Charts row                                                */
/* ------------------------------------------------------------------ */

const tooltipStyle = {
  backgroundColor: '#0f172a',
  border: '1px solid #1e293b',
  borderRadius: '8px',
  fontSize: '12px',
  color: '#e2e8f0',
  boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
} as const

function ChartsRow({ chartData }: { chartData: { time: string; rss: number; cpu: number; rx: number; tx: number }[] }) {
  const empty = chartData.length === 0
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card className="rounded-xl border-white/5 bg-slate-900/60 p-5 shadow-lg shadow-black/20 lg:col-span-2">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-slate-100">Resource Usage</h2>
            <span className="text-xs text-slate-500">last 5 min</span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-slate-400">
            <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-amber-500" /> RSS (MB)</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-orange-400" /> CPU (%)</span>
          </div>
        </div>
        <div className="h-[240px] w-full">
          {empty ? (
            <div className="grid h-full place-items-center text-xs text-slate-500">
              <span className="flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" /> waiting for telemetry…
              </span>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 8, bottom: 0, left: -8 }}>
                <defs>
                  <linearGradient id="rssArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="time" stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} minTickGap={48} />
                <YAxis yAxisId="rss" stroke="#f59e0b" fontSize={10} tickLine={false} axisLine={false} width={38} />
                <YAxis yAxisId="cpu" orientation="right" stroke="#fb923c" fontSize={10} tickLine={false} axisLine={false} width={32} unit="%" />
                <RTooltip contentStyle={tooltipStyle} labelStyle={{ color: '#94a3b8', fontSize: 11 }} itemStyle={{ color: '#e2e8f0' }} />
                <Area yAxisId="rss" type="monotone" dataKey="rss" name="RSS (MB)" stroke="#f59e0b" strokeWidth={2} fill="url(#rssArea)" isAnimationActive={false} />
                <Line yAxisId="cpu" type="monotone" dataKey="cpu" name="CPU (%)" stroke="#fb923c" strokeWidth={2} dot={false} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      <Card className="rounded-xl border-white/5 bg-slate-900/60 p-5 shadow-lg shadow-black/20">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ArrowDownUp className="size-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-slate-100">Throughput</h2>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-slate-400">
            <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-amber-500" /> ↓ RX</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-rose-500" /> ↑ TX</span>
          </div>
        </div>
        <div className="h-[240px] w-full">
          {empty ? (
            <div className="grid h-full place-items-center text-xs text-slate-500">
              <span className="flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" /> waiting for telemetry…
              </span>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 8, bottom: 0, left: -8 }}>
                <defs>
                  <linearGradient id="rxArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="txArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#f43f5e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="time" stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} minTickGap={48} />
                <YAxis stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => formatRate(Number(v))} />
                <RTooltip
                  contentStyle={tooltipStyle}
                  labelStyle={{ color: '#94a3b8', fontSize: 11 }}
                  itemStyle={{ color: '#e2e8f0' }}
                  formatter={(value: number | string, name: string) => [formatRate(Number(value)), name]}
                />
                <Area type="monotone" dataKey="rx" name="↓ RX" stroke="#f59e0b" strokeWidth={2} fill="url(#rxArea)" isAnimationActive={false} />
                <Area type="monotone" dataKey="tx" name="↑ TX" stroke="#f43f5e" strokeWidth={2} fill="url(#txArea)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Section: WARP control panel + config                               */
/* ------------------------------------------------------------------ */

type BusyKind = 'connect' | 'disconnect' | 'restart' | 'trace' | 'register' | null

function WarpControlPanel({
  connect, disconnect, restart, register, trace, warpDemo,
}: {
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  restart: () => Promise<void>
  register: (license: string) => Promise<void>
  trace: () => Promise<TraceResult | null>
  warpDemo: boolean
}) {
  const [busy, setBusy] = useState<BusyKind>(null)
  const [traceOpen, setTraceOpen] = useState(false)
  const [traceResult, setTraceResult] = useState<TraceResult | null>(null)
  const [license, setLicense] = useState('')

  const run = useCallback(async (kind: BusyKind, label: string, fn: () => Promise<void>) => {
    if (!kind) return
    setBusy(kind)
    const t = toast.loading(`${label}…`)
    try {
      await fn()
      toast.success(`${label} dispatched`, { id: t })
    } catch (e) {
      toast.error(`${label} failed: ${(e as Error).message}`, { id: t })
    } finally {
      setBusy(null)
    }
  }, [])

  const handleTrace = useCallback(async () => {
    setBusy('trace')
    const t = toast.loading('Running trace…')
    try {
      const r = await trace()
      setTraceResult(r)
      setTraceOpen(true)
      if (r?.ok) toast.success('Trace complete', { id: t })
      else toast.warning('Trace returned — check output', { id: t })
    } catch (e) {
      toast.error(`Trace failed: ${(e as Error).message}`, { id: t })
    } finally {
      setBusy(null)
    }
  }, [trace])

  const handleRegister = useCallback(async () => {
    if (!license.trim()) {
      toast.error('Enter a license key first')
      return
    }
    setBusy('register')
    const t = toast.loading('Registering with license…')
    try {
      await register(license.trim())
      toast.success('Registration dispatched', { id: t })
      setLicense('')
    } catch (e) {
      toast.error(`Register failed: ${(e as Error).message}`, { id: t })
    } finally {
      setBusy(null)
    }
  }, [license, register])

  return (
    <Card className="flex h-full flex-col gap-4 rounded-xl border-white/5 bg-slate-900/60 p-5 shadow-lg shadow-black/20">
      <div className="flex items-center gap-2">
        <Power className="size-4 text-amber-400" />
        <h2 className="text-sm font-semibold text-slate-100">WARP Control</h2>
        {warpDemo && (
          <Badge variant="outline" className="ml-auto border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300">
            demo
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Button
          onClick={() => run('connect', 'Connect', connect)}
          disabled={busy !== null}
          className="bg-emerald-600 text-white hover:bg-emerald-500"
        >
          {busy === 'connect' ? <Loader2 className="size-4 animate-spin" /> : <Power className="size-4" />}
          Connect
        </Button>
        <Button
          onClick={() => run('disconnect', 'Disconnect', disconnect)}
          disabled={busy !== null}
          variant="secondary"
          className="bg-slate-700 text-slate-100 hover:bg-slate-600"
        >
          {busy === 'disconnect' ? <Loader2 className="size-4 animate-spin" /> : <PowerOff className="size-4" />}
          Disconnect
        </Button>
        <Button
          onClick={() => run('restart', 'Restart', restart)}
          disabled={busy !== null}
          variant="outline"
          className="border-amber-500/40 bg-amber-500/5 text-amber-300 hover:bg-amber-500/10"
        >
          {busy === 'restart' ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          Restart
        </Button>
        <Button
          onClick={handleTrace}
          disabled={busy !== null}
          variant="outline"
          className="border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"
        >
          {busy === 'trace' ? <Loader2 className="size-4 animate-spin" /> : <Terminal className="size-4" />}
          Test trace
        </Button>
      </div>

      <Separator className="bg-white/5" />

      <div className="space-y-2">
        <Label htmlFor="license" className="text-xs text-slate-400">
          <KeyRound className="mr-1 inline size-3.5" /> License key (optional)
        </Label>
        <div className="flex gap-2">
          <Input
            id="license"
            type="password"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            value={license}
            onChange={(e) => setLicense(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRegister() }}
            className="border-white/10 bg-slate-950/60 font-mono text-xs text-slate-200 placeholder:text-slate-600"
          />
          <Button
            onClick={handleRegister}
            disabled={busy !== null || !license.trim()}
            variant="outline"
            className="border-amber-500/40 bg-amber-500/5 text-amber-300 hover:bg-amber-500/10"
          >
            {busy === 'register' ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
            Register
          </Button>
        </div>
      </div>

      <Collapsible open={traceOpen} onOpenChange={setTraceOpen} className="mt-auto">
        <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-white/5 bg-slate-950/40 px-3 py-2 text-xs text-slate-300 hover:bg-slate-950/60">
          <span className="flex items-center gap-2">
            <Terminal className="size-3.5 text-amber-400" /> Trace output
          </span>
          <ChevronDown className={cn('size-3.5 transition-transform', traceOpen && 'rotate-180')} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-white/5 bg-slate-950/80 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
            {traceResult?.trace ?? traceResult?.warp ?? (traceResult ? '(empty trace)' : 'Run "Test trace" to see the Cloudflare trace output.')}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}

type ConfigRowKind = 'port' | 'text' | 'mono' | 'muted' | 'bool'

interface ConfigRow {
  key: string
  label: string
  kind: ConfigRowKind
  value: string | number | boolean
}

function ConfigPanel({
  config, proxyUrl, warp,
}: {
  config: {
    proxyPort: number
    controlPort: number
    upstreamHost: string
    upstreamPort: number
    demoMode: boolean
    warpSvcPath: string
    warpCliPath: string
    licenseConfigured: boolean
    mode: string
  } | null
  proxyUrl: string
  warp: {
    installed: boolean
    cliInstalled: boolean
    mode: string
    port: number
    pid?: number
    lastChecked: number
  } | null
}) {
  const rows: ConfigRow[] = config
    ? [
        { key: 'proxyPort', label: 'Proxy listen port', kind: 'port', value: config.proxyPort },
        { key: 'controlPort', label: 'Control port', kind: 'port', value: config.controlPort },
        { key: 'upstream', label: 'Upstream', kind: 'mono', value: `${config.upstreamHost}:${config.upstreamPort}` },
        { key: 'warpSvc', label: 'warp-svc path', kind: 'muted', value: config.warpSvcPath || '—' },
        { key: 'warpCli', label: 'warp-cli path', kind: 'muted', value: config.warpCliPath || '—' },
        { key: 'mode', label: 'Mode', kind: 'text', value: config.mode },
        { key: 'license', label: 'License configured', kind: 'bool', value: config.licenseConfigured },
        ...(warp
          ? ([
              { key: 'warpSvcInstalled', label: 'warp-svc installed', kind: 'bool' as ConfigRowKind, value: warp.installed },
              { key: 'warpCliInstalled', label: 'warp-cli installed', kind: 'bool' as ConfigRowKind, value: warp.cliInstalled },
              { key: 'warpMode', label: 'WARP mode', kind: 'text' as ConfigRowKind, value: warp.mode || '—' },
              { key: 'warpPort', label: 'WARP proxy port', kind: 'port' as ConfigRowKind, value: warp.port },
              ...(warp.pid
                ? [{ key: 'warpPid', label: 'warp-svc pid', kind: 'muted' as ConfigRowKind, value: warp.pid }]
                : []),
              { key: 'lastChecked', label: 'Last checked', kind: 'muted' as ConfigRowKind, value: fmtTime(warp.lastChecked) },
            ] as ConfigRow[])
          : []),
      ]
    : []

  const renderValue = (row: ConfigRow) => {
    switch (row.kind) {
      case 'port': return <span className="text-amber-300">:{String(row.value)}</span>
      case 'mono': return <span className="text-slate-200">{String(row.value)}</span>
      case 'muted': return <span className="text-slate-400">{String(row.value)}</span>
      case 'text': return <span className="text-slate-200">{String(row.value)}</span>
      case 'bool': return row.value
        ? <span className="text-emerald-300">yes</span>
        : <span className="text-slate-500">no</span>
      default: return <span className="text-slate-400">{String(row.value)}</span>
    }
  }

  return (
    <Card className="flex h-full flex-col gap-4 rounded-xl border-white/5 bg-slate-900/60 p-5 shadow-lg shadow-black/20">
      <div className="flex items-center gap-2">
        <Gauge className="size-4 text-amber-400" />
        <h2 className="text-sm font-semibold text-slate-100">Configuration</h2>
      </div>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 font-mono text-xs sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-3 border-b border-white/5 pb-1.5">
            <dt className="text-slate-500">{row.label}</dt>
            <dd className="text-right">{renderValue(row)}</dd>
          </div>
        ))}
      </dl>

      <Separator className="bg-white/5" />

      <div className="mt-auto space-y-2">
        <Label className="text-xs text-slate-400">Proxy URL</Label>
        <div className="flex items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
          <code className="flex-1 truncate font-mono text-xs text-amber-200">{proxyUrl}</code>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            onClick={() => copyToClipboard(proxyUrl, 'Proxy URL copied')}
            aria-label="Copy proxy URL"
          >
            <Copy className="size-3.5" />
          </Button>
        </div>
        <p className="text-[11px] text-slate-500">
          Point any SOCKS5- or HTTP-CONNECT-aware client at this URL.
        </p>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Section: Connections table                                         */
/* ------------------------------------------------------------------ */

function ConnectionsTable({ conns }: { conns: ConnEvent[] }) {
  const rows = conns.slice(0, 15)
  return (
    <Card className="rounded-xl border-white/5 bg-slate-900/60 p-5 shadow-lg shadow-black/20">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Network className="size-4 text-amber-400" />
          <h2 className="text-sm font-semibold text-slate-100">Recent Connections</h2>
          <span className="text-xs text-slate-500">{conns.length} event{conns.length === 1 ? '' : 's'}</span>
        </div>
      </div>
      <div className="max-h-80 overflow-y-auto rounded-md border border-white/5 [scrollbar-width:thin] [scrollbar-color:#334155_transparent]">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur">
            <TableRow className="border-white/5 hover:bg-transparent">
              <TableHead className="h-9 pl-3 text-[11px] uppercase tracking-wider text-slate-500">ID</TableHead>
              <TableHead className="h-9 text-[11px] uppercase tracking-wider text-slate-500">Type</TableHead>
              <TableHead className="h-9 text-[11px] uppercase tracking-wider text-slate-500">Target</TableHead>
              <TableHead className="h-9 text-right text-[11px] uppercase tracking-wider text-slate-500">↓ RX</TableHead>
              <TableHead className="h-9 text-right text-[11px] uppercase tracking-wider text-slate-500">↑ TX</TableHead>
              <TableHead className="h-9 text-right text-[11px] uppercase tracking-wider text-slate-500">Duration</TableHead>
              <TableHead className="h-9 pr-3 text-[11px] uppercase tracking-wider text-slate-500">Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow className="border-transparent hover:bg-transparent">
                <TableCell colSpan={7} className="h-28 text-center text-xs text-slate-500">
                  No connections yet — point a client at the proxy URL.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((c, i) => {
                const m = connTypeMeta(c.type)
                const target = c.host ? `${c.host}${c.port ? ':' + c.port : ''}` : '—'
                return (
                  <TableRow key={`${c.id}-${i}`} className="border-white/5">
                    <TableCell className="pl-3 font-mono text-xs text-slate-400">#{c.id}</TableCell>
                    <TableCell>
                      <span className={cn('inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium', m.cls)}>{m.label}</span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-slate-300">{target}</TableCell>
                    <TableCell className="text-right font-mono text-xs text-emerald-300/80">{c.rx ? formatBytes(c.rx) : '—'}</TableCell>
                    <TableCell className="text-right font-mono text-xs text-rose-300/80">{c.tx ? formatBytes(c.tx) : '—'}</TableCell>
                    <TableCell className="text-right font-mono text-xs text-slate-400">{formatDuration(c.durationMs)}</TableCell>
                    <TableCell className="pr-3 font-mono text-xs text-slate-500">{c.reason ?? '—'}</TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Section: Log stream                                                */
/* ------------------------------------------------------------------ */

function LogStream({ logs, onClear }: { logs: LogLine[]; onClear: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  // Keep pinned to bottom when new logs arrive (unless user scrolled up).
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [logs.length])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    stickRef.current = atBottom
  }, [])

  return (
    <Card className="rounded-xl border-white/5 bg-slate-900/60 p-5 shadow-lg shadow-black/20">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Terminal className="size-4 text-amber-400" />
          <h2 className="text-sm font-semibold text-slate-100">Log Stream</h2>
          <span className="text-xs text-slate-500">{logs.length} line{logs.length === 1 ? '' : 's'}</span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClear}
          className="h-7 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200"
        >
          <Trash2 className="size-3.5" /> Clear
        </Button>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="max-h-96 overflow-y-auto rounded-md border border-white/5 bg-slate-950/80 p-3 font-mono text-xs leading-relaxed [scrollbar-width:thin] [scrollbar-color:#334155_transparent]"
      >
        {logs.length === 0 ? (
          <div className="grid h-24 place-items-center text-xs text-slate-600">
            No logs yet.
          </div>
        ) : (
          logs.map((l, i) => {
            const m = logLevelMeta(l.level)
            return (
              <div key={i} className="flex items-start gap-2 py-0.5">
                <span className="shrink-0 text-slate-600">{fmtTime(l.t)}</span>
                <span className={cn('shrink-0 rounded px-1 text-[10px] font-semibold uppercase', m.bg, m.tag)}>
                  {l.level}
                </span>
                <span className="shrink-0 text-slate-500">[{l.cat}]</span>
                <span className="break-all text-slate-300">{l.msg}</span>
              </div>
            )
          })
        )}
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Section: Comparison                                                 */
/* ------------------------------------------------------------------ */

function ComparisonSection() {
  return (
    <Card className="rounded-xl border-amber-500/15 bg-gradient-to-br from-slate-900/80 to-slate-900/40 p-5 shadow-lg shadow-black/20 ring-1 ring-amber-500/10">
      <div className="mb-1 flex items-center gap-2">
        <Scale className="size-4 text-amber-400" />
        <h2 className="text-sm font-semibold text-slate-100">Original Docker image vs Node.js rewrite</h2>
      </div>
      <p className="mb-4 text-xs text-slate-500">
        measured on the original Debian+socat image vs this Node supervisor
      </p>

      <div className="grid grid-cols-1 gap-3">
        {COMPARISON_ROWS.map((row) => (
          <div key={row.label} className="rounded-lg border border-white/5 bg-slate-950/40 p-3.5">
            <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              {row.label}
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div className="rounded-md border border-rose-500/20 bg-rose-500/5 p-2.5">
                <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-rose-300/80">
                  <Boxes className="size-3" /> Original
                </div>
                <div className="font-mono text-xs leading-relaxed text-slate-400">{row.original}</div>
              </div>
              <div className="rounded-md border border-emerald-500/25 bg-emerald-500/5 p-2.5">
                <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300/90">
                  <Check className="size-3" /> Node rewrite
                </div>
                <div className="font-mono text-xs leading-relaxed text-slate-100">{row.node}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-4 border-t border-white/5 pt-3 text-[11px] leading-relaxed text-slate-500">
        The official <code className="text-slate-400">warp-svc</code> Rust daemon is still required to speak the
        MASQUE protocol — this rewrite eliminates the wasteful socat double-hop and bash overhead,
        and adds supervision + observability.
      </p>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Section: Footer                                                     */
/* ------------------------------------------------------------------ */

function DashboardFooter({
  proxyUrl, connected, controlPort, proxyPort, proxyListening,
}: {
  proxyUrl: string
  connected: boolean
  controlPort: number
  proxyPort: number
  proxyListening: boolean
}) {
  return (
    <footer className="mt-auto border-t border-white/5 bg-slate-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-3 px-4 py-4 text-xs text-slate-500 sm:flex-row sm:justify-between sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-slate-400">WARP Control Center · Node.js rewrite</span>
          <span className="hidden text-slate-700 sm:inline">·</span>
          <a
            href="https://github.com/seiry/cloudflare-warp-proxy"
            target="_blank"
            rel="noreferrer"
            className="text-amber-400/80 underline-offset-2 hover:text-amber-300 hover:underline"
          >
            seiry/cloudflare-warp-proxy
          </a>
        </div>
        <div className="font-mono text-slate-400">{proxyUrl}</div>
        <div className="flex items-center gap-3 font-mono text-[11px]">
          <span className="inline-flex items-center gap-1.5">
            <span className={cn('size-1.5 rounded-full', connected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600')} />
            control :{controlPort}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className={cn('size-1.5 rounded-full', proxyListening ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600')} />
            proxy :{proxyPort}
          </span>
        </div>
      </div>
    </footer>
  )
}

/* ------------------------------------------------------------------ */
/*  Loading skeleton                                                    */
/* ------------------------------------------------------------------ */

function LoadingSkeleton() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-white/5 bg-slate-900/60 p-5">
            <Skeleton className="h-3 w-24 bg-slate-800" />
            <Skeleton className="mt-3 h-8 w-20 bg-slate-800" />
            <Skeleton className="mt-2 h-3 w-28 bg-slate-800" />
          </div>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-white/5 bg-slate-900/60 p-5 lg:col-span-2">
          <Skeleton className="h-4 w-40 bg-slate-800" />
          <Skeleton className="mt-4 h-[240px] w-full bg-slate-800/60" />
        </div>
        <div className="rounded-xl border border-white/5 bg-slate-900/60 p-5">
          <Skeleton className="h-4 w-32 bg-slate-800" />
          <Skeleton className="mt-4 h-[240px] w-full bg-slate-800/60" />
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 w-full rounded-xl bg-slate-900/60" />
        <Skeleton className="h-64 w-full rounded-xl bg-slate-900/60" />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Page                                                                */
/* ------------------------------------------------------------------ */

export default function Home() {
  const warp = useWarp()
  const {
    connected, warp: warpStatus, proxy, process: proc, config, history,
    logs, conns, loading, error,
    connect, disconnect, restart, register, trace, clearLogs, proxyUrl,
  } = warp

  const chartData = useMemo(
    () =>
      history.map((h) => ({
        time: fmtTime(h.t),
        rss: Number(h.rssMB.toFixed(2)),
        cpu: Number(h.cpuPct.toFixed(2)),
        rx: h.rxBytesPerSec,
        tx: h.txBytesPerSec,
      })),
    [history],
  )

  const sparkData = useMemo(
    () => chartData.slice(-60).map((d) => ({ rss: d.rss })),
    [chartData],
  )

  return (
    <div className="dark flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <Header connected={connected} demo={warpStatus?.demo ?? false} />

      {error && (
        <div className="mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6">
          <Alert variant="destructive" className="border-rose-500/30 bg-rose-500/10 text-rose-200">
            <CircleAlert className="size-4 text-rose-400" />
            <AlertTitle className="text-rose-200">Cannot reach WARP control plane on :3030</AlertTitle>
            <AlertDescription className="text-rose-300/80">
              Is the mini-service running? — {error}
            </AlertDescription>
          </Alert>
        </div>
      )}

      {loading ? (
        <LoadingSkeleton />
      ) : (
        <main className="mx-auto w-full max-w-7xl flex-1 animate-in fade-in duration-500 px-4 py-6 sm:px-6">
          <div className="flex flex-col gap-4">
            <KpiRow
              warpState={warpStatus?.state}
              warpDemo={warpStatus?.demo ?? false}
              warpVersion={warpStatus?.version ?? ''}
              warpRunning={warpStatus?.running ?? false}
              warpPid={warpStatus?.pid}
              warpLastError={warpStatus?.lastError}
              connsActive={proxy?.connections ?? 0}
              connsTotal={proxy?.totalConnections ?? 0}
              connsRejected={proxy?.rejected ?? 0}
              rssMB={proc?.rssMB ?? 0}
              heapUsed={proc?.heapUsedMB ?? 0}
              heapTotal={proc?.heapTotalMB ?? 0}
              rxRate={proc?.rxBytesPerSec ?? 0}
              txRate={proc?.txBytesPerSec ?? 0}
              rxTotal={proxy?.totalRx ?? 0}
              txTotal={proxy?.totalTx ?? 0}
              history={sparkData}
            />

            <ChartsRow chartData={chartData} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <WarpControlPanel
                connect={connect}
                disconnect={disconnect}
                restart={restart}
                register={register}
                trace={trace}
                warpDemo={warpStatus?.demo ?? false}
              />
              <ConfigPanel config={config} proxyUrl={proxyUrl} warp={warpStatus} />
            </div>

            <ConnectionsTable conns={conns} />

            <LogStream logs={logs} onClear={clearLogs} />

            <ComparisonSection />
          </div>
        </main>
      )}

      <DashboardFooter
        proxyUrl={proxyUrl}
        connected={connected}
        controlPort={config?.controlPort ?? 3030}
        proxyPort={config?.proxyPort ?? 40000}
        proxyListening={proxy?.listening ?? false}
      />

      <SonnerToaster theme="dark" position="bottom-right" richColors closeButton />
    </div>
  )
}
