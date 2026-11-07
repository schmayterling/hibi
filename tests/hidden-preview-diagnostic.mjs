import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const stages = [
  'split:doc',
  'split:tail',
  'split:selection',
  'hidden:doc',
  'hidden:edits',
  'shown:selection',
  'shown:doc',
  'shown:tail',
]

/**
 * Never-merge metadata only: fields CodeMirror already holds. No layout read,
 * and nothing that runs a pending measure, such as the view's lineBlockAt,
 * coordsAtPos, elementAtHeight, domAtPos, documentTop or contentHeight.
 */
function record(stage) {
  window.__hiddenPreviewTrace ??= {
    cap: 64,
    dropped: 0,
    faults: 0,
    events: [],
    ids: new WeakMap(),
    next: 0,
    resizeCap: 2048,
    resizeDropped: 0,
    resizeFaults: 0,
    resize: [],
  }
  const trace = window.__hiddenPreviewTrace
  if (trace.events.length >= trace.cap) {
    trace.dropped++
    return
  }
  try {
    const id = (value) => {
      if (!trace.ids.has(value)) trace.ids.set(value, ++trace.next)
      return trace.ids.get(value)
    }
    const span = ({ from, to }) => ({ from, to })
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    const viewState = view.viewState
    const oracle = viewState.heightOracle
    const main = view.state.selection.main
    const active = document.activeElement
    trace.events.push({
      stage,
      stampMs: performance.now(),
      wallMs: Date.now(),
      view: id(view),
      doc: id(view.state.doc),
      length: view.state.doc.length,
      lines: view.state.doc.lines,
      anchor: main.anchor,
      head: main.head,
      viewport: span(viewState.viewport),
      viewports: viewState.viewports.map(span),
      visibleRanges: viewState.visibleRanges.map(span),
      lineGaps: viewState.lineGaps.map(span),
      viewportLines: viewState.viewportLines.slice(0, 6).map((line) => ({
        from: line.from,
        to: line.to,
        top: line.top,
        height: line.height,
      })),
      mapHeight: viewState.heightMap.height,
      inView: viewState.inView,
      pixelViewport: { ...viewState.pixelViewport },
      paddingTop: viewState.paddingTop,
      editorWidth: viewState.editorWidth,
      editorHeight: viewState.editorHeight,
      contentDOMWidth: viewState.contentDOMWidth,
      contentDOMHeight: viewState.contentDOMHeight,
      lineHeight: oracle.lineHeight,
      charWidth: oracle.charWidth,
      lineLength: oracle.lineLength,
      mustMeasureContent: viewState.mustMeasureContent,
      scrollTarget: !!viewState.scrollTarget,
      scrollAnchorPos: viewState.scrollAnchorPos,
      scrollAnchorHeight: viewState.scrollAnchorHeight,
      measureScheduled: view.measureScheduled,
      updateState: view.updateState,
      resizeTimeout: view.observer.resizeTimeout,
      lastUpdate: view.docView.lastUpdate,
      panes: document.querySelector('.editor-panes')?.className,
      active: active?.tagName,
      activeClass: active?.className,
      activeInRich: view.contentDOM.contains(active),
    })
  } catch {
    trace.faults++
  }
}

/** The callback's own read comes first; adds no RPC, await or frame. */
export function traced(stage, callback) {
  return Function(`return (...args) => {
    const result = (${callback.toString()})(...args);
    (${record.toString()})(${JSON.stringify(stage)});
    return result;
  }`)()
}

