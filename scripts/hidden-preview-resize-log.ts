// Never merge: logs CodeMirror's own resize decision and timer into the hidden
// preview trace. Adds no measure or observer, and a log failure never reaches
// the original condition, its onResize or its requestMeasure.
import { createHash } from 'node:crypto'

const pinned =
  '602f8203c6f39d8ba8a9b8a6a10c6e28f93537c07244b2d6d28aefb88fe8db91'
const log = (fields: string) => `try {
                    const __trace = window.__hiddenPreviewTrace;
                    if (__trace && __trace.resize.length >= __trace.resizeCap)
                        __trace.resizeDropped++;
                    else if (__trace) {
                        const __id = (value) => {
                            if (!__trace.ids.has(value))
                                __trace.ids.set(value, ++__trace.next);
                            return __trace.ids.get(value);
                        };
                        __trace.resize.push({ ${fields}, view: __id(this.view), doc: __id(this.view.state.doc), editorWidth: this.view.viewState.editorWidth, rich: !!this.view.dom.closest(".rich-pane"), wallMs: Date.now(), stampMs: performance.now() });
                    }
                }
                catch (__error) {
                    try {
                        window.__hiddenPreviewTrace.resizeFaults++;
                    }
                    catch (__fault) { }
                }`
const condition =
  '((_a = this.view.docView) === null || _a === void 0 ? void 0 : _a.lastUpdate) < Date.now() - 75'
export const replacements: readonly (readonly [string, string])[] = [
  [
    `                if (${condition})
                    this.onResize();
`,
    `                var __accepted = ${condition};
                ${log('event: "callback", accepted: __accepted, lastUpdate: _a === null || _a === void 0 ? void 0 : _a.lastUpdate, timer: this.resizeTimeout')}
                if (__accepted)
                    this.onResize();
`,
  ],
  [
    `                this.resizeTimeout = -1;
                this.view.requestMeasure();
`,
    `                this.resizeTimeout = -1;
                ${log('event: "timer"')}
                this.view.requestMeasure();
`,
  ],
]
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const swap = (text: string, from: string, to: string) => {
  const parts = text.split(from)
  if (parts.length !== 2)
    throw new Error(`expected one match, found ${parts.length - 1}`)
  return parts.join(to)
}

export function stripResizeLog(traced: string) {
  return replacements.reduceRight(
    (text, [from, to]) => swap(text, to, from),
    traced,
  )
}

export function logResizeDecision(source: string) {
  if (sha256(source) !== pinned) throw new Error('unpinned @codemirror/view')
  const traced = replacements.reduce(
    (text, [from, to]) => swap(text, from, to),
    source,
  )
  if (stripResizeLog(traced) !== source)
    throw new Error('the log does not strip back to the original')
  return traced
}

export function resizeLog() {
  let applied = 0
  return {
    name: 'hidden-preview-resize-log',
    enforce: 'pre' as const,
    apply: 'build' as const,
    transform(code: string, id: string) {
      if (!id.split('?', 1).at(0)?.endsWith('@codemirror/view/dist/index.js'))
        return null
      applied++
      return { code: logResizeDecision(code), map: null }
    },
    buildEnd() {
      if (applied !== 1)
        throw new Error(`resize log applied ${applied} times, expected 1`)
    },
  }
}
