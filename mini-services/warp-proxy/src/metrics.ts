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

interface CpuTimes { utime: number; stime: number }

/**
 * Low-overhead metrics: reads /proc/self/stat + process.memoryUsage() on a ticker.
 * No external deps. CPU% = (Δcpu_ticks / Δwall) * 100 (single-core-normalized).
 */
export class MetricsCollector extends EventEmitter {
  private history: MetricSample[] = []
  private max = 300 // 5 min @ 1s
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

  private tick() {
    if (!this.sampler) return
    const now = Date.now()
    const dt = (now - this.lastT) / 1000
    const mem = process.memoryUsage()
    const cpu = this.readCpu()
    let cpuPct = 0
    if (this.lastCpu && dt > 0) {
      const d = (cpu.utime - this.lastCpu.utime) + (cpu.stime - this.lastCpu.stime)
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
      // fields: utime=14, stime=15 (in clock ticks)
      const utime = Number(stat[13])
      const stime = Number(stat[14])
      return { utime, stime }
    } catch {
      const cpu = process.cpuUsage()
      return { utime: cpu.user / 10000, stime: cpu.system / 10000 } // approximate to ticks
    }
  }
}
