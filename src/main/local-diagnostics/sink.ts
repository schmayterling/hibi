import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as filesystem from 'node:fs/promises'
import { join } from 'node:path'
import { sameFileIdentity } from '../../shared/file-identity.ts'
import {
  type DiagnosticProfile,
  decodeDiagnostic,
  diagnosticEvents,
  diagnosticLimits,
  diagnosticPolicies,
  incrementDiagnosticCount,
  type SafeDiagnostic,
} from '../../shared/local-diagnostics.ts'
import { DiagnosticQueue } from '../../shared/local-diagnostics-budget.ts'

import { retryRename } from '../atomic-rename.ts'

const kind = 'hibi-local-diagnostics'
const ownedNames = [
  'segment-0.log',
  'segment-1.log',
  'segment-2.log',
  'segment-3.log',
  'last-incident.txt',
  'incident-next.txt',
  'run-state.txt',
]
type Handle = Awaited<ReturnType<typeof filesystem.open>>
export type DiagnosticIdentity = {
  app: string
  build: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  arch: string
  packaged: boolean
}
export function diagnosticIdentity(
  input: DiagnosticIdentity,
): DiagnosticIdentity {
  const version = (value: unknown) =>
    typeof value === 'string' && /^[a-zA-Z0-9.+_-]{1,80}$/.test(value)
      ? value
      : 'unknown'
  return {
    app: version(input.app),
    build: /^(?:unknown|[a-f0-9]{7,40}(?:-dirty)?)$/.test(input.build)
      ? input.build
      : 'unknown',
    electron: version(input.electron),
    chrome: version(input.chrome),
    node: version(input.node),
    v8: version(input.v8),
    platform: ['darwin', 'win32', 'linux'].includes(input.platform)
      ? input.platform
      : 'unknown',
    arch: ['arm64', 'x64', 'ia32', 'arm'].includes(input.arch)
      ? input.arch
      : 'unknown',
    packaged: input.packaged === true,
  }
}

// One async writer. The optional filesystem argument is a fault-test seam, not
// a second production backend. No error object escapes or enters the queue.
export class LocalDiagnosticSink {
  readonly ready: Promise<void>
  readonly profile: DiagnosticProfile
  private readonly fs: typeof filesystem
  private readonly identity: DiagnosticIdentity
  private readonly onFailure: (() => void) | undefined
  private readonly run = randomUUID()
  private readonly queue: DiagnosticQueue
  private directory = ''
  private logsRoot = ''
  private handle: Handle | null = null
  private ordinal = 0
  private segmentSize = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private draining: Promise<void> | null = null
  private ending: Promise<void> | null = null
  private state: 'starting' | 'ready' | 'failed' | 'closed' = 'starting'
  private failures = 0
  private tail: string[] = []
  private tailBytes = 0
  private inFlightBytes = 0
  private rotations = 0

  constructor(options: {
    userData: string
    profile: DiagnosticProfile
    identity: DiagnosticIdentity
    filesystem?: typeof filesystem
    onFailure?: () => void
  }) {
    this.profile = options.profile
    this.identity = diagnosticIdentity(options.identity)
    this.onFailure = options.onFailure
    this.fs = options.filesystem ?? filesystem
    this.queue = new DiagnosticQueue(this.profile, 'main')
    this.ready = this.initialize(options.userData).catch(() => this.fail())
  }

  private async directoryAt(path: string) {
    await this.fs.mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    const stat = await this.fs.lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('unsafe diagnostic directory')
  }

