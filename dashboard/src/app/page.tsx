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
  Boxes, Scale, Gauge, Download, Search, SlidersHorizontal, ArrowUpDown,
  Clock, Command,
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
/*  Section: Runtime settings types                                     */
/* ------------------------------------------------------------------ */

interface RuntimeSettingsData {
  maxConnections: number
  idleTimeoutMs: number
  metricsIntervalMs: number
  logBufferSize: number
}

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
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

function fmtClock(d: Date): string {
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

async function copyToClipboard(text: string, label = '已复制') {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(label, { description: text })
  } catch {
    toast.error('剪贴板不可用')
  }
}

function downloadCSV(filename: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return
  const headers = Object.keys(rows[0])
  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => {
      const v = r[h]
      if (v == null) return ''
      const s = String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }).join(',')),
  ].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
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
      return { label: '已连接', color: 'text-emerald-400', dot: 'bg-emerald-400', ring: 'ring-emerald-500/30', glow: 'shadow-emerald-500/10' }
    case 'connecting':
      return { label: '连接中', color: 'text-amber-400', dot: 'bg-amber-400', ring: 'ring-amber-500/30', glow: 'shadow-amber-500/10' }
    case 'disconnected':
      return { label: '已断开', color: 'text-slate-300', dot: 'bg-slate-500', ring: 'ring-slate-500/30', glow: '' }
    case 'error':
      return { label: '错误', color: 'text-rose-400', dot: 'bg-rose-500', ring: 'ring-rose-500/30', glow: 'shadow-rose-500/10' }
    case 'demo':
      return { label: '演示', color: 'text-amber-400', dot: 'bg-amber-400', ring: 'ring-amber-500/30', glow: 'shadow-amber-500/10' }
    default:
      return { label: '未知', color: 'text-slate-500', dot: 'bg-slate-600', ring: 'ring-slate-500/20', glow: '' }
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
    case 'open': return { label: '开启', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' }
    case 'close': return { label: '关闭', cls: 'border-slate-500/30 bg-slate-500/10 text-slate-300' }
    case 'error': return { label: '错误', cls: 'border-rose-500/30 bg-rose-500/10 text-rose-300' }
    default: return { label: '—', cls: 'border-slate-500/30 bg-slate-500/10 text-slate-300' }
  }
}

/* ------------------------------------------------------------------ */
/*  Comparison data                                                    */
/* ------------------------------------------------------------------ */

const COMPARISON_ROWS: { label: string; original: string; node: string }[] = [
  { label: '镜像基础大小', original: '~150 MB (debian:bullseye-slim + cloudflare-warp pkg)', node: '~0 MB extra (host warp-svc + ~30 MB Node supervisor)' },
  { label: '每条连接路径的进程数', original: '2 (socat + warp-svc)', node: '1 (Node proxy → warp-svc)' },
  { label: '每条连接的 TCP 跳数', original: '2 (client → socat → warp-svc)', node: '1 (client → Node → warp-svc, zero-copy pipe)' },
  { label: '空闲守护进程 RSS', original: '~110 MB (warp-svc + socat + bash)', node: '~30 MB (Node supervisor only, heap ~4 MB)' },
  { label: 'socat 依赖', original: '需要', node: '已消除（Node 原生 SOCKS5/HTTP）' },
  { label: '背压 / 限制', original: '无', node: '最大连接数 + 空闲超时 + ulimit' },
  { label: '实时监控', original: '无（仅 docker logs）', node: '实时 WebSocket 面板' },
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
      {connected ? '实时' : '连接中…'}
    </span>
  )
}

