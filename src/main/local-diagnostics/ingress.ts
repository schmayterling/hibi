import { randomUUID } from 'node:crypto'
import {
  type DiagnosticProfile,
  decodeDiagnostic,
  diagnosticLimits,
} from '../../shared/local-diagnostics.ts'
import { DiagnosticAdmission } from '../../shared/local-diagnostics-budget.ts'

// One instance belongs to one registered main-frame generation. Host lifecycle
// code disposes it on navigation/destruction; it never waits for disk or prefs.
export class DiagnosticIngress {
  private readonly token = randomUUID()
  private alive = true
  private readonly profile: DiagnosticProfile
  private readonly artifacts: [string, number][]
  private readonly modules: Set<number>
  private readonly enqueue: (wire: string) => boolean
  private readonly admission: DiagnosticAdmission
  constructor(
    profile: DiagnosticProfile,
    artifacts: [string, number][],
    enqueue: (wire: string) => boolean,
  ) {
    this.profile = profile
    this.admission = new DiagnosticAdmission(profile)
    this.artifacts = []
    let bytes = 128 // Session keys, profile and UUID, inside the 64 KiB limit.
    for (const [url, id] of artifacts.slice(0, 256)) {
      if (
        typeof url !== 'string' ||
        url.length > 1024 ||
        !Number.isInteger(id) ||
        id < 1 ||
        id > 4096
      )
        continue
      const entry: [string, number] = [url, id]
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1
      if (bytes + size > 60 * 1024) continue
      this.artifacts.push(entry)
      bytes += size
    }
    this.modules = new Set(this.artifacts.map((entry) => entry[1]))
    this.enqueue = enqueue
  }

  receive(
    trusted: boolean,
    operation: unknown,
    token: unknown,
    body: unknown,
  ): string | boolean {
    if (!this.alive || !trusted) return false
    if (operation === 'hello')
      return JSON.stringify({
        token: this.token,
        profile: this.profile,
        artifacts: this.artifacts,
      })
    if (
      operation !== 'batch' ||
      token !== this.token ||
      typeof body !== 'string' ||
      body.length > diagnosticLimits.batchBytes ||
      !/^[\x20-\x7e]*$/.test(body)
    )
      return false
    try {
      const batch = JSON.parse(body)
      if (!Array.isArray(batch) || batch.length > diagnosticLimits.batchRecords)
        return false
      const records = batch.map((wire) =>
        decodeDiagnostic(wire, this.profile, true),
      )
      if (
        records.some(
          (record) =>
            !record ||
            record.frames?.some((frame) => !this.modules.has(frame[0])),
        )
      )
        return false
      for (const record of records) {
        if (record && this.admission.admit(record.code, Date.now()))
          this.enqueue(
            JSON.stringify({
              ...record,
              role:
                record.code === 'SOURCE_WORKER_FAILED'
                  ? 'document-worker'
                  : record.code === 'WORD_COUNT_WORKER_FAILED'
                    ? 'word-count'
                    : record.code === 'TAGS_WORKER_FAILED'
                      ? 'tags'
                      : 'renderer',
            }),
          )
      }
      // Credit means transport consumed, including intentionally dropped records.
      // It is never a recovery acknowledgement or a disk durability receipt.
      return true
    } catch {
      return false
    }
  }

  dispose() {
    this.alive = false
  }
}