  private async checkDirectory() {
    for (const path of [this.logsRoot, this.directory]) {
      const stat = await this.fs.lstat(path)
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await this.fs.realpath(path)) !== path
      )
        throw new Error('unsafe diagnostic directory')
    }
  }

  private async openOwned(name: string, maximum: number): Promise<Handle> {
    if (!ownedNames.includes(name)) throw new Error('unknown diagnostic file')
    await this.checkDirectory()
    const path = join(this.directory, name)
    const before = await this.fs
      .lstat(path, { bigint: true })
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
    if (
      before &&
      (!before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1n ||
        before.size > maximum)
    )
      throw new Error('unsafe diagnostic file')
    const handle = await this.fs.open(
      path,
      constants.O_RDWR |
        constants.O_NOFOLLOW |
        (before ? 0 : constants.O_CREAT | constants.O_EXCL),
      0o600,
    )
    try {
      const stat = await handle.stat({ bigint: true })
      await this.checkDirectory()
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        stat.size > maximum ||
        (before && !sameFileIdentity(before, stat))
      )
        throw new Error('changed diagnostic file')
      if (stat.size) {
        const prefix = Buffer.alloc(Math.min(128, Number(stat.size)))
        await handle.read(prefix, 0, prefix.length, 0)
        if (!prefix.toString('utf8').startsWith(`{"kind":"${kind}"`))
          throw new Error('unowned diagnostic file')
      }
      return handle
    } catch (error) {
      await handle.close().catch(() => {})
      throw error
    }
  }

  private async readHeader(
    handle: Handle,
    maximum = 4096,
  ): Promise<Record<string, unknown> | null> {
    const buffer = Buffer.alloc(maximum)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.toString('utf8', 0, bytesRead)
    const end = text.indexOf('\n')
    if (end < 0) return null
    try {
      return JSON.parse(text.slice(0, end))
    } catch {
      return null
    }
  }

  private async initialize(userData: string) {
    const root = await this.fs.realpath(userData)
    this.logsRoot = join(root, 'logs')
    this.directory = join(this.logsRoot, this.profile)
    await this.directoryAt(this.logsRoot)
    await this.directoryAt(this.directory)
    let greatest = -1
    // Fixed filenames only. No directory scan, recursive deletion or user files.
    for (const name of ownedNames) {
      const maximum = name.startsWith('segment-')
        ? diagnosticPolicies[this.profile].segmentBytes
        : name === 'run-state.txt'
          ? diagnosticLimits.markerBytes
          : diagnosticLimits.summaryBytes
      const handle = await this.openOwned(name, maximum)
      try {
        const header = await this.readHeader(handle)
        if (
          name.startsWith('segment-') &&
          typeof header?.ordinal === 'number' &&
          Number.isSafeInteger(header.ordinal) &&
          header.ordinal >= 0 &&
          header.ordinal < Number.MAX_SAFE_INTEGER - 1
        )
          greatest = Math.max(greatest, header.ordinal)
        if (
          name === 'run-state.txt' &&
          (await handle.stat()).size &&
          header?.state !== 'clean'
        )
          this.enqueue(
            JSON.stringify({
              code: 'PREVIOUS_RUN_UNCONFIRMED',
              stackStatus: 'unavailable-native',
              role: 'main',
            }),
          )
      } finally {
        await handle.close()
      }
    }
    this.ordinal = greatest + 1
    await this.rotate(false)
    await this.writeSmall(
      'run-state.txt',
      { state: 'active' },
      diagnosticLimits.markerBytes,
    )
    this.state = 'ready'
    this.enqueue(
      JSON.stringify({
        code: 'RUN_STARTED',
        stackStatus: 'unavailable',
        role: 'main',
      }),
    )
    if (this.profile === 'debug')
      this.store({
        code: 'SINK_READY',
        stackStatus: 'unavailable',
        role: 'main',
      })
    this.schedule()
  }

  enqueue(wire: unknown): boolean {
    if (this.state === 'failed' || this.state === 'closed' || this.ending)
      return false
    const record = decodeDiagnostic(wire, this.profile)
    if (
      !record ||
      (this.profile === 'release' &&
        diagnosticEvents[record.code].severity === 'debug')
    )
      return false
    const accepted = this.store(record)
    if (this.state === 'ready') this.schedule()
    return accepted
  }

  private store(
    record: SafeDiagnostic,
    critical = diagnosticEvents[record.code].critical,
  ) {
    const owned = { ...record, time: record.time ?? Date.now() }
    const accepted = this.queue.push(JSON.stringify(owned), critical)
    if (accepted) this.remember(this.line(owned))
    return accepted
  }

  private schedule() {
    if (this.draining || this.state !== 'ready' || !this.queue.size.records)
      return
    if (
      this.queue.size.records >= diagnosticLimits.batchRecords ||
      this.queue.size.bytes >= diagnosticLimits.batchBytes
    ) {
      void this.flush()
      return
    }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, diagnosticLimits.flushMs)
    this.timer.unref()
  }

  private async writeComplete(handle: Handle, data: Buffer, position: number) {
    let written = 0
    while (written < data.length) {
      const result = await handle.write(
        data,
        written,
        data.length - written,
        position + written,
      )
      if (
        !Number.isInteger(result.bytesWritten) ||
        result.bytesWritten <= 0 ||
        result.bytesWritten > data.length - written
      )
        throw new Error('incomplete diagnostic write')
      written += result.bytesWritten
    }
  }

  private header(extra: Record<string, unknown> = {}) {
    return {
      kind,
      schema: 1,
      run: this.run,
      profile: this.profile,
      identity: this.identity,
      ...extra,
    }
  }

  private async rotate(advance = true) {
    if (this.handle) {
      await this.handle.close()
      this.handle = null
    }
    if (advance) {
      this.ordinal++
      this.rotations++
    }
    const maximum = diagnosticPolicies[this.profile].segmentBytes
    const handle = await this.openOwned(
      `segment-${this.ordinal % diagnosticLimits.segments}.log`,
      maximum,
    )
    this.handle = handle
    await handle.truncate(0)
    const header = Buffer.from(
      `${JSON.stringify(this.header({ ordinal: this.ordinal }))}\n`,
    )
    if (header.length >= maximum) throw new Error('diagnostic header limit')
    await this.writeComplete(handle, header, 0)
    this.segmentSize = header.length
  }

  private async renameSmall(
    name: string,
    maximum: number,
    signal?: AbortSignal,
  ) {
    const verify = async () => {
      const staged = await this.openOwned(
        'incident-next.txt',
        diagnosticLimits.summaryBytes,
      )
      try {
        if (!(await staged.stat()).size)
          throw new Error('missing diagnostic summary')
      } finally {
        await staged.close()
      }
      const target = await this.openOwned(name, maximum)
      await target.close()
      await this.checkDirectory()
    }
    await verify()
    await retryRename(
      () =>
        this.fs.rename(
          join(this.directory, 'incident-next.txt'),
          join(this.directory, name),
        ),
      verify,
      signal,
    )
  }

  private async writeSmall(
    name: string,
    fields: Record<string, unknown>,
    maximum: number,
    contentMaximum = maximum,
  ) {
    const data = Buffer.from(`${JSON.stringify(this.header(fields))}\n`)
    if (data.length > contentMaximum)
      throw new Error('diagnostic summary limit')
    const handle = await this.openOwned(name, maximum)
    try {
      await handle.truncate(0)
      await this.writeComplete(handle, data, 0)
    } finally {
      await handle.close()
    }
  }

  private line(record: SafeDiagnostic) {
    return `${JSON.stringify({ schema: 1, run: this.run, profile: this.profile, time: record.time ?? Date.now(), severity: diagnosticEvents[record.code].severity, label: record.code.toLowerCase().replaceAll('_', ' '), ...record })}\n`
  }

  private remember(line: string) {
    // Reserve header/version capacity inside the 64 KiB summary budget.
    const maximum = diagnosticLimits.summaryBytes - 4096
    while (this.tailBytes + line.length > maximum && this.tail.length)
      this.tailBytes -= this.tail.shift()?.length ?? 0
    this.tail.push(line)
    this.tailBytes += line.length
  }

  private async drain() {
    while (this.state === 'ready' && this.queue.size.records) {
      const wires = this.queue.take()
      let pending = ''
      let incident = false
      const write = async () => {
        if (!pending || !this.handle) return
        const buffer = Buffer.from(pending)
        this.inFlightBytes = buffer.length
        try {
          await this.writeComplete(this.handle, buffer, this.segmentSize)
          this.segmentSize += buffer.length
        } finally {
          this.inFlightBytes = 0
        }
        pending = ''
      }
      for (const wire of wires) {
        const record = decodeDiagnostic(wire, this.profile)
        if (!record) continue
        let line = this.line(record)
        if (line.length > diagnosticPolicies[this.profile].recordBytes)
          line = this.line({
            code: 'DIAGNOSTICS_DROPPED',
            count: 1,
            stackStatus: 'truncated',
          })
        if (
          this.segmentSize + pending.length + line.length >
          diagnosticPolicies[this.profile].segmentBytes
        ) {
          await write()
          await this.rotate()
        }
        if (pending.length + line.length > diagnosticLimits.batchBytes)
          await write()
        pending += line
        incident ||=
          diagnosticEvents[record.code].severity === 'error' ||
          diagnosticEvents[record.code].critical
      }
      await write()
      if (incident) {
        // Separate fixed temporary and summary slots; both count toward quota.
        const fields = { records: this.tail.map((line) => JSON.parse(line)) }
        await this.writeSmall(
          'incident-next.txt',
          fields,
          diagnosticLimits.summaryBytes,
        )
        await this.renameSmall(
          'last-incident.txt',
          diagnosticLimits.summaryBytes,
        )
      }
      const dropped = this.queue.takeDropped()
      if (dropped)
        this.store(
          {
            code: 'DIAGNOSTICS_DROPPED',
            stackStatus: 'unavailable',
            count: dropped,
            role: 'main',
          },
          true,
        )
    }
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.draining) return this.draining
    if (this.state !== 'ready') return Promise.resolve()
    this.draining = this.drain()
      .catch(() => this.fail())
      .finally(() => {
        this.draining = null
        this.schedule()
      })
    return this.draining
  }

  private async fail() {
    this.state = 'failed'
    try {
      this.onFailure?.()
    } catch {
      /* Observers cannot interrupt sink retirement. */
    }
    this.failures = incrementDiagnosticCount(this.failures)
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.queue.clear()
    if (this.profile === 'debug')
      this.remember(
        this.line({
          code: 'SINK_UNAVAILABLE',
          stackStatus: 'unavailable',
          role: 'main',
        }),
      )
    const handle = this.handle
    this.handle = null
    try {
      await handle?.close()
    } catch {
      /* The sink is already retired. */
    }
  }

  // Called after final shutdown confirmation. An expired finish must not commit
  // a clean marker if pending diagnostic I/O later resumes.
  finish(signal?: AbortSignal): Promise<void> {
    this.ending ??= this.closeCleanly(signal)
    return this.ending
  }

  private async closeCleanly(signal?: AbortSignal) {
    await this.ready
    if (this.state !== 'ready' || signal?.aborted) return
    this.store({
      code: 'RUN_ENDED',
      stackStatus: 'unavailable',
      role: 'main',
    })
    await this.flush()
    if (this.state !== 'ready' || signal?.aborted) return
    try {
      const handle = this.handle
      this.handle = null
      await handle?.close()
      await this.writeSmall(
        'incident-next.txt',
        { state: 'clean' },
        diagnosticLimits.summaryBytes,
        diagnosticLimits.markerBytes,
      )
      await this.renameSmall(
        'run-state.txt',
        diagnosticLimits.markerBytes,
        signal,
      )
    } catch {
      await this.fail()
      return
    }
    this.state = 'closed'
  }

  // Only the native save dialog supplies this explicit destination. Refuse a
  // symlink/hardlink leaf before truncating; never inspect document contents.
  async saveReport(path: string): Promise<void> {
    const data = Buffer.from(this.report(), 'utf8')
    if (data.length > diagnosticLimits.summaryBytes)
      throw new Error('diagnostic report limit')
    const before = await this.fs
      .lstat(path, { bigint: true })
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
    if (
      before &&
      (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
    )
      throw new Error('unsafe report destination')
    const handle = await this.fs.open(
      path,
      constants.O_WRONLY |
        constants.O_NOFOLLOW |
        (before ? 0 : constants.O_CREAT | constants.O_EXCL),
      0o600,
    )
    try {
      const stat = await handle.stat({ bigint: true })
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        (before && !sameFileIdentity(before, stat))
      )
        throw new Error('changed report destination')
      await handle.truncate(0)
      await this.writeComplete(handle, data, 0)
    } finally {
      await handle.close()
    }
  }

  // Explicit report action uses only already-projected memory, never app state.
  report(): string {
    return `${JSON.stringify(this.header({ status: this.state, failures: this.failures }))}\n${this.tail.join('')}`
  }
  get status() {
    return {
      state: this.state,
      failures: this.failures,
      queued: this.queue.size,
      inFlightBytes: this.inFlightBytes,
      retainedBytes: this.tailBytes,
      rotations: this.rotations,
      timer: !!this.timer,
    }
  }
  get location() {
    return this.state === 'ready' || this.state === 'closed'
      ? this.directory
      : null
  }
}
