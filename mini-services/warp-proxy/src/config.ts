/**
 * Configuration — loaded from env with sane, low-footprint defaults.
 */
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
    return c
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
