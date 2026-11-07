// Diagnostic only. Never merge; no installed dependency is modified.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const tracePath = process.env.HIBI_PARAGRAPH_TRACE
export const base = 'ca59edf52761200902c117532875ae46407b687c'
export const baseTree = 'a98103405aa77b249bd07127f3054814ef7cdba1'
const sha = (value) => createHash('sha256').update(value).digest('hex')
const begin = '/* pwbundle:start */'
const end = '/* pwbundle:end */'
export const stripBundle = (code) =>
  code.replace(/\/\* pwbundle:start \*\/[\s\S]*?\/\* pwbundle:end \*\//g, '')

// Only object identity and copied scalar fields: no DOM queries or layout reads.
function arm() {
  const ids = new WeakMap()
  const resets = (globalThis.__paragraphWidthTrace?.resets ?? 0) + 1
  let serial = 0
  const id = (value) => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function'))
      return null
    if (!ids.has(value)) ids.set(value, ++serial)
    return ids.get(value)
  }
  const place = (value) => value && Object.freeze({
    pos: value.pos, top: value.top, offset: value.offset,
    text: value.text, line: value.line, moved: value.moved,
    isTop: !!value.isTop, doc: id(value.doc), pane: id(value.pane),
    selection: id(value.selection), request: value.scrollRequest,
  })
  const sink = {
    rows: [], cap: 80000, dropped: 0, faults: 0, resets,
    phase: 'mount', width: 1400, stage: null, active: true,
    first900: null,
    add(event, view, fields = {}) {
      if (!this.active) return
      try {
        if (this.rows.length >= this.cap) { this.dropped++; return }
        const copied = {}
        for (const [key, value] of Object.entries(fields))
          copied[key] = ['position', 'held', 'keep'].includes(key)
            ? place(value)
            : value && typeof value === 'object'
              ? id(value)
              : typeof value === 'number' && !Number.isFinite(value) ? String(value) : value
        const row = Object.freeze({
          ...copied, seq: this.rows.length,
          event, phase: this.phase, width: this.width, stage: this.stage,
          view: id(view), doc: id(view?.state.doc),
        })
        this.rows.push(row)
        if (event === 'width-oracle' && this.width === 900 && this.stage === 'first')
          this.first900 = row
      } catch { this.faults++ }
    },
    finish() {
      this.active = false
      return Object.freeze({
        rows: Object.freeze(this.rows.slice()), cap: this.cap,
        dropped: this.dropped, faults: this.faults, resets: this.resets,
        first900: this.first900,
      })
    },
  }
  globalThis.__paragraphWidthTrace = sink
  sink.add('armed', null)
}
function trace(event, view, fields = {}) {
  const sink = globalThis.__paragraphWidthTrace
  if (!sink?.active) return
  try { sink.add(event, view, fields) } catch { sink.faults++ }
}

const call = (event, fields = '{}', view = 'view') =>
  `pwTrace(${JSON.stringify(event)}, ${view}, ${fields});\n`

