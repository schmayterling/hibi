import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/** Never-merge metadata only. Called inside an existing target-owned RPC. */
export function installTrace(label) {
  if (window.__releaseTrace) return
  const ids = new WeakMap()
  let next = 0
  const trace = {
    label, cap: 4096, dropped: 0, faults: 0, events: [], active: true,
    id(value) {
      if (!value) return null
      if (!ids.has(value)) ids.set(value, ++next)
      return ids.get(value)
    },
    add(event, data = {}) {
      if (!trace.active) return
      try {
        if (trace.events.length >= trace.cap) { trace.dropped++; return }
        trace.events.push({ event, ...data, stampMs: performance.now() })
      } catch { trace.faults++ }
    },
    view(view) {
      const content = view?.contentDOM
      return {
        view: trace.id(view), doc: trace.id(view?.state.doc),
        length: view?.state.doc.length,
        anchor: view?.state.selection.main.anchor,
        head: view?.state.selection.main.head,
        connected: view?.dom.isConnected,
        editable: content?.contentEditable,
        readOnly: view?.state.readOnly,
        ready: content?.closest('.editor-panes')?.getAttribute('data-source-ready'),
        appBusy: document.querySelector('.app')?.getAttribute('aria-busy'),
        panelBusy: document.querySelector('#document-editor-panel')?.getAttribute('aria-busy'),
        focus: document.activeElement?.tagName,
        focused: !!content && content.contains(document.activeElement),
        hasFocus: view?.hasFocus,
        documentFocus: document.hasFocus(),
      }
    },
    snapshot() {
      return { label, timeOrigin: performance.timeOrigin, cap: trace.cap, dropped: trace.dropped, faults: trace.faults, events: trace.events }
    },
  }
  window.__releaseTrace = trace
  window.__releaseLinkTrace = (event, data, view) => trace.add(event, {
    ...data, view: trace.id(view), doc: trace.id(view?.state.doc),
  })
  const types = label === 'heading' ? [] : label === 'link'
    ? ['focusin', 'focusout', 'pointerenter', 'pointerleave', 'pointermove', 'scroll', 'toggle']
    : ['keydown', 'beforeinput', 'input', 'cut', 'focusin', 'focusout']
  for (const type of types) {
    document.addEventListener(type, (event) => {
      if (!trace.active) return
      const element = event.target instanceof Element ? event.target : null
      const view = label === 'math' ? document.querySelector('.rich-pane .cm-content')?.cmTile?.root?.view : null
      const targetView = label === 'math' ? element?.closest('.cm-content')?.cmTile?.root?.view : null
      trace.add(type, {
        ...(label === 'math' ? {
          ...trace.view(view),
          targetView: trace.id(targetView), targetDoc: trace.id(targetView?.state.doc),
        } : {}),
        target: element?.tagName,
        targetClass: element?.className,
        key: event instanceof KeyboardEvent && event.key.length > 1 ? event.key : undefined,
        inputType: event instanceof InputEvent ? event.inputType : undefined,
        dataLength: event instanceof InputEvent ? event.data?.length : undefined,
        x: event instanceof PointerEvent ? event.clientX : undefined,
        y: event instanceof PointerEvent ? event.clientY : undefined,
        oldState: event.oldState, newState: event.newState,
        phase: trace.phase,
      })
    }, { capture: true, passive: true })
  }
  window.addEventListener('blur', () => trace.add('window-blur'))
}

/** Serialize both functions into the existing evaluation; adds no RPC or await. */
export function withTrace(label, callback) {
  return Function(`return (...args) => {
    (${installTrace.toString()})(${JSON.stringify(label)});
    return (${callback.toString()})(...args);
  }`)()
}

/** Runs only after the original journey returns or throws; never masks its error. */
export async function finishTrace(t, page, label, originalError, phase, carried) {
  const path = resolve(process.env.HIBI_RELEASE_TRACE_DIR || '.scratch/release-reds', label + '.json')
  const result = {
    complete: false, missing: 1, originalPassed: !originalError, phase,
    originalError: originalError && {
      name: originalError.name, code: originalError.code, operator: originalError.operator,
      frames: originalError.stack?.split('\n').filter((line) => /^\s+at /.test(line)),
    },
  }
  try {
    const trace = carried || await page?.evaluate(() => {
      const trace = window.__releaseTrace
      if (!trace) return null
      trace.active = false
      return trace.snapshot()
    })
    if (trace) Object.assign(result, trace, { complete: true, missing: 0 })
  } catch (error) { result.dumpError = error.name }
  // Write before quality checks, including a missing trace after a crashed page.
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(result, null, 2) + '\n')
    t.diagnostic(`trace ${label}: events=${result.events?.length ?? 0} dropped=${result.dropped ?? 0} missing=${result.missing} originalPassed=${result.originalPassed}`)
    if (!originalError) {
      assert.equal(result.missing, 0, 'diagnostic condition miss')
      assert.equal(result.dropped, 0, 'diagnostic trace overflow')
      assert.equal(result.faults, 0, 'diagnostic logging fault')
    }
  } catch (error) {
    if (!originalError) throw error
    t.diagnostic(`trace dump failed: ${error.name}; original error retained`)
  }
}
