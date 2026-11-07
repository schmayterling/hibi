import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * Never-merge metadata only: fields the view already holds, the fixture's
 * public probe and coverage, and element counts. No layout read, and nothing
 * that runs a pending measure, such as the view's coordsAtPos, coordsForChar,
 * posAtCoords, lineBlockAtHeight or elementAtHeight.
 */
function record(stage) {
  window.__initialH1Trace ??= {
    cap: 256,
    polls: 0,
    dropped: 0,
    faults: 0,
    mount: null,
    first: null,
    last: null,
    changes: [],
    signature: null,
    ids: new WeakMap(),
    next: 0,
  }
  const trace = window.__initialH1Trace
  try {
    const id = (value) => {
      if (!trace.ids.has(value)) trace.ids.set(value, ++trace.next)
      return trace.ids.get(value)
    }
    const span = ({ from, to }) => ({ from, to })
    const preview = window.livePreview
    const view = preview.view()
    const viewState = view.viewState
    const { viewport } = viewState
    const covered = preview.covered(viewport.from, viewport.to)
    const h1 = document.querySelectorAll('.hibi-lp-h1').length
    const snapshot = {
      stage,
      stampMs: performance.now(),
      wallMs: Date.now(),
      view: id(view),
      doc: id(view.state.doc),
      length: view.state.doc.length,
      viewport: span(viewport),
      visibleRanges: viewState.visibleRanges.map(span),
      inView: viewState.inView,
      mapHeight: viewState.heightMap.height,
      scale: viewState.scaler.scale,
      scalerViewports: viewState.scaler.viewports?.length ?? null,
      pixelViewport: { ...viewState.pixelViewport },
      editorWidth: viewState.editorWidth,
      measureScheduled: view.measureScheduled,
      updateState: view.updateState,
      lastUpdate: view.docView.lastUpdate,
      probe: { ...preview.probe },
      settling: preview.settling(),
      covered,
      h1,
      lines: document.querySelectorAll('.cm-line').length,
    }
    if (stage === 'mount') {
      trace.mount = snapshot
      return
    }
    trace.polls++
    trace.first ??= snapshot
    trace.last = snapshot
    const { from, to } = viewport
    const signature = `${from}:${to}:${covered}:${h1}:${snapshot.mapHeight}:${snapshot.inView}`
    if (signature === trace.signature) return
    trace.signature = signature
    if (trace.changes.length >= trace.cap) trace.dropped++
    else trace.changes.push(snapshot)
  } catch {
    trace.faults++
  }
}

/** Before the mount RPC's own return, in its body: adds no RPC, await or frame. */
export function atMountReturn(callback) {
  const source = callback.toString()
  const original = 'return window.livePreview.view().state.doc.length'
  if (source.split(original).length !== 2)
    throw new Error('expected one mount return')
  const traced = source.replace(
    original,
    () => `const length = window.livePreview.view().state.doc.length;
    (${record.toString()})('mount');
    return length`,
  )
  return Function(`return ${traced}`)()
}

/** The wait's own predicate reads first and its result is returned as it was. */
export function polled(callback) {
  return Function(`return (...args) => {
    const result = (${callback.toString()})(...args);
    (${record.toString()})('poll');
    return result;
  }`)()
}

/** Hashes the served fixture; a failed pin leaves its phase missing, so incomplete. */
export function pinFixture(phase, bundle) {
  const directory = process.env.HIBI_RELEASE_TRACE_DIR
  if (!directory) return
  try {
    execFileSync(
      'python3',
      [join(directory, 'pins.py'), phase, bundle, 'live-preview'],
      { stdio: 'inherit' },
    )
  } catch (error) {
    console.log(`fixture pin ${phase} failed: ${error.message}`)
  }
}