function ModeBadge({ demo }: { demo: boolean }) {
  if (demo) {
    return (
      <UiTooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-help items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-300">
            <CircleAlert className="size-3" /> 演示模式
          </span>
        </TooltipTrigger>
        <TooltipContent>此主机上 warp-svc 不可用</TooltipContent>
      </UiTooltip>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300">
      <span className="size-1.5 rounded-full bg-emerald-400" /> 实时
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

function Header({ connected, demo, lastMetric }: { connected: boolean; demo: boolean; lastMetric: number | null }) {
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
              WARP 控制中心
            </h1>
            <p className="text-[11px] text-slate-400">
              seiry/cloudflare-warp-proxy 的 Node.js 重写版
            </p>
            <p className="hidden text-[10px] text-slate-600 lg:block">
              快捷键: ⌘K 命令 · C 连接 · D 断开 · R 重启
            </p>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2 sm:gap-3">
          <span className="hidden font-mono text-xs tabular-nums text-slate-400 sm:inline">
            {fmtClock(now)}
          </span>
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-1 text-[10px] font-medium text-sky-300"
            title="每秒接收指标数据"
          >
            <Activity className="size-3" />
            <span className="hidden sm:inline">数据流</span>
            <span
              key={lastMetric ?? 0}
              className="size-1.5 rounded-full bg-sky-400 data-pulse"
            />
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
  const valueRef = useRef<HTMLSpanElement>(null)
  const prevValue = useRef<React.ReactNode>(value)
  useEffect(() => {
    if (prevValue.current !== value && valueRef.current) {
      valueRef.current.classList.remove('kpi-flash')
      // force reflow to restart animation
      void valueRef.current.offsetWidth
      valueRef.current.classList.add('kpi-flash')
      prevValue.current = value
    }
  }, [value])
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
            <span ref={valueRef} className="truncate font-mono text-3xl font-semibold leading-none text-slate-50 tabular-nums">
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
  rssMB, heapUsed, heapTotal, cpuPct,
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
  cpuPct: number
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
        title="WARP 状态"
        icon={Globe}
        iconClass={cn('ring-1', meta.ring, 'bg-amber-500/10 text-amber-400')}
        value={<span className={meta.color}>{meta.label}</span>}
        sub={
          warpDemo
            ? '演示模式 — warp-svc 不可用'
            : warpState === 'error' && warpLastError
              ? warpLastError
              : [
                  warpVersion && `v${warpVersion}`,
                  warpRunning ? '运行中' : '已停止',
                  warpPid && `pid ${warpPid}`,
                ].filter(Boolean).join(' · ') || '空闲'
        }
        glow={meta.glow}
      />
      <KpiCard
        title="活动连接"
        icon={Network}
        iconClass="bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20"
        value={connsActive}
        sub={
          <span className="flex gap-3">
            <span>{connsTotal} 总计</span>
            {connsRejected > 0 && <span className="text-rose-400">{connsRejected} 已拒绝</span>}
          </span>
        }
        pulse={connsActive > 0}
      />
      <KpiCard
        title="内存 (RSS)"
        icon={MemoryStick}
        iconClass="bg-orange-500/10 text-orange-400 ring-1 ring-orange-500/20"
        value={`${rssMB.toFixed(1)} MB`}
        sub={
          <span className="flex gap-3">
            <span>堆 {heapUsed.toFixed(1)} / {heapTotal.toFixed(1)} MB</span>
            <span className={cn(cpuPct > 80 ? 'text-rose-400' : cpuPct > 50 ? 'text-amber-400' : 'text-slate-400')}>
              CPU {cpuPct.toFixed(1)}%
            </span>
          </span>
        }
      >
        {history.length > 1 && <Sparkline data={history} dataKey="rss" color="#f59e0b" />}
        {cpuPct > 0 && (
          <div className="mt-2">
            <div className="mb-1 flex items-center justify-between text-[10px] text-slate-500">
              <span>CPU</span>
              <span className={cn(cpuPct > 80 ? 'text-rose-400' : cpuPct > 50 ? 'text-amber-400' : 'text-emerald-400')}>{cpuPct.toFixed(1)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-500',
                  cpuPct > 80 ? 'bg-rose-500' : cpuPct > 50 ? 'bg-amber-500' : 'bg-emerald-500'
                )}
                style={{ width: `${Math.min(100, cpuPct)}%` }}
              />
            </div>
          </div>
        )}
      </KpiCard>
      <KpiCard
        title="吞吐量"
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

function ChartsRow({ chartData, timeRange, setTimeRange }: {
  chartData: { time: string; rss: number; cpu: number; rx: number; tx: number }[]
  timeRange: number
  setTimeRange: (n: number) => void
}) {
  const empty = chartData.length === 0
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card className="rounded-xl border-white/5 bg-slate-900/60 p-5 shadow-lg shadow-black/20 lg:col-span-2">
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-slate-100">资源使用</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
            <div className="flex items-center gap-0.5 rounded-md border border-white/10 bg-white/5 p-0.5">
              {([60, 300, 900, 1800] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setTimeRange(r)}
                  className={cn(
                    'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                    timeRange === r
                      ? 'bg-amber-500/20 text-amber-300'
                      : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                  )}
                >
                  {r < 60 ? `${r}s` : r < 3600 ? `${r / 60}m` : `${r / 3600}h`}
                </button>
              ))}
            </div>
            <span className="hidden items-center gap-1.5 sm:inline-flex"><span className="size-2 rounded-sm bg-amber-500" /> RSS</span>
            <span className="hidden items-center gap-1.5 sm:inline-flex"><span className="size-2 rounded-sm bg-orange-400" /> CPU</span>
            <button
              onClick={() => downloadCSV(`warp-metrics-${Date.now()}.csv`, chartData)}
              disabled={chartData.length === 0}
              className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-300 transition-colors hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-white/5"
              title="导出指标历史为 CSV"
            >
              <Download className="size-3" /> CSV
            </button>
          </div>
        </div>
        <div className="h-[240px] w-full">
          {empty ? (
            <div className="grid h-full place-items-center text-xs text-slate-500">
              <span className="flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" /> 等待遥测数据…
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
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" strokeOpacity={0.5} />
                <XAxis dataKey="time" stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} minTickGap={48} />
                <YAxis yAxisId="rss" stroke="#f59e0b" fontSize={10} tickLine={false} axisLine={false} width={38} allowDecimals={false} />
                <YAxis yAxisId="cpu" orientation="right" stroke="#fb923c" fontSize={10} tickLine={false} axisLine={false} width={32} unit="%" domain={[0, 100]} allowDecimals={false} ticks={[0, 25, 50, 75, 100]} />
                <RTooltip
                  contentStyle={tooltipStyle}
                  labelStyle={{ color: '#94a3b8', fontSize: 11 }}
                  itemStyle={{ color: '#e2e8f0' }}
                  cursor={{ stroke: '#f59e0b', strokeWidth: 1, strokeDasharray: '4 4', strokeOpacity: 0.5 }}
                />
                <Area yAxisId="rss" type="monotone" dataKey="rss" name="RSS (MB)" stroke="#f59e0b" strokeWidth={2} fill="url(#rssArea)" isAnimationActive animationDuration={300} animationEasing="ease-out" />
                <Line yAxisId="cpu" type="monotone" dataKey="cpu" name="CPU (%)" stroke="#fb923c" strokeWidth={2} dot={false} isAnimationActive animationDuration={300} animationEasing="ease-out" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      <Card className="rounded-xl border-white/5 bg-slate-900/60 p-5 shadow-lg shadow-black/20">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ArrowDownUp className="size-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-slate-100">吞吐量</h2>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-slate-400">
            <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-amber-500" /> ↓ 接收</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-rose-500" /> ↑ 发送</span>
          </div>
        </div>
        <div className="h-[240px] w-full">
          {empty ? (
            <div className="grid h-full place-items-center text-xs text-slate-500">
              <span className="flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" /> 等待遥测数据…
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
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" strokeOpacity={0.5} />
                <XAxis dataKey="time" stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} minTickGap={48} />
                <YAxis stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} width={56} allowDecimals={false} tickFormatter={(v: number) => formatRate(Number(v))} />
                <RTooltip
                  contentStyle={tooltipStyle}
                  labelStyle={{ color: '#94a3b8', fontSize: 11 }}
                  itemStyle={{ color: '#e2e8f0' }}
                  formatter={(value: number | string, name: string) => [formatRate(Number(value)), name]}
                  cursor={{ stroke: '#f59e0b', strokeWidth: 1, strokeDasharray: '4 4', strokeOpacity: 0.5 }}
                />
                <Area type="monotone" dataKey="rx" name="↓ 接收" stroke="#f59e0b" strokeWidth={2} fill="url(#rxArea)" isAnimationActive animationDuration={300} animationEasing="ease-out" />
                <Area type="monotone" dataKey="tx" name="↑ 发送" stroke="#f43f5e" strokeWidth={2} fill="url(#txArea)" isAnimationActive animationDuration={300} animationEasing="ease-out" />
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
      toast.success(`${label} 已派发`, { id: t })
    } catch (e) {
      toast.error(`${label} 失败：${(e as Error).message}`, { id: t })
    } finally {
      setBusy(null)
    }
  }, [])

  const handleTrace = useCallback(async () => {
    setBusy('trace')
    const t = toast.loading('正在执行链路测试…')
    try {
      const r = await trace()
      setTraceResult(r)
      setTraceOpen(true)
      if (r?.ok) toast.success('链路测试完成', { id: t })
      else toast.warning('链路返回 — 请检查输出', { id: t })
    } catch (e) {
      toast.error(`链路测试失败：${(e as Error).message}`, { id: t })
    } finally {
      setBusy(null)
    }
  }, [trace])

  const handleRegister = useCallback(async () => {
    if (!license.trim()) {
      toast.error('请先输入许可证密钥')
      return
    }
    setBusy('register')
    const t = toast.loading('正在使用许可证注册…')
    try {
      await register(license.trim())
      toast.success('注册指令已派发', { id: t })
      setLicense('')
    } catch (e) {
      toast.error(`注册失败：${(e as Error).message}`, { id: t })
    } finally {
      setBusy(null)
    }
  }, [license, register])

  return (
    <Card className="flex h-full flex-col gap-4 rounded-xl border-white/5 bg-slate-900/60 p-5 shadow-lg shadow-black/20">
      <div className="flex items-center gap-2">
        <Power className="size-4 text-amber-400" />
        <h2 className="text-sm font-semibold text-slate-100">WARP 控制</h2>
        {warpDemo && (
          <Badge variant="outline" className="ml-auto border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300">
            演示
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Button
          onClick={() => run('connect', '连接 WARP', connect)}
          disabled={busy !== null}
          className="bg-emerald-600 text-white transition-all hover:bg-emerald-500 hover:shadow-lg hover:shadow-emerald-500/30 active:scale-95"
        >
          {busy === 'connect' ? <Loader2 className="size-4 animate-spin" /> : <Power className="size-4" />}
          连接
        </Button>
        <Button
          onClick={() => run('disconnect', '断开 WARP', disconnect)}
          disabled={busy !== null}
          variant="secondary"
          className="bg-slate-700 text-slate-100 transition-all hover:bg-slate-600 hover:shadow-lg hover:shadow-slate-500/20 active:scale-95"
        >
          {busy === 'disconnect' ? <Loader2 className="size-4 animate-spin" /> : <PowerOff className="size-4" />}
          断开
        </Button>
        <Button
          onClick={() => run('restart', '重启 WARP', restart)}
          disabled={busy !== null}
          variant="outline"
          className="border-amber-500/40 bg-amber-500/5 text-amber-300 transition-all hover:bg-amber-500/10 hover:shadow-md hover:shadow-amber-500/20 active:scale-95"
        >
          {busy === 'restart' ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          重启
        </Button>
        <Button
          onClick={handleTrace}
          disabled={busy !== null}
          variant="outline"
          className="border-white/10 bg-white/5 text-slate-200 transition-all hover:bg-white/10 hover:shadow-md hover:shadow-white/10 active:scale-95"
        >
          {busy === 'trace' ? <Loader2 className="size-4 animate-spin" /> : <Terminal className="size-4" />}
          测试链路
        </Button>
      </div>

      <Separator className="bg-white/5" />

      <div className="space-y-2">
        <Label htmlFor="license" className="text-xs text-slate-400">
          <KeyRound className="mr-1 inline size-3.5" /> 许可证密钥（可选）
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
            注册
          </Button>
        </div>
      </div>

      <Collapsible open={traceOpen} onOpenChange={setTraceOpen} className="mt-auto">
        <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-white/5 bg-slate-950/40 px-3 py-2 text-xs text-slate-300 hover:bg-slate-950/60">
          <span className="flex items-center gap-2">
            <Terminal className="size-3.5 text-amber-400" /> 链路输出
          </span>
          <ChevronDown className={cn('size-3.5 transition-transform', traceOpen && 'rotate-180')} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-white/5 bg-slate-950/80 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
            {traceResult?.trace ?? traceResult?.warp ?? (traceResult ? '(空链路)' : '运行“测试链路”以查看 Cloudflare 链路输出。')}
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

/* ------------------------------------------------------------------ */
/*  Section: Runtime settings editor                                   */
/* ------------------------------------------------------------------ */

interface RuntimeSettingsProps {
  settings: { maxConnections: number; idleTimeoutMs: number; metricsIntervalMs: number; logBufferSize: number }
  onUpdate: (s: Record<string, number>) => Promise<{ applied: Record<string, boolean>; reasons: Record<string, string> }>
}

function RuntimeSettings({ settings, onUpdate }: RuntimeSettingsProps) {
  const [draft, setDraft] = useState({
    maxConnections: settings.maxConnections,
    idleTimeoutMs: settings.idleTimeoutMs,
    metricsIntervalMs: settings.metricsIntervalMs,
    logBufferSize: settings.logBufferSize,
  })
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)
  const editingRef = useRef(false)

  // 当 settings prop 变化时同步 draft（但用户正在编辑时不覆盖）
  useEffect(() => {
    if (editingRef.current) return
    setDraft({
      maxConnections: settings.maxConnections,
      idleTimeoutMs: settings.idleTimeoutMs,
      metricsIntervalMs: settings.metricsIntervalMs,
      logBufferSize: settings.logBufferSize,
    })
  }, [settings])

  const dirty = (['maxConnections', 'idleTimeoutMs', 'metricsIntervalMs', 'logBufferSize'] as const)
    .some((k) => draft[k] !== settings[k])

  const save = async () => {
    setSaving(true)
    setFeedback(null)
    const changes: Record<string, number> = {}
    for (const k of ['maxConnections', 'idleTimeoutMs', 'metricsIntervalMs', 'logBufferSize'] as const) {
      if (draft[k] !== settings[k]) changes[k] = draft[k]
    }
    try {
      const { applied, reasons } = await onUpdate(changes)
      const failed = Object.entries(applied).filter(([, v]) => !v)
      if (failed.length === 0) {
        toast.success('配置已更新', { description: Object.keys(changes).join(', ') })
        setFeedback({ ok: true, msg: '已应用' })
      } else {
        const msg = failed.map(([k]) => `${k}: ${reasons[k] || '验证失败'}`).join('；')
        toast.error('部分配置更新失败', { description: msg })
        setFeedback({ ok: false, msg })
      }
    } catch (e) {
      toast.error('更新失败', { description: (e as Error).message })
      setFeedback({ ok: false, msg: (e as Error).message })
    } finally {
      setSaving(false)
      editingRef.current = false
      setTimeout(() => setFeedback(null), 3000)
    }
  }

  const reset = () => {
    editingRef.current = false
    setDraft({
      maxConnections: settings.maxConnections,
      idleTimeoutMs: settings.idleTimeoutMs,
      metricsIntervalMs: settings.metricsIntervalMs,
      logBufferSize: settings.logBufferSize,
    })
    setFeedback(null)
  }

  const fields: { key: keyof typeof draft; label: string; min: number; max: number; step: number; unit: string; desc: string }[] = [
    { key: 'maxConnections', label: '最大连接数', min: 1, max: 100000, step: 1, unit: '', desc: '并发连接上限' },
    { key: 'idleTimeoutMs', label: '空闲超时', min: 5000, max: 3600000, step: 1000, unit: 'ms', desc: '连接空闲多久后关闭' },
    { key: 'metricsIntervalMs', label: '采集间隔', min: 500, max: 60000, step: 500, unit: 'ms', desc: '指标采集频率' },
    { key: 'logBufferSize', label: '日志缓冲', min: 50, max: 10000, step: 50, unit: '行', desc: '日志环形缓冲区大小' },
  ]

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {fields.map((f) => {
          const val = draft[f.key]
          const changed = val !== settings[f.key]
          return (
            <div key={f.key} className="rounded-md border border-white/5 bg-slate-950/40 p-2">
              <div className="mb-1 flex items-center justify-between">
                <label className="text-[10px] font-medium text-slate-400">{f.label}</label>
                <span className={cn('font-mono text-[10px]', changed ? 'text-amber-300' : 'text-slate-500')}>
                  {val}{f.unit}
                </span>
              </div>
              <input
                type="number"
                min={f.min}
                max={f.max}
                step={f.step}
                value={val}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (Number.isFinite(n)) {
                    editingRef.current = true
                    setDraft((d) => ({ ...d, [f.key]: n }))
                  }
                }}
                className={cn(
                  'h-7 w-full rounded border bg-slate-950/60 px-2 font-mono text-xs text-slate-200 focus:outline-none',
                  changed ? 'border-amber-500/40 focus:ring-1 focus:ring-amber-500/30' : 'border-white/10 focus:border-amber-500/40'
                )}
              />
              <p className="mt-0.5 text-[9px] text-slate-600">{f.desc}</p>
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={save}
          disabled={!dirty || saving}
          className="h-7 bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-40"
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          保存
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={reset}
          disabled={!dirty || saving}
          className="h-7 text-xs text-slate-400 hover:bg-white/5 disabled:opacity-40"
        >
          重置
        </Button>
        {feedback && (
          <span className={cn('text-[10px]', feedback.ok ? 'text-emerald-400' : 'text-rose-400')}>
            {feedback.ok ? '✓' : '✗'} {feedback.msg.slice(0, 40)}
          </span>
        )}
      </div>
    </div>
  )
}

function ConfigPanel({
  config, proxyUrl, warp, settings, onUpdateSettings,
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
  settings: { maxConnections: number; idleTimeoutMs: number; metricsIntervalMs: number; logBufferSize: number } | null
  onUpdateSettings: (s: Record<string, number>) => Promise<{ applied: Record<string, boolean>; reasons: Record<string, string> }>
}) {
  const rows: ConfigRow[] = config
    ? [
        { key: 'proxyPort', label: '代理监听端口', kind: 'port', value: config.proxyPort },
        { key: 'controlPort', label: '控制端口', kind: 'port', value: config.controlPort },
        { key: 'upstream', label: '上游', kind: 'mono', value: `${config.upstreamHost}:${config.upstreamPort}` },
        { key: 'warpSvc', label: 'warp-svc 路径', kind: 'muted', value: config.warpSvcPath || '—' },
        { key: 'warpCli', label: 'warp-cli 路径', kind: 'muted', value: config.warpCliPath || '—' },
        { key: 'mode', label: '模式', kind: 'text', value: config.mode },
        { key: 'license', label: '许可证已配置', kind: 'bool', value: config.licenseConfigured },
        ...(warp
          ? ([
              { key: 'warpSvcInstalled', label: 'warp-svc 已安装', kind: 'bool' as ConfigRowKind, value: warp.installed },
              { key: 'warpCliInstalled', label: 'warp-cli 已安装', kind: 'bool' as ConfigRowKind, value: warp.cliInstalled },
              { key: 'warpMode', label: 'WARP 模式', kind: 'text' as ConfigRowKind, value: warp.mode || '—' },
              { key: 'warpPort', label: 'WARP 代理端口', kind: 'port' as ConfigRowKind, value: warp.port },
              ...(warp.pid
                ? [{ key: 'warpPid', label: 'warp-svc pid', kind: 'muted' as ConfigRowKind, value: warp.pid }]
                : []),
              { key: 'lastChecked', label: '最后检查', kind: 'muted' as ConfigRowKind, value: fmtTime(warp.lastChecked) },
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
        ? <span className="text-emerald-300">是</span>
        : <span className="text-slate-500">否</span>
      default: return <span className="text-slate-400">{String(row.value)}</span>
    }
  }

  return (
    <Card className="flex h-full flex-col gap-4 rounded-xl border-white/5 bg-slate-900/60 p-5 shadow-lg shadow-black/20">
      <div className="flex items-center gap-2">
        <Gauge className="size-4 text-amber-400" />
        <h2 className="text-sm font-semibold text-slate-100">配置</h2>
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

      {/* 运行时可编辑配置 */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <SlidersHorizontal className="size-3.5 text-amber-400" />
          <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">运行时配置</span>
        </div>
        {settings ? (
          <RuntimeSettings settings={settings} onUpdate={onUpdateSettings} />
        ) : (
          <div className="text-xs text-slate-600">加载中…</div>
        )}
      </div>

      <div className="mt-auto space-y-2">
        <Label className="text-xs text-slate-400">代理地址</Label>
        <div className="flex items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
          <code className="flex-1 truncate font-mono text-xs text-amber-200">{proxyUrl}</code>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            onClick={() => copyToClipboard(proxyUrl, '代理地址已复制')}
            aria-label="复制代理地址"
          >
            <Copy className="size-3.5" />
          </Button>
        </div>
        <p className="text-[11px] text-slate-500">
          将任何支持 SOCKS5 或 HTTP CONNECT 的客户端指向此地址。
        </p>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Section: Connections table                                         */
/* ------------------------------------------------------------------ */

function ConnectionsTable({ conns }: { conns: ConnEvent[] }) {
  const [sortKey, setSortKey] = useState<'time' | 'rx' | 'tx' | 'duration'>('time')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const sortedConns = useMemo(() => {
    const arr = [...conns]
    if (sortKey === 'time') {
      arr.sort((a, b) => sortDir === 'desc' ? b.id - a.id : a.id - b.id)
    } else if (sortKey === 'rx') {
      arr.sort((a, b) => sortDir === 'desc' ? (b.rx ?? 0) - (a.rx ?? 0) : (a.rx ?? 0) - (b.rx ?? 0))
    } else if (sortKey === 'tx') {
      arr.sort((a, b) => sortDir === 'desc' ? (b.tx ?? 0) - (a.tx ?? 0) : (a.tx ?? 0) - (b.tx ?? 0))
    } else if (sortKey === 'duration') {
      arr.sort((a, b) => sortDir === 'desc' ? (b.durationMs ?? 0) - (a.durationMs ?? 0) : (a.durationMs ?? 0) - (b.durationMs ?? 0))
    }
    return arr
  }, [conns, sortKey, sortDir])
  const rows = sortedConns.slice(0, 15)
  const toggleSort = (k: 'time' | 'rx' | 'tx' | 'duration') => {
    if (sortKey === k) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(k); setSortDir('desc') }
  }
  return (
    <Card className="rounded-xl border-white/5 bg-slate-900/60 p-5 shadow-lg shadow-black/20">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Network className="size-4 text-amber-400" />
          <h2 className="text-sm font-semibold text-slate-100">最近连接</h2>
          <span className="text-xs text-slate-500">{conns.length} 条事件</span>
        </div>
      </div>
      <div className="max-h-80 overflow-y-auto rounded-md border border-white/5 [scrollbar-width:thin] [scrollbar-color:#334155_transparent]">
        {/* 桌面端表格 */}
        <div className="hidden md:block">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur">
            <TableRow className="border-white/5 hover:bg-transparent">
              <TableHead className="h-9 pl-3 text-[11px] uppercase tracking-wider text-slate-500">
                <button onClick={() => toggleSort('time')} className="inline-flex items-center gap-1 hover:text-slate-300">
                  ID {sortKey === 'time' && (sortDir === 'desc' ? '↓' : '↑')}
                </button>
              </TableHead>
              <TableHead className="h-9 text-[11px] uppercase tracking-wider text-slate-500">类型</TableHead>
              <TableHead className="h-9 text-[11px] uppercase tracking-wider text-slate-500">目标</TableHead>
              <TableHead className="h-9 text-right text-[11px] uppercase tracking-wider text-slate-500">
                <button onClick={() => toggleSort('rx')} className="inline-flex items-center gap-1 hover:text-slate-300">
                  ↓ 接收 {sortKey === 'rx' && (sortDir === 'desc' ? '↓' : '↑')}
                </button>
              </TableHead>
              <TableHead className="h-9 text-right text-[11px] uppercase tracking-wider text-slate-500">
                <button onClick={() => toggleSort('tx')} className="inline-flex items-center gap-1 hover:text-slate-300">
                  ↑ 发送 {sortKey === 'tx' && (sortDir === 'desc' ? '↓' : '↑')}
                </button>
              </TableHead>
              <TableHead className="h-9 text-right text-[11px] uppercase tracking-wider text-slate-500">
                <button onClick={() => toggleSort('duration')} className="inline-flex items-center gap-1 hover:text-slate-300">
                  持续时间 {sortKey === 'duration' && (sortDir === 'desc' ? '↓' : '↑')}
                </button>
              </TableHead>
              <TableHead className="h-9 pr-3 text-[11px] uppercase tracking-wider text-slate-500">原因</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow className="border-transparent hover:bg-transparent">
                <TableCell colSpan={7} className="h-32 text-center">
                  <div className="flex flex-col items-center gap-2 text-slate-500">
                    <Network className="size-8 text-slate-700" />
                    <span className="text-xs">暂无连接 — 请将客户端指向代理地址</span>
                    <code className="rounded bg-slate-800/50 px-2 py-0.5 font-mono text-[10px] text-amber-400/80">socks5h://127.0.0.1:40000</code>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((c, i) => {
                const m = connTypeMeta(c.type)
                const target = c.host ? `${c.host}${c.port ? ':' + c.port : ''}` : ''
                return (
                  <TableRow key={`${c.id}-${i}`} className="border-white/5 transition-colors hover:bg-amber-500/[0.06] hover:shadow-[inset_2px_0_0_0_#f59e0b]">
                    <TableCell className="pl-3 font-mono text-xs text-slate-400">#{c.id}</TableCell>
                    <TableCell>
                      <span className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium', m.cls)}>
                        {c.type === 'open' && <span className="size-1.5 rounded-full bg-emerald-400" />}
                        {c.type === 'close' && <span className="size-1.5 rounded-full bg-slate-400" />}
                        {c.type === 'error' && <span className="size-1.5 rounded-full bg-rose-400" />}
                        {m.label}
                      </span>
                    </TableCell>
                    <TableCell className={cn('font-mono text-xs', target ? 'text-slate-300' : 'text-slate-700')}>{target || '—'}</TableCell>
                    <TableCell className={cn('text-right font-mono text-xs', c.rx ? 'text-emerald-300/80' : 'text-slate-700')}>{c.rx ? formatBytes(c.rx) : '—'}</TableCell>
                    <TableCell className={cn('text-right font-mono text-xs', c.tx ? 'text-rose-300/80' : 'text-slate-700')}>{c.tx ? formatBytes(c.tx) : '—'}</TableCell>
                    <TableCell className={cn('text-right font-mono text-xs', c.durationMs ? 'text-slate-400' : 'text-slate-700')}>{formatDuration(c.durationMs)}</TableCell>
                    <TableCell className="pr-3 font-mono text-xs text-slate-500">{c.reason ?? ''}</TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
        </div>
        {/* 移动端卡片列表 */}
        <div className="md:hidden divide-y divide-white/5">
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-slate-500">
              <Network className="size-8 text-slate-700" />
              <span className="text-xs">暂无连接 — 请将客户端指向代理地址</span>
              <code className="rounded bg-slate-800/50 px-2 py-0.5 font-mono text-[10px] text-amber-400/80">socks5h://127.0.0.1:40000</code>
            </div>
          ) : (
            rows.map((c, i) => {
              const m = connTypeMeta(c.type)
              const target = c.host ? `${c.host}${c.port ? ':' + c.port : ''}` : '—'
              return (
                <div key={`m-${c.id}-${i}`} className="p-3">
                  <div className="mb-1.5 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-slate-400">#{c.id}</span>
                      <span className={cn('inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium', m.cls)}>{m.label}</span>
                    </div>
                    <span className="font-mono text-[10px] text-slate-500">{formatDuration(c.durationMs)}</span>
                  </div>
                  <div className="mb-1.5 truncate font-mono text-xs text-slate-300">{target}</div>
                  <div className="flex items-center gap-3 text-[11px]">
                    <span className="text-emerald-300/80">↓ {c.rx ? formatBytes(c.rx) : '—'}</span>
                    <span className="text-rose-300/80">↑ {c.tx ? formatBytes(c.tx) : '—'}</span>
                    {c.reason && <span className="ml-auto truncate text-slate-500">{c.reason}</span>}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Section: Target statistics                                          */
/* ------------------------------------------------------------------ */

function TargetStats({ conns }: { conns: ConnEvent[] }) {
  const stats = useMemo(() => {
    const map = new Map<string, { count: number; rx: number; tx: number; lastSeen: number }>()
    for (const c of conns) {
      if (!c.host) continue
      const key = `${c.host}${c.port ? ':' + c.port : ''}`
      const cur = map.get(key) ?? { count: 0, rx: 0, tx: 0, lastSeen: 0 }
      cur.count++
      cur.rx += c.rx ?? 0
      cur.tx += c.tx ?? 0
      if (c.durationMs && (c.type === 'open' || c.type === 'close')) {
        cur.lastSeen = Math.max(cur.lastSeen, c.durationMs)
      }
      map.set(key, cur)
    }
    return Array.from(map.entries())
      .map(([target, s]) => ({ target, ...s }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
  }, [conns])

  const maxCount = stats.length > 0 ? stats[0].count : 1

  return (
    <Card className="rounded-xl border-white/5 bg-slate-900/60 p-5 shadow-lg shadow-black/20">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gauge className="size-4 text-amber-400" />
          <h2 className="text-sm font-semibold text-slate-100">目标统计</h2>
          <span className="text-xs text-slate-500">按连接数 Top 10</span>
        </div>
        <span className="text-xs text-slate-500">{stats.length} 个目标</span>
      </div>
      {stats.length === 0 ? (
        <div className="grid h-20 place-items-center text-xs text-slate-600">
          暂无目标数据 — 产生代理流量后将自动统计
        </div>
      ) : (
        <div className="space-y-2">
          {stats.map((s, i) => (
            <div key={s.target} className="group">
              <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 font-mono text-[10px] text-slate-600">#{i + 1}</span>
                  <span className="truncate font-mono text-slate-300">{s.target}</span>
                </div>
                <div className="flex shrink-0 items-center gap-3 font-mono text-[11px]">
                  <span className="text-slate-400">{s.count} 次</span>
                  <span className="text-emerald-300/70">↓{formatBytes(s.rx)}</span>
                  <span className="text-rose-300/70">↑{formatBytes(s.tx)}</span>
                </div>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-amber-500 to-orange-400 transition-all duration-500"
                  style={{ width: `${(s.count / maxCount) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Section: Log stream                                                */
/* ------------------------------------------------------------------ */

function LogStream({ logs, onClear }: { logs: LogLine[]; onClear: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all')
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const filteredLogs = logs.filter((l) => {
    if (levelFilter !== 'all' && l.level !== levelFilter) return false
    if (q && !(`${l.cat} ${l.msg}`.toLowerCase().includes(q))) return false
    return true
  })

  // 高亮匹配的关键字
  const highlight = (text: string) => {
    if (!q) return text
    const idx = text.toLowerCase().indexOf(q)
    if (idx < 0) return text
    return (
      <>
        {text.slice(0, idx)}
        <mark className="rounded-sm bg-amber-400/30 px-0.5 text-amber-200">{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    )
  }

  // Keep pinned to bottom when new logs arrive (unless user scrolled up).
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [filteredLogs.length])

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
          <h2 className="text-sm font-semibold text-slate-100">日志流</h2>
          <span className="text-xs text-slate-500">{filteredLogs.length} / {logs.length} 行</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索日志…"
              className="h-7 w-32 rounded-md border border-white/10 bg-slate-950/60 pl-7 pr-2 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:border-amber-500/40 focus:outline-none focus:ring-1 focus:ring-amber-500/30 sm:w-40"
            />
          </div>
          <div className="flex items-center gap-1">
            {(['all', 'info', 'warn', 'error', 'debug'] as const).map((lv) => (
              <button
                key={lv}
                onClick={() => setLevelFilter(lv)}
                className={cn(
                  'rounded px-2 py-0.5 text-[10px] font-medium uppercase transition-colors',
                  levelFilter === lv
                    ? 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30'
                    : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
                )}
              >
                {lv === 'all' ? '全部' : lv}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={onClear}
            className="h-7 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200"
          >
            <Trash2 className="size-3.5" /> 清空
          </Button>
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="max-h-96 overflow-y-auto rounded-md border border-white/5 bg-slate-950/80 p-3 font-mono text-xs leading-relaxed [scrollbar-width:thin] [scrollbar-color:#334155_transparent]"
      >
        {filteredLogs.length === 0 ? (
          <div className="grid h-24 place-items-center text-xs text-slate-600">
            暂无日志。
          </div>
        ) : (
          filteredLogs.map((l, i) => {
            const m = logLevelMeta(l.level)
            return (
              <div key={l.t + '_' + i} className="log-fade-in flex items-start gap-2 py-0.5">
                <span className="shrink-0 font-mono text-slate-600">{fmtTime(l.t).slice(0,5)}<span className="sm:inline hidden">{fmtTime(l.t).slice(5)}</span></span>
                <span className={cn('shrink-0 rounded px-1 text-[10px] font-semibold uppercase', m.bg, m.tag)}>
                  {l.level}
                </span>
                <span className="hidden shrink-0 text-slate-500 sm:inline">[{l.cat}]</span>
                <span className="break-all text-slate-300">{highlight(l.msg)}</span>
              </div>
            )
          })
        )}
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Section: Quick setup snippets                                      */
/* ------------------------------------------------------------------ */

const SETUP_SNIPPETS: { id: string; label: string; icon: typeof Terminal; code: string }[] = [
  {
    id: 'curl',
    label: 'curl',
    icon: Terminal,
    code: `# 通过 WARP 代理访问（远程 DNS 解析）
curl https://www.cloudflare.com/cdn-cgi/trace -x socks5h://127.0.0.1:40000

# 或使用 HTTP CONNECT
curl https://www.cloudflare.com/cdn-cgi/trace -x http://127.0.0.1:40000`,
  },
  {
    id: 'git',
    label: 'git',
    icon: Terminal,
    code: `# 临时使用 WARP 代理克隆仓库
git -c http.proxy=socks5h://127.0.0.1:40000 clone https://github.com/user/repo.git

# 或全局设置
git config --global http.proxy socks5h://127.0.0.1:40000
git config --global --unset http.proxy  # 取消`,
  },
  {
    id: 'firefox',
    label: 'Firefox',
    icon: Globe,
    code: `# Firefox → 首选项 → 网络设置 → 手动配置代理
# SOCKS 主机: 127.0.0.1  端口: 40000
# SOCKS v5  ✓ 远程 DNS（重要：勾选此项）
# 然后访问 https://www.cloudflare.com/cdn-cgi/trace 验证 warp=on`,
  },
  {
    id: 'env',
    label: '环境变量',
    icon: Terminal,
    code: `# 设置 shell 全局代理（影响 curl/wget/git 等）
export ALL_PROXY=socks5h://127.0.0.1:40000
export HTTP_PROXY=http://127.0.0.1:40000
export HTTPS_PROXY=http://127.0.0.1:40000

# 取消
unset ALL_PROXY HTTP_PROXY HTTPS_PROXY`,
  },
]

function QuickSetupSection() {
  const [active, setActive] = useState(SETUP_SNIPPETS[0].id)
  const snippet = SETUP_SNIPPETS.find((s) => s.id === active) ?? SETUP_SNIPPETS[0]
  const ActiveIcon = snippet.icon
  return (
    <Card className="rounded-xl border-white/5 bg-slate-900/60 p-5 shadow-lg shadow-black/20">
      <div className="mb-4 flex items-center gap-2">
        <Terminal className="size-4 text-amber-400" />
        <h2 className="text-sm font-semibold text-slate-100">快速配置</h2>
        <span className="text-xs text-slate-500">常用客户端代理配置示例</span>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {SETUP_SNIPPETS.map((s) => {
          const Icon = s.icon
          return (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                active === s.id
                  ? 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30'
                  : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
              )}
            >
              <Icon className="size-3.5" /> {s.label}
            </button>
          )
        })}
      </div>
      <div className="relative">
        <pre className="max-h-64 overflow-auto rounded-md border border-white/5 bg-slate-950/80 p-3 pr-10 font-mono text-xs leading-relaxed text-slate-300 [scrollbar-width:thin] [scrollbar-color:#334155_transparent]">
          {snippet.code}
        </pre>
        <button
          onClick={() => copyToClipboard(snippet.code, `${snippet.label} 配置已复制`)}
          className="absolute right-2 top-2 rounded-md border border-white/10 bg-slate-800/80 p-1.5 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
          aria-label="复制配置"
        >
          <Copy className="size-3.5" />
        </button>
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500">
        <ActiveIcon className="size-3 text-amber-400/60" />
        <span>将代理指向 <code className="rounded bg-slate-800/50 px-1 font-mono text-amber-400/80">127.0.0.1:40000</code> 即可使用</span>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Section: Command palette (Cmd+K)                                   */
/* ------------------------------------------------------------------ */

interface CommandAction {
  id: string
  label: string
  hint?: string
  icon: React.ComponentType<{ className?: string }>
  run: () => void
}

function CommandPalette({
  open, onClose, actions,
}: {
  open: boolean
  onClose: () => void
  actions: CommandAction[]
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return actions
    return actions.filter((a) => a.label.toLowerCase().includes(q) || a.hint?.toLowerCase().includes(q))
  }, [query, actions])

  // 打开时自动聚焦（不在此处 setState，用 autoFocus + key 重置避免 lint 冲突）
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
      else if (e.key === 'Enter' && filtered[active]) { e.preventDefault(); filtered[active].run(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, filtered, active, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-slate-950/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="mt-[15vh] w-full max-w-lg overflow-hidden rounded-xl border border-white/10 bg-slate-900 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
          <Search className="size-4 text-slate-500" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
            placeholder="输入命令或搜索…"
            className="flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none"
          />
          <kbd className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">ESC</kbd>
        </div>
        <div className="max-h-80 overflow-y-auto p-2 [scrollbar-width:thin] [scrollbar-color:#334155_transparent]">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-600">无匹配命令</div>
          ) : (
            filtered.map((a, i) => {
              const Icon = a.icon
              return (
                <button
                  key={a.id}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => { a.run(); onClose() }}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors',
                    i === active ? 'bg-amber-500/10 text-amber-200' : 'text-slate-300 hover:bg-white/5'
                  )}
                >
                  <Icon className={cn('size-4', i === active ? 'text-amber-400' : 'text-slate-500')} />
                  <span className="flex-1">{a.label}</span>
                  {a.hint && <span className="font-mono text-[10px] text-slate-600">{a.hint}</span>}
                </button>
              )
            })
          )}
        </div>
        <div className="flex items-center justify-between border-t border-white/5 px-4 py-2 text-[10px] text-slate-600">
          <span className="flex items-center gap-2">
            <kbd className="rounded border border-white/10 bg-white/5 px-1 py-0.5 font-mono">↑↓</kbd> 导航
            <kbd className="rounded border border-white/10 bg-white/5 px-1 py-0.5 font-mono">↵</kbd> 执行
          </span>
          <span>{filtered.length} 个命令</span>
        </div>
      </div>
    </div>
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
        <h2 className="text-sm font-semibold text-slate-100">原始 Docker 镜像 vs Node.js 重写版</h2>
      </div>
      <p className="mb-4 text-xs text-slate-500">
        在原始 Debian+socat 镜像与此 Node 守护进程上测量
      </p>

      <div className="grid grid-cols-1 gap-3">
        {COMPARISON_ROWS.map((row) => (
          <div key={row.label} className="rounded-lg border border-white/5 bg-slate-950/40 p-3.5">
            <div className="mb-2.5 text-xs font-medium uppercase tracking-wider text-slate-400">
              {row.label}
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div className="rounded-md border border-rose-500/20 bg-rose-500/5 p-2.5">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-rose-300/80">
                  <Boxes className="size-3" /> 原始版
                </div>
                <div className="font-mono text-[13px] leading-relaxed text-slate-400">{row.original}</div>
              </div>
              <div className="rounded-md border border-emerald-500/25 bg-emerald-500/5 p-2.5">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-300/90">
                  <Check className="size-3" /> Node.js 重写版
                </div>
                <div className="font-mono text-[13px] leading-relaxed text-slate-100">{row.node}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-4 border-t border-white/5 pt-3 text-[11px] leading-relaxed text-slate-500">
        官方 <code className="text-slate-400">warp-svc</code> Rust 守护进程仍然需要用于 MASQUE 协议通信 —
        此重写消除了浪费的 socat 双跳和 bash 开销，并增加了监管 + 可观测性。
      </p>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Section: Footer                                                     */
/* ------------------------------------------------------------------ */

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${Math.floor(seconds % 60)}秒`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}时${Math.floor((seconds % 3600) / 60)}分`
  return `${Math.floor(seconds / 86400)}天${Math.floor((seconds % 86400) / 3600)}时`
}

function DashboardFooter({
  proxyUrl, connected, controlPort, proxyPort, proxyListening, uptime, onScrollTop,
}: {
  proxyUrl: string
  connected: boolean
  controlPort: number
  proxyPort: number
  proxyListening: boolean
  uptime: number
  onScrollTop: () => void
}) {
  return (
    <footer className="mt-auto border-t border-white/5 bg-slate-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-3 px-4 py-4 text-xs text-slate-500 sm:flex-row sm:justify-between sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-slate-400">WARP 控制中心 · Node.js 重写版</span>
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
            <Clock className="size-3 text-amber-400/70" />
            <span className="text-slate-400">运行 {formatUptime(uptime)}</span>
          </span>
          <span className="hidden h-3 w-px bg-white/10 sm:inline-block" />
          <span className="inline-flex items-center gap-1.5">
            <span className={cn('size-1.5 rounded-full', connected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600')} />
            控制面 :{controlPort}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className={cn('size-1.5 rounded-full', proxyListening ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600')} />
            代理 :{proxyPort}
          </span>
          <button
            onClick={onScrollTop}
            className="ml-1 inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
            title="回到顶部"
          >
            <ArrowUp className="size-3" />
            <span className="hidden sm:inline">顶部</span>
          </button>
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

  const [timeRange, setTimeRange] = useState(300) // 秒数：60/300/900/1800
  const [uptime, setUptime] = useState(0)
  const [cmdOpen, setCmdOpen] = useState(false)
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettingsData | null>(null)

  const chartData = useMemo(
    () =>
      history.slice(-timeRange).map((h) => ({
        time: fmtTime(h.t),
        rss: Number(h.rssMB.toFixed(2)),
        cpu: Number(h.cpuPct.toFixed(2)),
        rx: h.rxBytesPerSec,
        tx: h.txBytesPerSec,
      })),
    [history, timeRange],
  )

  const sparkData = useMemo(
    () => chartData.slice(-60).map((d) => ({ rss: d.rss })),
    [chartData],
  )

  // 快捷键：C=连接 D=断开 R=重启 T=测试链路, ⌘K/Ctrl+K=命令面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Cmd+K / Ctrl+K 打开命令面板（在任何地方都生效）
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdOpen((v) => !v)
        return
      }
      if (loading) return
      // 忽略输入框中的普通按键
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
      const k = e.key.toLowerCase()
      if (k === 'c') { e.preventDefault(); connect().catch(() => {}) }
      else if (k === 'd') { e.preventDefault(); disconnect().catch(() => {}) }
      else if (k === 'r') { e.preventDefault(); restart().catch(() => {}) }
      else if (k === 't') { e.preventDefault(); toast.loading('快捷键已触发，请使用面板按钮查看结果', { duration: 1500 }) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [loading, connect, disconnect, restart])

  // 运行时长计时
  const startTimeRef = useRef(Date.now())
  useEffect(() => {
    const id = setInterval(() => setUptime((Date.now() - startTimeRef.current) / 1000), 1000)
    return () => clearInterval(id)
  }, [])

  // 加载运行时配置
  useEffect(() => {
    if (loading) return
    const fetchSettings = () => {
      warp.getSettings().then((s: any) => {
        setRuntimeSettings({
          maxConnections: s.maxConnections,
          idleTimeoutMs: s.idleTimeoutMs,
          metricsIntervalMs: s.metricsIntervalMs,
          logBufferSize: s.logBufferSize,
        })
      }).catch(() => {})
    }
    fetchSettings()
    // 每 10 秒刷新一次
    const id = setInterval(fetchSettings, 10000)
    return () => clearInterval(id)
  }, [loading])

  return (
    <div className="dark flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <Header connected={connected} demo={warpStatus?.demo ?? false} lastMetric={proc?.t ?? null} />

      {error && (
        <div className="mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6">
          <Alert variant="destructive" className="border-rose-500/30 bg-rose-500/10 text-rose-200">
            <CircleAlert className="size-4 text-rose-400" />
            <AlertTitle className="text-rose-200">无法连接到 WARP 控制面（:3030）</AlertTitle>
            <AlertDescription className="text-rose-300/80">
              mini-service 是否在运行？ — {error}
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
              cpuPct={proc?.cpuPct ?? 0}
              rxRate={proc?.rxBytesPerSec ?? 0}
              txRate={proc?.txBytesPerSec ?? 0}
              rxTotal={proxy?.totalRx ?? 0}
              txTotal={proxy?.totalTx ?? 0}
              history={sparkData}
            />

            <ChartsRow chartData={chartData} timeRange={timeRange} setTimeRange={setTimeRange} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <WarpControlPanel
                connect={connect}
                disconnect={disconnect}
                restart={restart}
                register={register}
                trace={trace}
                warpDemo={warpStatus?.demo ?? false}
              />
              <ConfigPanel
                config={config}
                proxyUrl={proxyUrl}
                warp={warpStatus}
                settings={runtimeSettings}
                onUpdateSettings={async (s) => {
                  const r = await warp.updateSettings(s)
                  // 更新后立即刷新
                  warp.getSettings().then((ns: any) => setRuntimeSettings({
                    maxConnections: ns.maxConnections,
                    idleTimeoutMs: ns.idleTimeoutMs,
                    metricsIntervalMs: ns.metricsIntervalMs,
                    logBufferSize: ns.logBufferSize,
                  }))
                  return r
                }}
              />
            </div>

            <QuickSetupSection />

            <ConnectionsTable conns={conns} />

            <TargetStats conns={conns} />

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
        uptime={uptime}
        onScrollTop={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      />

      <CommandPalette
        key={cmdOpen ? 'open' : 'closed'}
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        actions={[
          { id: 'connect', label: '连接 WARP', hint: 'C', icon: Power, run: () => connect().catch(() => {}) },
          { id: 'disconnect', label: '断开 WARP', hint: 'D', icon: PowerOff, run: () => disconnect().catch(() => {}) },
          { id: 'restart', label: '重启 WARP', hint: 'R', icon: RefreshCw, run: () => restart().catch(() => {}) },
          { id: 'top', label: '回到顶部', icon: ArrowUp, run: () => window.scrollTo({ top: 0, behavior: 'smooth' }) },
          { id: 'bottom', label: '跳到底部', icon: ArrowDown, run: () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }) },
        ]}
      />

      <SonnerToaster theme="dark" position="bottom-right" richColors closeButton />
    </div>
  )
}
