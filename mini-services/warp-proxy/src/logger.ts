import { EventEmitter } from 'node:events'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export interface LogLine {
  t: number
  level: LogLevel
  cat: string
  msg: string
}

/**
 * Bounded ring-buffer logger. Emits `log` on every line so the WS layer can push to dashboards.
 */
export class Logger extends EventEmitter {
  private buf: LogLine[] = []
  constructor(private max = 500) {
    super()
  }
  private push(level: LogLevel, cat: string, msg: string) {
    const line: LogLine = { t: Date.now(), level, cat, msg }
    this.buf.push(line)
    if (this.buf.length > this.max) this.buf.shift()
    this.emit('log', line)
    const ts = new Date(line.t).toISOString()
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    fn(`[${ts}] ${level.toUpperCase()} [${cat}] ${msg}`)
  }
  debug(cat: string, msg: string) { this.push('debug', cat, msg) }
  info(cat: string, msg: string) { this.push('info', cat, msg) }
  warn(cat: string, msg: string) { this.push('warn', cat, msg) }
  error(cat: string, msg: string) { this.push('error', cat, msg) }

  history(): LogLine[] { return [...this.buf] }
  recent(limit = 200): LogLine[] { return this.buf.slice(-limit) }
}