/** Runs once, after the original journey returned or threw. */
async function afterJourney({ tail, delay }) {
  const trace = window.__hiddenPreviewTrace
  // Sealed before any geometry below can repair what the journey saw.
  const original = trace && {
    timeOrigin: performance.timeOrigin,
    cap: trace.cap,
    dropped: trace.dropped,
    faults: trace.faults,
    events: trace.events.slice(),
    resizeCap: trace.resizeCap,
    resizeDropped: trace.resizeDropped,
    resizeFaults: trace.resizeFaults,
    resize: trace.resize.slice(),
  }
  const box = (element) => {
    const { left, top, width, height } = element.getBoundingClientRect()
    return { left, top, width, height }
  }
  const sample = () => {
    const pane = document.querySelector('.rich-pane')
    const content = pane.querySelector('.cm-content')
    const view = content.cmTile.root.view
    const cached = {
      viewport: { from: view.viewport.from, to: view.viewport.to },
      editorWidth: view.viewState.editorWidth,
      contentDOMWidth: view.viewState.contentDOMWidth,
      inView: view.viewState.inView,
      measureScheduled: view.measureScheduled,
      resizeTimeout: view.observer.resizeTimeout,
      lastUpdate: view.docView.lastUpdate,
    }
    const style = getComputedStyle(pane)
    const text = content.innerText
    return {
      stampMs: performance.now(),
      wallMs: Date.now(),
      cached,
      hasTail: text.includes(tail),
      textLength: text.length,
      window: { width: window.innerWidth, height: window.innerHeight },
      pane: {
        ...box(pane),
        clientWidth: pane.clientWidth,
        clientHeight: pane.clientHeight,
        scrollTop: pane.scrollTop,
        scrollHeight: pane.scrollHeight,
        width: style.width,
        transform: style.transform,
        visibility: style.visibility,
      },
      scrollerWidth: view.scrollDOM.clientWidth,
      content: box(content),
      lines: [...content.querySelectorAll('.cm-line')]
        .slice(0, 8)
        .map((line) => ({
          start: line.textContent.slice(0, 16),
          length: line.textContent.length,
          ...box(line),
        })),
      transitions: pane.getAnimations().map((animation) => ({
        property: animation.transitionProperty,
        state: animation.playState,
        time: animation.currentTime,
      })),
    }
  }
  // A view or pane that changed here must not lose the sealed snapshot.
  const after = {}
  try {
    after.immediately = sample()
    if (delay) await new Promise((done) => setTimeout(done, delay))
    after.later = sample()
  } catch (error) {
    after.dumpError = `${error.name}: ${error.message}`
  }
  return { original, after }
}

/** Never masks the journey's error; a poor trace cannot turn into a pass. */
export async function finishTrace(t, page, originalError, phase, places) {
  const path = resolve(
    process.env.HIBI_RELEASE_TRACE_DIR || '.scratch/hidden-preview',
    'hidden-preview.json',
  )
  const result = {
    complete: false,
    missing: stages.length,
    originalPassed: !originalError,
    phase,
    places,
    originalError: originalError && {
      name: originalError.name,
      code: originalError.code,
      operator: originalError.operator,
      message: originalError.message,
      frames: originalError.stack
        ?.split('\n')
        .filter((line) => /^\s+at /.test(line)),
    },
  }
  try {
    const { original, after } = await page.evaluate(afterJourney, {
      tail: 'omega',
      delay: originalError ? 1000 : 0,
    })
    result.after = {
      caveat:
        'observational: the first sample reads layout, so a later change may come from that read, and proves neither natural repair nor a stuck root',
      ...after,
    }
    if (original) {
      const seen = new Set(original.events.map(({ stage }) => stage))
      Object.assign(result, original, {
        complete: true,
        missing: stages.filter((stage) => !seen.has(stage)).length,
      })
    }
  } catch (error) {
    result.dumpError = error.name
  }
  // Write before quality checks, including a missing trace after a crashed page.
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(result, null, 2) + '\n')
    t.diagnostic(
      `trace hidden-preview: events=${result.events?.length ?? 0} dropped=${result.dropped ?? 0} faults=${result.faults ?? 0} resize=${result.resize?.length ?? 0} resizeDropped=${result.resizeDropped ?? 0} resizeFaults=${result.resizeFaults ?? 0} missing=${result.missing} originalPassed=${result.originalPassed}`,
    )
    if (!originalError) {
      assert.equal(result.complete, true, 'diagnostic trace missing')
      assert.equal(result.missing, 0, 'diagnostic condition miss')
      assert.equal(result.dropped, 0, 'diagnostic trace overflow')
      assert.equal(result.faults, 0, 'diagnostic logging fault')
      assert.ok(result.resize.length, 'diagnostic resize log silent')
      assert.equal(result.resizeDropped, 0, 'diagnostic resize overflow')
      assert.equal(result.resizeFaults, 0, 'diagnostic resize fault')
    }
  } catch (error) {
    if (!originalError) throw error
    t.diagnostic(`trace dump failed: ${error.name}; original error retained`)
  }
}
