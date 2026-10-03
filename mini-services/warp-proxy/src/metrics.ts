import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'

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

interface CpuTimes { utime: number; stime: number } // 单位：秒

/**
 * Low-overhead metrics: reads /proc/self/stat + process.memoryUsage() on a ticker.
 * No external deps. CPU% = Δcpu_seconds / Δwall_seconds * 100 (single-core normalized).
 *
 * 修复历史 bug：原公式 `Δticks / Δseconds * 100` 缺少除以 CLK_TCK(=100)，
 * 导致 1 tick/秒被算成 100% CPU（实际仅 1%），面板恒显示 100%。
 * 现在统一返回秒，消除单位歧义。
 */
export class MetricsCollector extends EventEmitter {
  private history: MetricSample[] = []
  private max = 1800 // 30 min @ 1s — 支持时间范围选择器 1m/5m/15m/30m
  private timer: NodeJS.Timeout | null = null
  private lastCpu: CpuTimes | null = null
  private lastT = 0
  private lastTickSample: MetricSample | null = null
  private sampler: (() => ({ pid: number; proxy: any; warp: any })) | null = null

  on(event: 'tick', listener: (s: MetricSample) => void): this { return super.on(event, listener) }
  emit(event: 'tick', s: MetricSample): boolean { return super.emit(event, s) }

  start(sampler: () => ({ pid: number; proxy: any; warp: any })) {
    this.sampler = sampler
    // capture baseline
    this.lastCpu = this.readCpu()
    this.lastT = Date.now()
    this.timer = setInterval(() => this.tick(), 1000)
    this.timer.unref?.()
  }

  /** 动态调整采集间隔（毫秒） */
  setInterval(ms: number) {
    if (!Number.isFinite(ms) || ms < 500 || ms > 60000) return
    if (this.timer) clearInterval(this.timer)
    this.lastCpu = this.readCpu()
    this.lastT = Date.now()
    this.timer = setInterval(() => this.tick(), ms)
    this.timer.unref?.()
  }

  private tick() {
    if (!this.sampler) return
    const now = Date.now()
    const dt = (now - this.lastT) / 1000
    const mem = process.memoryUsage()
    const cpu = this.readCpu()
    let cpuPct = 0
    if (this.lastCpu && dt > 0) {
      const d = (cpu.utime - this.lastCpu.utime) + (cpu.stime - this.lastCpu.stime)
      // 正确公式：增量 CPU 秒 / 间隔墙钟秒 * 100（单核归一化）
      cpuPct = (d / dt) * 100
    }
    const snap = this.sampler()
    const proxy = snap.proxy
    const sample: MetricSample = {
      t: now,
      rssMB: mem.rss / 1024 / 1024,
      heapUsedMB: mem.heapUsed / 1024 / 1024,
      heapTotalMB: mem.heapTotal / 1024 / 1024,
      cpuPct: Math.max(0, Math.min(100, cpuPct)),
      pid: snap.pid,
      connections: proxy?.connections ?? 0,
      totalConnections: proxy?.totalConnections ?? 0,
      rxBytesPerSec: proxy?.activeRx ?? 0,
      txBytesPerSec: proxy?.activeTx ?? 0,
      warpState: snap.warp?.state ?? 'unknown',
      warpDemo: !!snap.warp?.demo,
    }
    this.history.push(sample)
    if (this.history.length > this.max) this.history.shift()
    this.lastCpu = cpu
    this.lastT = now
    this.lastTickSample = sample
    this.emit('tick', sample)
  }

  latest(): MetricSample | null { return this.lastTickSample ?? this.history.at(-1) ?? null }
  history_(limit = 300): MetricSample[] { return this.history.slice(-limit) }

  private readCpu(): CpuTimes {
    try {
      const stat = readFileSync(`/proc/self/stat`, 'utf8').trim().split(' ')
      // fields: utime=14 (index 13), stime=15 (index 14) — unit: clock ticks
      const CLK_TCK = 100 // Linux 标准时钟频率
      const utimeSec = Number(stat[13]) / CLK_TCK
      const stimeSec = Number(stat[14]) / CLK_TCK
      return { utime: utimeSec, stime: stimeSec }
    } catch {
      // fallback: process.cpuUsage() 返回微秒，转换为秒
      const cpu = process.cpuUsage()
      return { utime: cpu.user / 1e6, stime: cpu.system / 1e6 }
    }
  }
}
