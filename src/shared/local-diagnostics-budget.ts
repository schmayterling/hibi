import {
  type DiagnosticCode,
  type DiagnosticProfile,
  decodeDiagnostic,
  diagnosticCode,
  diagnosticLimits,
  diagnosticPolicies,
  incrementDiagnosticCount,
} from './local-diagnostics.ts'

export class DiagnosticAdmission {
  private start = 0
  private used = 0
  private dropped = 0
  private lastMainStall = -Infinity
  private readonly seen = new Set<DiagnosticCode>()
  private readonly profile: DiagnosticProfile
  constructor(profile: DiagnosticProfile) {
    this.profile = profile
  }

  admit(code: unknown, now: number): boolean {
    if (!diagnosticCode(code)) return false
    if (now - this.start >= 1000 || now < this.start) {
      this.start = now
      this.used = 0
      this.seen.clear()
    }
    if (
      (code === 'MAIN_LOOP_STALLED' &&
        now >= this.lastMainStall &&
        now - this.lastMainStall < 60_000) ||
      this.seen.has(code) ||
      this.used >= diagnosticPolicies[this.profile].detailsPerSecond
    ) {
      this.dropped = incrementDiagnosticCount(this.dropped)
      return false
    }
    this.used++
    if (code === 'MAIN_LOOP_STALLED') this.lastMainStall = now
    this.seen.add(code)
    return true
  }

  takeDropped(): number {
    const count = this.dropped
    this.dropped = 0
    return count
  }
}

// Queues retain only validated ASCII strings. Byte size equals string length;
// no queued object can retain an Error, Promise, source snapshot or closure.
export class DiagnosticQueue {
  private records: string[] = []
  private bytes = 0
  private dropped = 0
  private readonly profile: DiagnosticProfile
  private readonly lane: 'main' | 'producer'
  constructor(profile: DiagnosticProfile, lane: 'main' | 'producer') {
    this.profile = profile
    this.lane = lane
  }

  push(wire: unknown, critical = false): boolean {
    const record = decodeDiagnostic(
      wire,
      this.profile,
      this.lane === 'producer',
    )
    if (!record || typeof wire !== 'string') return false
    const policy = diagnosticPolicies[this.profile]
    const capacity =
      this.lane === 'main' ? policy.mainBytes : policy.producerBytes
    const count =
      this.lane === 'main' ? policy.mainRecords : policy.producerRecords
    // One maximum-sized host incident is reserved within, not above, the cap.
    const reserve = this.lane === 'main' && !critical ? policy.recordBytes : 0
    const owned = JSON.stringify(record)
    if (
      owned.length > policy.recordBytes ||
      this.bytes + owned.length > capacity - reserve ||
      this.records.length >= count - (reserve ? 1 : 0)
    ) {
      this.dropped = incrementDiagnosticCount(this.dropped)
      return false
    }
    this.records.push(owned)
    this.bytes += owned.length
    return true
  }

  take(
    maxBytes: number = diagnosticLimits.batchBytes,
    maxRecords: number = diagnosticLimits.batchRecords,
  ): string[] {
    const batch: string[] = []
    let size = 0
    while (this.records.length && batch.length < maxRecords) {
      const record = this.records[0]
      if (record === undefined || size + record.length > maxBytes) break
      this.records.shift()
      this.bytes -= record.length
      size += record.length
      batch.push(record)
    }
    return batch
  }

  takeDropped(): number {
    const count = this.dropped
    this.dropped = 0
    return count
  }

  clear() {
    this.records = []
    this.bytes = 0
    this.dropped = 0
  }
  get size() {
    return { bytes: this.bytes, records: this.records.length }
  }
}
