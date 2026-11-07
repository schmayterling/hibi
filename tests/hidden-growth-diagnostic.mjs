import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/** Never merge: target-owned metadata, with no retained editor or source objects. */
function installGrowthTrace() {
  if (window.__hiddenGrowth) return
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
          if (['view', 'doc', 'bridge', 'source', 'host', 'pane'].includes(key))
            data[key] = id(value)
          else data[key] = value
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
  window.__hiddenGrowth = trace
  trace.record('armed')
}

// The existing document RPC awaits and reads the same three fields, then arms.
export const growthBefore = Function(`return async () => {
  const document = await window.hibi.getDocument();
  const result = {
    tabId: document.tabId,
    contentVersion: document.contentVersion,
    units: document.markdown.length,
  };
  (${installGrowthTrace.toString()})();
  window.__hiddenGrowth.record('before', () => result);
  return result;
}`)()

export async function growthAfter() {
  const document = await window.hibi.getDocument()
  const result = {
    tabId: document.tabId,
    contentVersion: document.contentVersion,
    units: document.markdown.length,
  }
  window.__hiddenGrowth?.record('after', () => result)
  return result
}

/** Original query/read order and short-circuit result; only evaluated operands. */
export function growthShown(units) {
  const pane = document.querySelector('.source-pane')
  const content = pane?.querySelector('.cm-content[contenteditable="true"]')
  const view = content?.cmTile?.root?.view
  const doc = view?.state.doc
  const length = view == null ? undefined : doc.length
  let mode, animations
  let result = length > units
  if (result) {
    mode = pane.closest('.mode-markdown')
    result = mode !== null
  }
  if (result) {
    animations = pane.getAnimations()
    result = !animations.length
  }
  window.__hiddenGrowth?.record('oracle', () => ({
    pane,
    view,
    doc,
    threshold: units,
    editableMatched: !!content,
    length: length ?? null,
    modeEvaluated: length > units,
    modeMatches: mode === undefined ? null : mode !== null,
    animationsEvaluated: animations !== undefined,
    animationCount: animations?.length ?? null,
    result,
  }))
  return result
}

/** Original result is already decided. Timeout helper diagnostics may precede this seal. */
export async function finishGrowthTrace(t, page, originalError, phase) {
  const path = resolve(
    process.env.HIBI_RELEASE_TRACE_DIR || '.scratch/hidden-growth',
    'growth.json',
  )
  const result = {
    complete: false,
    missing: 1,
    originalPassed: !originalError,
    phase,
    sourceShownTimeout:
      phase === 'source-shown' &&
      !!originalError?.message?.startsWith('async condition did not settle'),
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
      const error = new Error('growth post-outcome dump exceeded 1000ms')
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
            const trace = window.__hiddenGrowth
            if (!trace) return null
            trace.active = false
            try {
              return trace.snapshot()
            } finally {
              delete window.__hiddenGrowth
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
          !!result.events?.some((row) => row.event === 'before') &&
          !!result.events?.some((row) => row.event === 'panes') &&
          !!result.lastOracle
        await mkdir(dirname(path), { recursive: true })
        controller.signal.throwIfAborted()
        await writeFile(path, JSON.stringify(result, null, 2) + '\n', {
          signal: controller.signal,
        })
        controller.signal.throwIfAborted()
        t.diagnostic(
          `growth trace: events=${result.events?.length ?? 0} dropped=${result.dropped ?? 0} faults=${result.faults ?? 0} quality=${result.quality}`,
        )
        if (!originalError)
          assert.ok(result.quality, 'incomplete growth diagnostic')
      })(),
    ])
  } catch (error) {
    if (!originalError) throw error
    try {
      t.diagnostic(`growth dump failed: ${error.name}; original error retained`)
    } catch {
      try {
        process.stderr.write('growth dump failed: original error retained\n')
      } catch {
        // Even both closed reporters must not replace the primary error.
      }
    }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
