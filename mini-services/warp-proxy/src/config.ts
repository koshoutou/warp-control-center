/**
 * Configuration — loaded from env with sane, low-footprint defaults.
 * Runtime settings (maxConnections/idleTimeoutMs/metricsIntervalMs/logBufferSize)
 * persist to a JSON file so they survive restarts.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PERSIST_FILE = process.env.SETTINGS_FILE || '/var/lib/warp-control/settings.json'
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

interface PersistedSettings {
  maxConnections?: number
  idleTimeoutMs?: number
  metricsIntervalMs?: number
  logBufferSize?: number
}

export class Config {
  proxyPort: number
  controlPort: number
  upstreamHost: string
  upstreamPort: number
  warpSvcPath: string
  warpCliPath: string
  license: string
  mdmFile: string
  autoConnect: boolean
  logBufferSize: number
  metricsIntervalMs: number
  /** Force demo mode (skip warp-svc detection) */
  forceDemo: boolean
  /** Max simultaneous proxy connections (back-pressure / DoS protection) */
  maxConnections: number
  /** Per-connection idle timeout (ms) */
  idleTimeoutMs: number

  private constructor() {}

  static load(): Config {
    const c = new Config()
    c.proxyPort = Number(process.env.PROXY_PORT || 40000)
    c.controlPort = Number(process.env.CONTROL_PORT || 3030)
    c.upstreamHost = process.env.UPSTREAM_HOST || '127.0.0.1'
    c.upstreamPort = Number(process.env.UPSTREAM_PORT || 40001)
    c.warpSvcPath = process.env.WARP_SVC_PATH || 'warp-svc'
    c.warpCliPath = process.env.WARP_CLI_PATH || 'warp-cli'
    c.license = process.env.LICENSE || ''
    c.mdmFile = process.env.MDM_FILE || '/var/lib/cloudflare-warp/mdm.xml'
    c.autoConnect = (process.env.AUTO_CONNECT || 'false').toLowerCase() === 'true'
    c.logBufferSize = Number(process.env.LOG_BUFFER_SIZE || 500)
    c.metricsIntervalMs = Number(process.env.METRICS_INTERVAL_MS || 1000)
    c.forceDemo = (process.env.FORCE_DEMO || 'false').toLowerCase() === 'true'
    c.maxConnections = Number(process.env.MAX_CONNECTIONS || 2048)
    c.idleTimeoutMs = Number(process.env.IDLE_TIMEOUT_MS || 120000)
    // 从持久化文件覆盖（如果存在）
    c.loadPersisted()
    return c
  }

  /** 从 JSON 文件加载已保存的运行时配置 */
  private loadPersisted() {
    try {
      if (!existsSync(PERSIST_FILE)) return
      const data: PersistedSettings = JSON.parse(readFileSync(PERSIST_FILE, 'utf8'))
      if (Number.isFinite(data.maxConnections)) this.maxConnections = data.maxConnections!
      if (Number.isFinite(data.idleTimeoutMs)) this.idleTimeoutMs = data.idleTimeoutMs!
      if (Number.isFinite(data.metricsIntervalMs)) this.metricsIntervalMs = data.metricsIntervalMs!
      if (Number.isFinite(data.logBufferSize)) this.logBufferSize = data.logBufferSize!
    } catch {
      // 文件损坏或不可读，忽略
    }
  }

  /** 保存当前运行时配置到 JSON 文件 */
  persist() {
    try {
      const dir = dirname(PERSIST_FILE)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const data: PersistedSettings = {
        maxConnections: this.maxConnections,
        idleTimeoutMs: this.idleTimeoutMs,
        metricsIntervalMs: this.metricsIntervalMs,
        logBufferSize: this.logBufferSize,
      }
      writeFileSync(PERSIST_FILE, JSON.stringify(data, null, 2))
    } catch {
      // 写入失败（权限/磁盘满），忽略
    }
  }

  safePublic(): PublicConfig {
    return {
      proxyPort: this.proxyPort,
      controlPort: this.controlPort,
      upstreamHost: this.upstreamHost,
      upstreamPort: this.upstreamPort,
      demoMode: this.forceDemo,
      warpSvcPath: this.warpSvcPath,
      warpCliPath: this.warpCliPath,
      licenseConfigured: !!this.license,
      mode: 'proxy',
    }
  }
}

// keep fileURLToPath import used (avoid tree-shake in some bundlers)
void fileURLToPath
