import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const findWorkDumpFailed = 'find-work-dump-failed'

// Serialized into the existing renderer/worker evaluations; no closure dependencies.
export function createFindTrace(domain) {
  const rows = []
  let sequence = 0,
    dropped = 0,
    faults = 0,
    reset = 0
  const scalar = (value) => {
    if (typeof value !== 'string') return value ?? null
    if (value.length > 128) dropped++
    return value.slice(0, 128)
  }
  const list = (value) => {
    if (!Array.isArray(value)) return value === null ? null : undefined
    if (value.length > 64) dropped++
    return value.slice(0, 64).map(scalar)
  }
  const counters = () => ({
    lower: globalThis.findFoldWork?.lower ?? globalThis.findWork?.lower ?? 0,
    normalized:
      globalThis.findFoldWork?.normalized ??
      globalThis.findWork?.normalized ??
      0,
  })
  return {
    record(event, envelope, details = {}) {
      try {
        if (rows.length === 4096) {
          dropped++
          return
        }
        const message = envelope?.message ?? envelope ?? {}
        const config = message.config
        const row = {
          sequence: ++sequence,
          event,
          domain,
          reset,
          owner: scalar(envelope?.owner),
          epoch: scalar(message.epoch),
          id: message.id ?? null,
          version:
            message.version ??
            message.operation?.contentVersion ??
            message.head?.contentVersion ??
            null,
          baseVersion:
            message.operation?.baseVersion ?? message.baseVersion ?? null,
          streamId: scalar(
            message.head?.streamId ??
              message.chunk?.streamId ??
              message.request?.streamId,
          ),
          transferSequence:
            message.chunk?.sequence ?? message.request?.sequence ?? null,
          transferDone: message.chunk?.done ?? null,
          sourceLength: message.head?.length ?? null,
          type: scalar(message.type),
          mode: scalar(message.mode),
          fixtureQuery:
            message.query === 'NEEDLE' || message.query === 'needle',
          prefix: message.prefix ?? null,
          from: message.from ?? null,
          to: message.to ?? null,
          highlights: !!message.highlights,
          viewport: message.viewport
            ? {
                from: message.viewport.from,
                to: message.viewport.to,
                limit: message.viewport.limit ?? null,
              }
            : null,
          config: config
            ? {
                schema: config.schema,
                prefix: config.prefix,
                chunkSize: config.chunkSize,
                groupSize: config.groupSize,
                giantBlock: config.giantBlock,
                syntax: list(config.syntax),
                flavors: list(config.flavors),
                literal: list(config.literal),
                opaque: list(config.opaque),
                textFeatures: list(config.textFeatures),
                textSyntax: list(config.textSyntax),
              }
            : null,
          current: message.location?.current ?? null,
          total: message.location?.total ?? null,
          highlightCount:
            message.highlights?.matches?.length ??
            message.highlightStarts?.length ??
            null,
          next: message.highlights?.next ?? null,
          errorStage: message.type === 'error' ? scalar(message.stage) : null,
          errorReason: message.type === 'error' ? scalar(message.reason) : null,
          counters: counters(),
          ...details,
        }
        row.stampMs = performance.now()
        rows.push(row)
      } catch {
        faults++
      }
    },
    reset() {
      reset++
    },
    fault() {
      faults++
    },
    snapshot() {
      try {
        return structuredClone({
          domain,
          timeOrigin: performance.timeOrigin,
          dropped,
          faults,
          rows,
        })
      } catch {
        faults++
        return null
      }
    },
  }
}

export function findWorkDiagnostic() {
  const receipts = []
  const keys = []
  let faults = 0,
    expectedWorkers = 0
  return {
    source: createFindTrace.toString(),
    expectWorkers(count) {
      expectedWorkers = count
    },
    capture(label, value) {
      try {
        if (receipts.length === 16) {
          faults++
          return
        }
        receipts.push({ label, value })
      } catch {
        faults++
      }
    },
    key(key, expected) {
      keys.push({ key, expected })
    },
    async finish(originalPassed, report = (marker) => console.error(marker)) {
      let complete = false
      try {
        const domains = receipts
          .flatMap(({ value }) => (Array.isArray(value) ? value : [value]))
          .filter(Boolean)
        const latest = new Map(domains.map((value) => [value.domain, value]))
        const renderer = latest.get('renderer')
        const workers = [...latest.values()].filter((value) =>
          value.domain?.startsWith('worker-'),
        )
        const missing =
          Number(!renderer) +
          Math.abs(expectedWorkers - workers.length) +
          Number(!expectedWorkers) +
          receipts.filter((row) => !row.value).length +
          Number(!receipts.some((row) => row.label === 'renderer-start')) +
          Number(!receipts.some((row) => row.label === 'renderer-stop')) +
          Number(!receipts.some((row) => row.label === 'worker-reset')) +
          Number(!receipts.some((row) => row.label === 'worker-read')) +
          Number(keys.length !== 4)
        const dropped = [...latest.values()].reduce(
          (sum, row) => sum + row.dropped,
          0,
        )
        const traceFaults =
          faults +
          [...latest.values()].reduce((sum, row) => sum + row.faults, 0)
        complete =
          missing === 0 &&
          dropped === 0 &&
          traceFaults === 0 &&
          keys.length === 4
        const payload = {
          schema: 1,
          originalPassed,
          complete,
          missing,
          dropped,
          faults: traceFaults,
          quality: complete,
          expectedWorkers,
          keys,
          receipts,
          receiveBoundary: 'listener-after-existing-service-handler',
          attribution:
            'physical cumulative counters include interleaving; per-request deltas are not attributed cost',
          correlation:
            'renderer tickets link enqueue/hold/release/send; worker domains require unique observed epoch/id/version sequences',
          classification: 'root unknown; healthy pass is miss; no chase',
        }
        // Only after the original outcome. Bound diagnostic I/O; never replace an original throw.
        const controller = new AbortController()
        let timer
        try {
          await Promise.race([
            (async () => {
              const path = join(
                process.env.HIBI_FIND_TRACE_DIR ?? '.scratch',
                'find-work.json',
              )
              await writeFile(
                path + '.tmp',
                JSON.stringify(payload, null, 2) + '\n',
                { signal: controller.signal },
              )
              controller.signal.throwIfAborted()
              await rename(path + '.tmp', path)
              controller.signal.throwIfAborted()
            })(),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                controller.abort()
                reject(new Error('diagnostic write timeout'))
              }, 2000)
            }),
          ])
        } finally {
          clearTimeout(timer)
          controller.abort()
        }
      } catch {
        complete = false
        try {
          report(findWorkDumpFailed)
        } catch {
          try {
            console.error(findWorkDumpFailed)
          } catch {}
        }
      }
      if (originalPassed && !complete)
        throw new Error(
          'find diagnostic incomplete; original assertions passed',
        )
    },
  }
}