// Insertions only. Original expressions and their evaluation counts are preserved.
const readingInsertions = [
  ['function hold(view: EditorView, position: Reading) {', call('hold', '{ position }')],
  ['function holdTop(view: EditorView) {', call('hold-top-enter')],
  ['  const held = anchors.get(view)\n  if (\n    held?.position.pane === pane', call('hold-top-held', '{ held: held?.position, heldScroll: held?.scroll, pane }'), 'before-if'],
  ['  const keep = kept.get(view)\n  if (keep && !stayed(view, keep, keep.scroll))', call('hold-top-invalidated', '{ held: held?.position, heldScroll: held?.scroll, keep }'), 'before-if'],
  ['  const position = top === null ? null : reader(view, pane, text, top)', call('hold-top-read', '{ text, top, position, pane }')],
  ['function restore(view: EditorView, position: Reading) {', call('restore-enter', '{ position }')],
  ['  try {\n    view.coordsAtPos(position.pos, 1)', call('restore-measured', '{ position }')],
  ['    reveal(view, position)', call('restore-reveal', '{ position }')],
  ['  const now = screenTop(view, position) - paneTop(position.pane)', call('restore-now', '{ position, now }')],
  ['    position.pane.scrollTop += now - position.top', '{\n' + call('restore-write', '{ position, now }'), 'before'],
  ['    position.pane.scrollTop += now - position.top', '}\n'],
  ['function reveal(view: EditorView, position: Reading) {', call('reveal-enter', '{ position }')],
  ['    // Where the editor scrolls it when the page can\'t place it either.', call('reveal-dispatch', '{ position }'), 'before'],
  ['function holdHeld(view: EditorView) {\n  if (isViewDead(view)) return\n  const held = anchors.get(view)', call('hold-held', '{ held: held?.position, heldScroll: held?.scroll }')],
  ['  restore(view, {\n    ...held.position,', call('hold-held-accepted', '{ held: held.position, heldScroll: held.scroll }'), 'before'],
  ['    const asked = update.transactions.some(asksScroll)', call('update', '{ asked, docChanged: update.docChanged, selectionSet: update.selectionSet, geometry: update.geometryChanged, height: update.heightChanged, viewport: update.viewportChanged }', 'update.view')],
  ['    if (--keep.left <= 0) kept.delete(update.view)', call('kept-geometry', '{ keep, keptScroll: keep.scroll, left: keep.left }', 'update.view')],
  ['    const position = revealing.get(view)', call('scroll-handler', '{ position, head: range.head }')],
  ['      position.pane.scrollTop += now - paneTop(position.pane) - position.top', call('reveal-write', '{ position, now }'), 'before'],
]
const cmInsertions = [
  ['measure(flush = true) {', call('cm-measure-enter', '{ flush }', 'this')],
  ['let lineHeights = view.docView.measureVisibleLineHeights(this.viewport);', call('cm-heights', '{ vpFrom: this.viewport.from, vpTo: this.viewport.to, count: lineHeights.length, max: Math.max(0, ...lineHeights), sum: lineHeights.reduce((a, b) => a + (b > 0 ? b : 0), 0), viewports: this.viewports.length, refresh }', 'view')],
  ['let structure = lineStructure(line.from, line.to, this.stateDeco);', call('cm-check-line', '{ from: line.from, to: line.to, top: line.top, height: line.height, vt: this.visibleTop, vb: this.visibleBottom, ll: this.heightOracle.lineLength, lh: this.heightOracle.lineHeight, measuring: !!mayMeasure, target: this.scrollTarget ? this.scrollTarget.range.head : -1 }', 'this.view')],
  ['this.updateLineGaps(this.ensureLineGaps(refresh ? [] : this.lineGaps, view));', call('cm-gaps-set', "{ gaps: this.lineGaps.map(g => g.from + '-' + g.to + ':' + Math.round(g.size)).join(' ') }", 'view')],
  ['let { scrollAnchorPos, scrollAnchorHeight, scaleY: scrollScale } = this.viewState;', call('cm-anchor-before', '{ scroll, scrollOffset, scrollAnchorPos, scrollAnchorHeight, scrollScale }', 'this')],
  ['let changed = this.viewState.measure();', call('cm-measure-read', '{ changed, iteration: i }', 'this')],
  ['let update = ViewUpdate.create(this, this.state, []), redrawn = false;', call('cm-measure-write', '{ changed }', 'this')],
  ['scrollOffset = scrollOffset + diff;', call('cm-anchor-write', '{ diff, scrollOffset, scrollAnchorPos, scrollAnchorHeight, scrollScale, newAnchorHeight, scroll }', 'this')],
  ['this.docView.scrollIntoView(this.viewState.scrollTarget);', call('cm-target-executed', '{ head: this.viewState.scrollTarget?.range.head }', 'this')],
  ['let domRect = dom.getBoundingClientRect();', call('cm-existing-size', '{ actualWidth: domRect.width, height: domRect.height, cachedWidth: this.contentDOMWidth, editorWidth: this.editorWidth, lineLength: oracle.lineLength, charWidth: oracle.charWidth }', 'view')],
  ['gaps.push(gap);', call('cm-line-gap', '{ from, to, size: gap.size, displaySize: gap.displaySize }', 'this.view'), 'before'],
  ['let start = cur.scrollTop;', call('cm-rect-write', '{ cur, start, moveY, scaleY }', 'null')],
  ['movedY = (cur.scrollTop - start) * scaleY;', call('cm-rect-written', '{ cur, start, movedY, scaleY }', 'null')],
]
export const modulePlans = [
  {
    suffix: '/src/renderer/src/reading-position.ts',
    hash: 'bedf807029539a20303dffb3961d9a95d03896ec67ba1c9efd8bb45c3dc5a764',
    insertions: readingInsertions, arm: true,
  },
  {
    suffix: '/@codemirror/view/dist/index.js',
    hash: '602f8203c6f39d8ba8a9b8a6a10c6e28f93537c07244b2d6d28aefb88fe8db91',
    insertions: cmInsertions,
  },
]
export function transformModule(code, plan) {
  assert.equal(sha(code), plan.hash, 'unexpected diagnostic module bytes')
  const mark = (value) => begin + value + end
  let result = code
  for (const [anchor, statement, side] of plan.insertions) {
    // Count against pristine input; a later insertion may contain an anchor.
    assert.equal(code.split(anchor).length - 1, 1, 'trace anchor: ' + anchor)
    if (side === 'before-if') {
      const split = anchor.indexOf('\n  if')
      result = result.replace(anchor, anchor.slice(0, split) + mark('\n' + statement) + anchor.slice(split))
    } else result = result.replace(anchor,
      side === 'before' ? mark(statement) + anchor : anchor + mark('\n' + statement))
  }
  result = mark(
    `const pwTrace = ${trace.toString()};\n` +
    (plan.arm ? `globalThis.__paragraphWidthArm = ${arm.toString()};\n` : ''),
  ) + result
  assert.equal(stripBundle(result), code, 'diagnostic module did not reverse exactly')
  return {
    code: result,
    receipt: {
      suffix: plan.suffix, original: sha(code), stripped: sha(stripBundle(result)),
      instrumented: sha(result), insertions: plan.insertions.length + 1,
    },
  }
}
export function paragraphTracePlugin() {
  const receipts = []
  return {
    name: 'never-merge-paragraph-width-trace',
    enforce: 'pre',
    transform(code, id) {
      const plan = modulePlans.find((entry) => id.replaceAll('\\', '/').endsWith(entry.suffix))
      if (!plan) return
      assert.ok(!receipts.some((entry) => entry.suffix === plan.suffix), 'duplicate trace module')
      const result = transformModule(code, plan)
      receipts.push(result.receipt)
      return { code: result.code, map: null }
    },
    async buildEnd(error) {
      if (error) return
      assert.equal(receipts.length, modulePlans.length, 'missing trace module')
      await writeFile(join(dirname(tracePath), 'transforms.json'), JSON.stringify(receipts, null, 2))
    },
  }
}
let fixture
const ioResults = {}
const ioFaults = []
async function postIO(label, operation) {
  const controller = new AbortController()
  let timer
  try {
    await Promise.race([
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('added diagnostic I/O exceeded 5000 ms'))
        }, 5000)
      }),
      operation(controller.signal),
    ])
    ioResults[label] = true
  } catch (error) {
    try {
      ioResults[label] = false
      ioFaults.push({ label, message: error.message })
      console.error('paragraph diagnostic I/O failure', label, error.message)
    } catch {
      try { process.stderr.write('paragraph diagnostic I/O failure\n') } catch {}
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
async function manifest(directory, signal) {
  signal?.throwIfAborted()
  const entries = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      for (const child of await manifest(path, signal))
        entries.push({ ...child, path: entry.name + '/' + child.path })
    } else if (entry.isFile()) {
      const bytes = await readFile(path, { signal })
      entries.push({ path: entry.name, bytes: bytes.length, sha256: sha(bytes) })
    } else throw new Error('non-file fixture entry: ' + path)
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}
export async function pinFixture(phase, directory) {
  if (!tracePath) return
  if (directory) fixture = directory
  const write = async (signal) => {
    const value = await manifest(fixture, signal)
    await writeFile(join(dirname(tracePath), phase + '.json'), JSON.stringify(value, null, 2), { signal })
  }
  if (phase === 'fixture-after') await postIO(phase, write)
  else await write()
}
export async function saveTrace(value) {
  await postIO('widths', (signal) =>
    writeFile(tracePath, JSON.stringify({ base, baseTree, ...value }, null, 2), { signal }))
}
export async function finishTraceIO() {
  if (!tracePath) return
  try {
    await postIO('io-status', (signal) => writeFile(
      join(dirname(tracePath), 'io-status.json'),
      JSON.stringify({ results: { ...ioResults }, faults: ioFaults.slice() }, null, 2),
      { signal },
    ))
  } catch {
    // postIO recorded the failure in original TAP; it can never certify a dump.
  }
}
