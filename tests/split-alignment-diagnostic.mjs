import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/** Never merge: installed within the target's existing successful document check. */
function installAlignmentTrace() {
  if (window.__splitAlign) return
  const ids = new WeakMap()
  let sequence = 0
  const id = (value) => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function'))
      return null
    if (!ids.has(value)) ids.set(value, ++sequence)
    return ids.get(value)
  }
  const trace = {
    active: true,
    cap: 4096,
    dropped: 0,
    faults: 0,
    events: [],
    lastOracle: null,
    record(event, read = () => ({})) {
      if (!trace.active) return
      try {
        if (trace.events.length >= trace.cap) {
          trace.dropped++
          return
        }
        const data = {}
        for (const [key, value] of Object.entries(read())) {
          if (['from', 'to', 'view'].includes(key)) {
            data[key] = value && {
              id: id(value),
              doc: id(value.state.doc),
              length: value.state.doc.length,
              anchor: value.state.selection.main.anchor,
              head: value.state.selection.main.head,
              connected: value.dom.isConnected,
            }
          } else if (
            ['first', 'second', 'leader', 'target', 'content', 'cell'].includes(
              key,
            )
          ) {
            data[key] = value && { id: id(value), connected: value.isConnected }
          } else if (
            ['point', 'destination', 'drawn', 'bounds', 'block'].includes(key)
          ) {
            data[key] =
              value &&
              Object.fromEntries(
                ['top', 'bottom', 'left', 'right', 'height', 'from', 'to']
                  .filter((field) => typeof value[field] === 'number')
                  .map((field) => [field, value[field]]),
              )
          } else data[key] = value
        }
        const row = Object.freeze({
          event,
          ...data,
          stampMs: performance.now(),
        })
        trace.events.push(row)
        if (event === 'oracle') trace.lastOracle = row
      } catch {
        trace.faults++
      }
    },
    snapshot() {
      return {
        timeOrigin: performance.timeOrigin,
        sealStampMs: performance.now(),
        cap: trace.cap,
        dropped: trace.dropped,
        faults: trace.faults,
        events: trace.events,
        lastOracle: trace.lastOracle,
      }
    },
  }
  window.__splitAlign = trace
  trace.record('armed')
}

// Exactly the original document query/await/equality, then metadata installation.
export const alignmentDocumentMatches = Function(`return async (expected) => {
  const matches = (await window.hibi.getDocument()).markdown === expected;
  if (matches) (${installAlignmentTrace.toString()})();
  return matches;
}`)()

/** Original result is already decided. Timeout helper diagnostics may precede this seal. */
export async function finishAlignmentTrace(t, page, originalError, phase) {
  const path = resolve(
    process.env.HIBI_RELEASE_TRACE_DIR || '.scratch/split-align',
    'alignment.json',
  )
  const result = {
    complete: false,
    missing: 1,
    originalPassed: !originalError,
    phase,
    alignmentTimeout:
      phase === 'alignment' &&
      !!originalError?.message?.startsWith('async condition did not settle') &&
      originalError.message.includes(': linedUp'),
    originalError: originalError && {
      name: originalError.name,
      code: originalError.code,
      operator: originalError.operator,
      frames: originalError.stack
        ?.split('\n')
        .filter((line) => /^\s+at /.test(line)),
    },
    note: 'lastOracle is sampled in the original predicate; seal can follow built-in timeout diagnostics',
  }
  const controller = new AbortController()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('alignment post-outcome dump exceeded 1000ms')
      error.name = 'DiagnosticTimeout'
      controller.abort(error)
      reject(error)
    }, 1000)
  })
  try {
    await Promise.race([
      deadline,
      (async () => {
        try {
          const snapshot = await page?.evaluate(() => {
            const trace = window.__splitAlign
            if (!trace) return null
            trace.active = false
            try {
              return trace.snapshot()
            } finally {
              delete window.__splitAlign
            }
          })
          controller.signal.throwIfAborted()
          if (snapshot)
            Object.assign(result, snapshot, { complete: true, missing: 0 })
        } catch (error) {
          controller.signal.throwIfAborted()
          result.dumpError = error.name
        }
        result.quality =
          result.complete &&
          result.missing === 0 &&
          result.dropped === 0 &&
          result.faults === 0 &&
          !!result.events?.some((row) => row.event === 'bind') &&
          !!result.events?.some((row) => row.event === 'lead') &&
          !!result.lastOracle
        await mkdir(dirname(path), { recursive: true })
        controller.signal.throwIfAborted()
        await writeFile(path, JSON.stringify(result, null, 2) + '\n', {
          signal: controller.signal,
        })
        controller.signal.throwIfAborted()
        t.diagnostic(
          `alignment trace: events=${result.events?.length ?? 0} dropped=${result.dropped ?? 0} faults=${result.faults ?? 0} quality=${result.quality}`,
        )
        if (!originalError)
          assert.ok(result.quality, 'incomplete alignment diagnostic')
      })(),
    ])
  } catch (error) {
    if (!originalError) throw error
    try {
      t.diagnostic(
        `alignment dump failed: ${error.name}; original error retained`,
      )
    } catch {
      // Even a closed diagnostic reporter must not replace the primary error.
    }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
