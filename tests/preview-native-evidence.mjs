// never merge: passive evidence for one original split-preview assertion.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const targetTitle =
  'hidden preview edits copy only current input and retain selection'
let active
const fault = (message) => {
  if (active?.faults.length < 8)
    active.faults.push(String(message).slice(0, 200))
}
export function beginPreviewEvidence(t) {
  if (!process.env.PREVIEW_EVIDENCE_DIR) return
  const root = resolve(process.env.PREVIEW_EVIDENCE_DIR)
  const folder = join(root, 'target')
  active = {
    folder,
    started: performance.now(),
    armed: false,
    reads: 0,
    pollReads: 0,
    faults: [],
    first: null,
    last: null,
  }
  try {
    assert.equal(root, join(process.env.RUNNER_TEMP, 'preview-evidence'))
    mkdirSync(folder)
    const fd = openSync(join(folder, 'partial.json'), 'wx', 0o600)
    try {
      writeFileSync(
        fd,
        JSON.stringify({
          complete: false,
          phase: 'started',
          title: targetTitle,
          pid: process.pid,
        }) + '\n',
      )
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    active.initialized = true
  } catch (error) {
    fault('initial stub: ' + error.message)
    marker(t, error.message)
  }
}

export const previewEvidenceArmed = () => !!active?.armed
export function armPreviewEvidence() {
  if (active) active.armed = true
}

// Runs inside the preceding ORIGINAL full-document equality RPC; return unchanged.
export function rememberPreviewDocument(element, armed) {
  const view = element.cmTile.root.view
  const text = view.state.doc.toString()
  if (armed && element.closest('.rich-pane')) {
    const match = /^omega[^\n]*$/m.exec(text)
    window.previewNativeEvidence = {
      view,
      element,
      doc: view.state.doc,
      selection: view.state.selection,
      from: match?.index ?? -1,
      tail: match?.[0]?.slice(0, 65) ?? '',
    }
  }
  return text
}

// This replaces only the original innerText RPC, and reads that getter FIRST.
export function readPreview(element) {
  const text = element.innerText
  try {
    const saved = window.previewNativeEvidence
    const view = element.cmTile.root.view
    const doc = view.state.doc,
      range = view.state.selection.main
    const from = saved?.from ?? -1,
      tail = saved?.tail ?? ''
    const to = from + tail.length
    return {
      text,
      sample: {
        hasOmega: text.includes('omega'),
        tail,
        omegaFrom: from,
        omegaTo: to,
        docLength: doc.length,
        sourceLineMatches:
          tail === 'omega' && from >= 0 && doc.sliceString(from, to) === tail,
        sameDocument: doc === saved?.doc,
        sameView: view === saved?.view,
        sameElement: element === saved?.element,
        sameSelection: view.state.selection === saved?.selection,
        viewport: { ...view.viewport },
        visibleRanges: view.visibleRanges.slice(0, 8).map((r) => ({ ...r })),
        rangesTruncated: view.visibleRanges.length > 8,
        selection: {
          anchor: range.anchor,
          head: range.head,
          text: doc.sliceString(
            range.from,
            Math.min(range.to, range.from + 64),
          ),
          truncated: range.to - range.from > 64,
        },
      },
      fault: null,
    }
  } catch (error) {
    return { text, sample: null, fault: String(error).slice(0, 200) }
  }
}
export function observePreviewRich(locator) {
  if (!active) return locator
  active.locator = locator
  return new Proxy(locator, {
    get(target, key) {
      if (key === 'innerText')
        return async (...args) => {
          if (!active?.armed) return target.innerText(...args)
          const value = await target.evaluate(readPreview)
          active.reads++
          if (value.fault || !value.sample)
            fault(value.fault || 'missing first metadata')
          active.first ??= value.sample
          return value.text // ORIGINAL assertion receives original rendered text.
        }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
export function eligible(sample) {
  if (
    !sample ||
    sample.tail !== 'omega' ||
    !sample.sourceLineMatches ||
    !sample.sameDocument ||
    !sample.sameView ||
    !sample.sameElement ||
    !sample.sameSelection ||
    sample.rangesTruncated !== false ||
    sample.selection?.truncated !== false ||
    sample.selection?.text !== 'beta'
  )
    return false
  const {
    omegaFrom: a,
    omegaTo: b,
    docLength: n,
    viewport: v,
    visibleRanges: ranges,
  } = sample
  return (
    [
      a,
      b,
      n,
      v?.from,
      v?.to,
      sample.selection.anchor,
      sample.selection.head,
    ].every(Number.isSafeInteger) &&
    0 <= v.from &&
    v.from <= a &&
    a < b &&
    b <= v.to &&
    v.to <= n &&
    0 <= sample.selection.anchor &&
    sample.selection.anchor <= n &&
    0 <= sample.selection.head &&
    sample.selection.head <= n &&
    Array.isArray(ranges) &&
    ranges.length > 0 &&
    ranges.length <= 8 &&
    ranges.every(
      (r) =>
        Number.isSafeInteger(r.from) &&
        Number.isSafeInteger(r.to) &&
        0 <= r.from &&
        r.from <= r.to &&
        r.to <= n,
    ) &&
    ranges.some((r) => r.from <= a && r.to >= b)
  )
}
const matching = (error) =>
  error?.code === 'ERR_ASSERTION' &&
  error.message === 'omega' &&
  error.actual === false &&
  error.expected === true
const errorData = (error) =>
  error
    ? {
        name: error.name,
        code: error.code,
        message: String(error.message).slice(0, 2000),
        actual: typeof error.actual === 'boolean' ? error.actual : null,
        expected: typeof error.expected === 'boolean' ? error.expected : null,
        stack: String(error.stack ?? '').slice(0, 2000),
      }
    : null
function marker(t, message) {
  const text = 'preview-evidence-dump-failed: ' + String(message).slice(0, 200)
  try {
    t.diagnostic(text)
  } catch {}
  try {
    writeSync(2, text + '\n')
  } catch {}
}
export async function finishPreviewEvidence(t, originalError, poll) {
  if (!active) return
  const state = active
  let observed = false,
    diagnosticAssertion = null,
    observing = false
  try {
    // Optional diagnosis must leave original90s case its 7s poll + 1s dump + 1s margin.
    if (matching(originalError) && performance.now() - state.started >= 81000)
      fault(
        'insufficient original case budget for optional post-outcome observation',
      )
    if (
      matching(originalError) &&
      state.reads === 1 &&
      eligible(state.first) &&
      state.first.hasOmega === false &&
      !state.faults.length
    ) {
      observing = true
      let lastText = ''
      try {
        // Same host poll/default7000ms and same semantic innerText.includes('omega').
        await poll(
          {
            evaluate: async () => {
              const value = await state.locator.evaluate(readPreview)
              if (!observing) return false
              state.pollReads++
              if (state.pollReads > 256)
                throw new Error('post-outcome read bound')
              if (
                value.fault ||
                !eligible(value.sample) ||
                JSON.stringify(value.sample.selection) !==
                  JSON.stringify(state.first.selection)
              )
                throw new Error(
                  'post-outcome identity/range/selection metadata changed or faulty',
                )
              state.last = value.sample
              lastText = value.text
              return value.text.includes('omega')
            },
          },
          (tail) =>
            document
              .querySelector('.rich-pane .cm-content')
              ?.innerText.includes(tail),
          'omega',
        )
        observed = true
      } catch (error) {
        fault('post-outcome observation: ' + error.message)
      } finally {
        observing = false
      }
      try {
        assert.ok(lastText.includes('omega'), 'omega')
        diagnosticAssertion = { passed: true, error: null }
      } catch (error) {
        diagnosticAssertion = { passed: false, error: errorData(error) }
      }
    }
    const good =
      state.initialized &&
      state.reads === 1 &&
      eligible(state.first) &&
      !state.faults.length
    const miss = good && !originalError && state.first.hasOmega === true
    const recovered =
      good &&
      matching(originalError) &&
      state.first.hasOmega === false &&
      observed &&
      eligible(state.last) &&
      state.last.hasOmega === true &&
      diagnosticAssertion?.passed === true
    const receipt = {
      schema: 1,
      complete: miss || recovered,
      title: targetTitle,
      classification: miss
        ? 'MISS'
        : recovered
          ? 'ELIGIBLE_RED_RECOVERED'
          : 'INCOMPLETE',
      originalPassed: !originalError,
      originalError: errorData(originalError),
      reads: state.reads,
      pollReads: state.pollReads,
      faults: [...state.faults],
      first: state.first,
      last: state.last,
      observed,
      diagnosticAssertion,
      dropped: 0,
      missing: !state.first,
    }
    if (!state.initialized) throw new Error('initial stub unavailable')
    const bytes = JSON.stringify(receipt) + '\n'
    if (Buffer.byteLength(bytes) > 16384) throw new Error('receipt size bound')
    const controller = new AbortController()
    let timer
    const operation = (async () => {
      await writeFile(join(state.folder, 'receipt.tmp'), bytes, {
        flag: 'wx',
        signal: controller.signal,
      })
      if (controller.signal.aborted)
        throw new Error('dump aborted before rename')
      await rename(
        join(state.folder, 'receipt.tmp'),
        join(state.folder, 'receipt.json'),
      )
      if (controller.signal.aborted)
        throw new Error('dump aborted after rename')
    })()
    try {
      await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('dump deadline'))
          }, 1000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    const sha = createHash('sha256').update(bytes).digest('hex')
    try {
      t.diagnostic('preview-evidence-complete ' + sha)
    } catch (error) {
      throw new Error('reporter closed: ' + error.message)
    }
  } catch (error) {
    marker(t, error.message)
    if (!originalError) throw error
  } finally {
    active = null
  }
}