/** Runs once, after the journey's outcome; geometry only after a failure. */
function afterJourney(failed) {
  const trace = window.__initialH1Trace
  const original = trace && {
    timeOrigin: performance.timeOrigin,
    cap: trace.cap,
    polls: trace.polls,
    dropped: trace.dropped,
    faults: trace.faults,
    mount: trace.mount,
    first: trace.first,
    last: trace.last,
    changes: trace.changes.slice(),
  }
  const after = {}
  if (failed)
    try {
      const box = (element) => {
        if (!element) return null
        const { left, top, width, height } = element.getBoundingClientRect()
        return {
          left,
          top,
          width,
          height,
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        }
      }
      const view = window.livePreview.view()
      after.stampMs = performance.now()
      after.viewport = {
        from: view.viewState.viewport.from,
        to: view.viewState.viewport.to,
      }
      after.pane = box(document.querySelector('.rich-pane'))
      after.scroller = box(view.scrollDOM)
      after.content = box(view.contentDOM)
      after.window = { width: window.innerWidth, height: window.innerHeight }
    } catch (error) {
      after.dumpError = `${error.name}: ${error.message}`
    }
  return { original, after }
}

/** Never masks the journey's error; a poor trace cannot turn into a pass. */
export async function tracedJourney(t, page, journey) {
  let originalError
  const progress = { firstWait: 'not started' }
  try {
    await journey(progress)
  } catch (error) {
    originalError = error
    throw error
  } finally {
    await finishTrace(t, page, originalError, progress)
  }
}

async function finishTrace(t, page, originalError, progress) {
  const path = resolve(
    process.env.HIBI_RELEASE_TRACE_DIR || '.scratch/release-intel',
    'initial-h1.json',
  )
  const result = {
    complete: false,
    missing: 2,
    originalPassed: !originalError,
    originalError: originalError && {
      name: originalError.name,
      code: originalError.code,
      message: originalError.message,
      frames: originalError.stack
        ?.split('\n')
        .filter((line) => /^\s+at /.test(line)),
    },
    firstWait: progress.firstWait,
    condition: {
      actualFirstWaitTimeout: false,
      viewportFrom: null,
      note: 'the timeout must be in the first wait, with polls and no h1 at the last; raw viewports are no root, and a pass closes nothing',
    },
  }
  try {
    // The page may be the failure: the journey's outcome must not wait on it.
    let timer
    const { original, after } = await Promise.race([
      page.evaluate(afterJourney, !!originalError),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('dump timed out')), 10000)
      }),
    ]).finally(() => clearTimeout(timer))
    result.after = {
      caveat:
        'after failure only: real geometry read once the original outcome was sealed',
      ...after,
    }
    if (original) {
      Object.assign(result, original, {
        complete: true,
        missing: Number(!original.mount) + Number(!original.polls),
      })
      result.condition.actualFirstWaitTimeout =
        originalError?.name === 'TimeoutError' &&
        progress.firstWait === 'pending' &&
        original.polls > 0 &&
        original.last?.h1 === 0
      result.condition.viewportFrom = {
        mount: original.mount?.viewport.from,
        first: original.first?.viewport.from,
        last: original.last?.viewport.from,
      }
    }
  } catch (error) {
    result.dumpError = error.message
  }
  // Write before quality checks, including a missing trace after a crashed page.
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(result, null, 2)}\n`)
    t.diagnostic(
      `trace initial-h1: polls=${result.polls ?? 0} changes=${result.changes?.length ?? 0} dropped=${result.dropped ?? 0} faults=${result.faults ?? 0} missing=${result.missing} originalPassed=${result.originalPassed}`,
    )
    // A failed journey keeps what it reached; a pass must have all of it.
    if (!originalError) {
      assert.equal(result.complete, true, 'diagnostic trace missing')
      assert.equal(result.missing, 0, 'diagnostic condition miss')
      assert.equal(result.dropped, 0, 'diagnostic trace overflow')
      assert.equal(result.faults, 0, 'diagnostic logging fault')
    }
  } catch (error) {
    if (!originalError) throw error
    t.diagnostic(`trace dump failed: ${error.name}; original error retained`)
  }
}
