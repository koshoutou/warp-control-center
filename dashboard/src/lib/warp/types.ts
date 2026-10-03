/**
 * Shared types for the WARP proxy dashboard.
 * These mirror the shapes emitted by mini-services/warp-proxy (port 3030).
 */

export type WarpState =
  | 'unknown'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'demo'

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

export interface ProxyStats {
  listening: boolean
  port: number
  connections: number
  totalConnections: number
  activeRx: number
  activeTx: number
  totalRx: number
  totalTx: number
  rejected: number
  demo: boolean
}

export interface MetricSample {
  t: number
  rssMB: number
  heapUsedMB: number
  heapTotalMB: number
  cpuPct: number
  pid: number
  connections: number
  totalConnections: number
  rxBytesPerSec: number
  txBytesPerSec: number
  warpState: string
  warpDemo: boolean
}

export interface PublicConfig {
  proxyPort: number
  controlPort: number
  upstreamHost: string
  upstreamPort: number
  demoMode: boolean
  warpSvcPath: string
  warpCliPath: string
  licenseConfigured: boolean
  mode: string
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export interface LogLine {
  t: number
  level: LogLevel
  cat: string
  msg: string
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

export interface StatusSnapshot {
  warp: WarpStatus
  proxy: ProxyStats
  process: MetricSample | null
  config: PublicConfig
  logs?: LogLine[]
  history?: MetricSample[]
}

export interface TraceResult {
  ok: boolean
  trace?: string
  warp?: string
  demo?: boolean
}
