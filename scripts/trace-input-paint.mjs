import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { cpus, release, tmpdir, totalmem } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { electron } from '../tests/electron.mjs'
import { clickMenu, pressShortcut } from '../tests/keyboard.mjs'
import {
  launchBenchmarkApp,
  switchToSource,
  waitForEditor,
} from './benchmark-flows.mjs'
import { createTraceFinalizer } from './trace-stream.mjs'

const { values } = parseArgs({
  options: {
    engine: { type: 'string', default: 'hibi' },
    'bare-markdown': { type: 'boolean' },
    mode: { type: 'string', default: 'all' },
    file: { type: 'string' },
    size: { type: 'string', default: 'all' },
    shape: { type: 'string', default: 'all' },
    position: { type: 'string', default: 'middle' },
    target: { type: 'string', default: 'both' },
    'hold-ms': { type: 'string', default: '30000' },
    'settle-ms': { type: 'string', default: '15000' },
    rate: { type: 'string', default: '30' },
    addons: {
      type: 'string',
      default:
        'frontmatter,github-markdown,text-extras,word-count,typing-speed',
    },
    out: { type: 'string' },
    quick: { type: 'boolean' },
    'continue-on-error': { type: 'boolean' },
    'trace-screenshots': { type: 'boolean' },
    'cpu-profile': { type: 'boolean' },
    'fixed-chrome': { type: 'boolean' },
    background: { type: 'boolean' },
    help: { type: 'boolean' },
  },
})
if (values.help) {
  console.log(
    'node scripts/trace-input-paint.mjs --engine hibi|bare [--bare-markdown] --mode source|visual|split|split-tabs|all [--file PATH | --size chars|words|all --shape paragraphs|giant|all] --position start|middle|end|all --target source|visual|both --out NEW_DIRECTORY [--quick] [--hold-ms 30000] [--rate 30] [--fixed-chrome] [--background] [--trace-screenshots] [--cpu-profile] [--continue-on-error]',
  )
  process.exit(0)
}
const choose = (value, choices) => {
  if (value === 'all') return choices
  assert.ok(choices.includes(value), `Choose ${choices.join(', ')} or all.`)
  return [value]
}
const splitTabsMode = values.mode === 'split-tabs',
  modes = splitTabsMode
    ? ['split-tabs']
    : choose(values.mode, ['source', 'visual', 'split']),
  sizes = values.file ? ['file'] : choose(values.size, ['chars', 'words']),
  shapes = values.file
    ? ['original']
    : choose(values.shape, ['paragraphs', 'giant']),
  positions = choose(values.position, ['start', 'middle', 'end']),
  holdMs = values.quick ? 0 : Number(values['hold-ms']),
  rate = Number(values.rate),
  settleMs = Number(values['settle-ms'])
assert.ok(['hibi', 'bare'].includes(values.engine))
const bare = values.engine === 'bare'
assert.ok(
  !splitTabsMode || (!bare && !values.file && values.target === 'both'),
  '--mode split-tabs requires Hibi, generated fixtures, and --target both.',
)
assert.ok(
  !splitTabsMode ||
    (!values.background &&
      !values['cpu-profile'] &&
      !values['fixed-chrome'] &&
      !values['trace-screenshots']),
  '--mode split-tabs requires a foreground window and does not support --cpu-profile, --fixed-chrome, or --trace-screenshots.',
)
assert.ok(
  !splitTabsMode ||
    (values.size === 'all' &&
      values.shape === 'all' &&
      values.position === 'middle' &&
      !values.quick &&
      values['hold-ms'] === '30000' &&
      values.rate === '30'),
  '--mode split-tabs uses fixed short fixtures; size, shape, position, quick, hold-ms, and rate do not apply.',
)
assert.ok(
  bare || !values['bare-markdown'],
  '--bare-markdown requires --engine bare.',
)
assert.ok(
  !bare || !values.file,
  '--engine bare supports generated plain fixtures only; --file requires Hibi source preservation.',
)
assert.ok(
  !bare || values['fixed-chrome'],
  '--engine bare requires --fixed-chrome; use the same flag for the paired Hibi run.',
)
assert.ok(['source', 'visual', 'both'].includes(values.target))
assert.ok(Number.isFinite(holdMs) && holdMs >= 0 && holdMs <= 30000)
assert.ok(Number.isFinite(rate) && rate >= 1 && rate <= 30)
assert.ok(Number.isFinite(settleMs) && settleMs >= 1000 && settleMs <= 30000)
const repetitions = Math.floor((holdMs * rate) / 1000)
assert.ok(repetitions <= 900)
const addons = Object.fromEntries(
  values.addons
    .split(',')
    .filter(Boolean)
    .map((id) => [id, true]),
)
addons['discord-presence'] = false
addons['input-paint-probe'] = true
const sourceBytes = values.file ? await readFile(resolve(values.file)) : null,
  fileText = sourceBytes?.toString('utf8'),
  sourceFile = sourceBytes
    ? {
        path: resolve(values.file),
        bytes: sourceBytes.length,
        chars: fileText.length,
        sha256: createHash('sha256').update(sourceBytes).digest('hex'),
      }
    : null
if (sourceBytes)
  assert.ok(
    Buffer.from(fileText, 'utf8').equals(sourceBytes),
    '--file must contain valid UTF-8 text.',
  )
if (!bare) await access(resolve('out/main/index.js'))
const rendererIndex = bare
    ? null
    : await readFile(resolve('out/renderer/index.html')),
  rendererEntry =
    rendererIndex
      ?.toString('utf8')
      .match(/<script\b[^>]*\bsrc=["']([^"']+)["']/)?.[1] ?? null,
  statusScope = 'integrity-and-measurement-completion-only'
const output = values.out
  ? resolve(values.out)
  : await mkdtemp(join(tmpdir(), 'hibi-input-paint-'))
if (values.out) await mkdir(output)
const summary = {
  output,
  options: values,
  engine: bare ? 'engine-only' : 'hibi',
  bareMarkdown: bare ? !!values['bare-markdown'] : null,
  windowMode: values.background
    ? 'visible-inactive-focus-emulated'
    : 'foreground',
  addons: bare ? {} : addons,
  sourceFile,
  runtime: process.version,
  platform: process.platform,
  arch: process.arch,
  environment: {
    cpu: cpus()[0]?.model,
    os: release(),
    memoryBytes: totalmem(),
  },
  commit: execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  builtMainSha256: bare
    ? null
    : createHash('sha256')
        .update(await readFile(resolve('out/main/index.js')))
        .digest('hex'),
  builtRendererIndexSha256: bare
    ? null
    : createHash('sha256').update(rendererIndex).digest('hex'),
  builtRendererEntry: rendererEntry,
  statusScope,
  latencyTarget: { belowMs: 1, evaluatedByScenarioStatus: false },
  comparisonGoal:
    'Active text ready for the next available frame, approaching the matched bare engine; sub-1ms remains an aspiration for the named timing endpoints, not physical scanout.',
  harnessSha256: createHash('sha256')
    .update(await readFile(new URL(import.meta.url)))
    .digest('hex'),
  cases: [],
  limitations: [
    'CDP injects browser input, not a physical keyboard or OS autorepeat. Cadence is independent of command acknowledgments and renderer paint.',
    'Generated epoch timestamps, renderer event timestamps, and handler times expose queue delay; cross-process clock conversion is a proxy and is reported separately.',
    'A matching glyph DOM range in the viewport at rAF, followed by another rAF, is a presentation opportunity, not physical scanout. Coalesced edits may share a frame.',
    'Tracing and benchmark-only observer callbacks add overhead. Screenshots are captured after measured settlement; optional trace screenshots add further overhead.',
    'Source model acceptance is observed after the native CodeMirror view update returns, using the same direct observer for Hibi and the bare engine. The probe registers no editor extension.',
    'Source and visual updates may include synchronous DOM work. No artificial debounce, input-rate throttling based on paint, or reduced correctness checks are applied.',
    ...(splitTabsMode
      ? [
          'Split-tabs uses two different mounted documents and Playwright keyboard.press synthetic key events. Its sampled screenshot glyph match timestamps the first observed changed capture at the driver; sampling and transport delay are included, and physical scanout is not measured.',
        ]
      : []),
    ...(bare
      ? [
          `Engine-only uses CodeMirror ${values['bare-markdown'] ? 'with native Markdown parsing and highlighting' : 'without a language or highlighting extension'} and ProseMirror history with a static, inert split peer. No Hibi runtime, React, addons, canonical journal, or IPC save runs; saved artifacts are engine snapshots written by the benchmark runner.`,
        ]
      : []),
    ...(values['fixed-chrome']
      ? [
          'Fixed-chrome comparison excludes titlebar and toolbar auto-hide transitions. Default Hibi behavior must be measured separately.',
        ]
      : []),
    ...(values.background
      ? [
          'Background capture uses a visible inactive, nonfocusable window, CDP focus emulation and disabled background throttling. Compare only runs with the same mode; this does not replace foreground spot checks.',
        ]
      : []),
  ],
}
const bareBundle = join(output, '_bare', 'bare-input.js')
if (bare) {
  const { build } = await import('esbuild')
  const bundle = await build({
    entryPoints: [resolve('scripts/bare-input.ts')],
    outfile: bareBundle,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome152',
    minify: true,
    metafile: true,
    loader: { '.woff2': 'file' },
    logLevel: 'warning',
  })
  const appScripts = Object.keys(bundle.metafile.inputs).filter(
    (path) => path.startsWith('src/') && !path.endsWith('.css'),
  )
  assert.deepEqual(
    appScripts,
    [],
    'Engine-only fixture must not import Hibi application scripts',
  )
  summary.bareBundleSha256 = createHash('sha256')
    .update(await readFile(bareBundle))
    .digest('hex')
  summary.bareStylesSha256 = createHash('sha256')
    .update(await readFile(bareBundle.replace(/\.js$/, '.css')))
    .digest('hex')
  summary.bareMainSha256 = createHash('sha256')
    .update(await readFile(resolve('scripts/bare-input-main.mjs')))
    .digest('hex')
  summary.bareApplicationScripts = appScripts
}
console.log(output)
const sleep = (ms) => new Promise((done) => setTimeout(done, Math.max(0, ms)))
async function deadline(promise, ms, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${ms} ms`)),
          ms,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
function documentText(size, shape) {
  const words = [
    'alpha',
    'beta',
    'gamma',
    'delta',
    'epsilon',
    'zeta',
    'eta',
    'theta',
    'iota',
    'kappa',
  ]
  if (size === 'words')
    return Array.from(
      { length: 100000 },
      (_, index) =>
        `${index ? (shape === 'paragraphs' && index % 20 === 0 ? '\n\n' : ' ') : ''}${words[index % words.length]}`,
    ).join('')
  const unit = words.join(' ') + (shape === 'paragraphs' ? '\n\n' : ' ')
  let text = unit.repeat(Math.ceil(100000 / unit.length)).slice(0, 100000)
  if (text.endsWith('\n')) text = `${text.slice(0, -1)}z`
  return text
}

function benchmarkDocument() {
  return window.__bareInput
    ? window.__bareInput.getDocument()
    : window.__inputPaintContext.editor.getDocument()
}
async function installProbe(profile) {
  const addon = join(profile, 'installed-addons', 'input-paint-probe')
  await mkdir(addon, { recursive: true })
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'input-paint-probe',
      name: 'Input paint probe',
      description: 'Benchmark-only input timing callbacks',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Benchmark' }],
      capabilities: ['source'],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(addon, 'index.js'),
    `export default sdk => ({start(context) {
    window.__inputPaintSdk = sdk; window.__inputPaintContext = context;
  }});`,
  )
  await writeFile(join(profile, 'addons.json'), JSON.stringify(addons))
}
function instrument({ target, offset, fileVisual, requestedPosition }) {
  const bare = window.__bareInput,
    codeMirror = bare?.codeMirror ?? window.__inputPaintSdk.codeMirror,
    sourceElement = document.querySelector('.cm-content'),
    sourceView =
      bare?.sourceView ??
      (sourceElement
        ? codeMirror.view.EditorView.findFromDOM(sourceElement)
        : null),
    rich = document.querySelector('.tiptap')?.editor,
    richView = bare?.richView ?? rich?.view,
    view = target === 'source' ? sourceView : richView,
    element = target === 'source' ? sourceView.contentDOM : richView.dom
  const measurement = {
    phase: 'setup',
    target,
    records: [],
    scroll: [],
    spans: [],
    methods: [],
    version: 0,
    pending: [],
    latest: null,
    frame: 0,
    timeOrigin: performance.timeOrigin,
    events: { keydown: 0, beforeinput: 0, input: 0, changes: 0 },
  }
  const mark = (name) =>
    performance.mark(`input-paint:${measurement.phase}:${name}`)
  const timed = (object, method, label, receiver, after) => {
    const original = object?.[method]
    if (typeof original !== 'function') return
    measurement.methods.push(label)
    const wrapped = function (...args) {
      if (receiver && this !== receiver()) return original.apply(this, args)
      const started = performance.now(),
        phase = measurement.phase,
        keyId = measurement.latest?.id
      try {
        const result = original.apply(this, args)
        after?.(args)
        return result
      } finally {
        const ended = performance.now()
        if (measurement.spans.length < 20000) {
          const id = measurement.spans.length + 1
          measurement.spans.push({
            id,
            label,
            phase,
            keyId,
            started,
            duration: ended - started,
            inputChars:
              typeof args[0] === 'string' ? args[0].length : undefined,
          })
          performance.measure(`input-paint:${phase}:span:${label}:${id}`, {
            start: started,
            end: ended,
          })
        }
      }
    }
    object[method] = wrapped
  }
  const attached = new WeakSet()
  measurement.attachRich = (editor) => {
    if (attached.has(editor)) return
    attached.add(editor)
    timed(editor.markdown, 'parse', 'rich.markdown.parse')
    timed(editor, 'getMarkdown', 'rich.getMarkdown')
    timed(editor.view, 'updateState', 'rich.view.updateState')
    const holder = { dispatch: editor.view.props.dispatchTransaction }
    timed(holder, 'dispatch', 'rich.dispatchTransaction')
    if (holder.dispatch)
      editor.view.setProps({ dispatchTransaction: holder.dispatch })
  }
  // Observe the mounted native editor without registering an addon rich hook:
  // unknown rich hooks intentionally disable audited codec fast paths.
  if (rich && !rich.isDestroyed) measurement.attachRich(rich)
  if (bare?.richView) measurement.attachRich({ view: bare.richView })
  if (sourceView) {
    timed(
      sourceView,
      'update',
      'source.view.update',
      undefined,
      ([transactions]) => {
        measurement.model('source', {
          docChanged: transactions.some(
            (transaction) => transaction.docChanged,
          ),
          selectionSet: transactions.some(
            (transaction) => transaction.selection !== undefined,
          ),
        })
      },
    )
    timed(
      Object.getPrototypeOf(sourceView.state),
      'update',
      'source.state.update',
      () => sourceView.state,
    )
  }
  const selectionHead = () =>
    target === 'source'
      ? view.state.selection.main.head
      : view.state.selection.head
  measurement.placement = () => {
    const head = selectionHead(),
      caret = view.coordsAtPos(head),
      scroller =
        target === 'source' ? view.scrollDOM : element.closest('.rich-pane'),
      rect = scroller.getBoundingClientRect(),
      viewport = {
        left: Math.max(0, rect.left),
        right: Math.min(innerWidth, rect.right),
        top: Math.max(0, rect.top),
        bottom: Math.min(innerHeight, rect.bottom),
      },
      focused = target === 'source' ? view.hasFocus : view.hasFocus()
    return {
      head,
      focused,
      caret: caret
        ? {
            left: caret.left,
            right: caret.right,
            top: caret.top,
            bottom: caret.bottom,
          }
        : null,
      viewport,
      scrollTop: scroller.scrollTop,
      scrollLeft: scroller.scrollLeft,
      visible:
        !!caret &&
        focused &&
        [caret.left, caret.right, caret.top, caret.bottom].every(
          Number.isFinite,
        ) &&
        caret.left >= viewport.left - 1 &&
        caret.right <= viewport.right + 1 &&
        caret.top >= viewport.top - 1 &&
        caret.bottom <= viewport.bottom + 1,
    }
  }
  measurement.prepareSelection = (key, count) => {
    const current =
        target === 'source' ? view.state.selection.main : view.state.selection,
      direction = key === 'ArrowRight' ? 1 : -1
    if (current.anchor !== current.head)
      throw new Error('Selection probe must begin at a caret.')
    let head = current.head
    if (target === 'source') {
      let range = current
      for (let index = 0; index < count; index++) {
        const forward =
          direction > 0 ===
          (view.textDirectionAt(range.head) === codeMirror.view.Direction.LTR)
        range = view.moveByChar(range, forward)
      }
      head = range.head
    } else {
      if (getComputedStyle(element).direction !== 'ltr')
        throw new Error(
          'Visual selection oracle requires a left-to-right fixture.',
        )
      const doc = view.state.doc,
        Selection = current.constructor,
        graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      for (let index = 0; index < count; index++) {
        const position = doc.resolve(head),
          adjacent = direction > 0 ? position.nodeAfter : position.nodeBefore
        if (adjacent?.isText) {
          const text = adjacent.text,
            part = graphemes
              .segment(text)
              .containing(direction > 0 ? 0 : text.length - 1)
          head += direction * part.segment.length
        } else if (adjacent?.isInline) head += direction * adjacent.nodeSize
        else
          head =
            Selection.findFrom(
              doc.resolve(
                Math.max(0, Math.min(doc.content.size, head + direction)),
              ),
              direction,
              true,
            )?.head ?? head
      }
    }
    measurement.selection = {
      key,
      count,
      expected: { anchor: current.anchor, head },
      frame: 0,
    }
    return { key, count, expected: measurement.selection.expected }
  }
  const selectionFrame = () => {
    const selection = measurement.selection
    selection.frame = 0
    const model =
        target === 'source' ? view.state.selection.main : view.state.selection,
      dom = window.getSelection(),
      records = measurement.records.filter(
        (record) => record.phase === 'selection',
      )
    let domAnchor = null,
      domHead = null,
      caret = null
    try {
      if (dom?.anchorNode && dom.focusNode) {
        domAnchor = view.posAtDOM(dom.anchorNode, dom.anchorOffset)
        domHead = view.posAtDOM(dom.focusNode, dom.focusOffset)
      }
      caret = view.coordsAtPos(model.head)
    } catch {}
    const pane =
        element.closest(target === 'source' ? '.source-pane' : '.rich-pane') ??
        element,
      clip = pane.getBoundingClientRect(),
      matches =
        model.anchor === selection.expected.anchor &&
        model.head === selection.expected.head &&
        domAnchor === model.anchor &&
        domHead === model.head,
      inViewport =
        caret &&
        caret.bottom > caret.top &&
        caret.bottom > Math.max(0, clip.top) &&
        caret.top < Math.min(innerHeight, clip.bottom) &&
        caret.right >= Math.max(0, clip.left) &&
        caret.left <= Math.min(innerWidth, clip.right)
    selection.probe = {
      at: performance.now(),
      received: records.length,
      model: { anchor: model.anchor, head: model.head },
      dom: { anchor: domAnchor, head: domHead },
      caret: caret
        ? {
            left: caret.left,
            right: caret.right,
            top: caret.top,
            bottom: caret.bottom,
          }
        : null,
      clip: {
        left: clip.left,
        right: clip.right,
        top: clip.top,
        bottom: clip.bottom,
      },
      matches,
      inViewport: Boolean(inViewport),
    }
    if (records.length === selection.count && matches && inViewport) {
      selection.visibleFrameAt = performance.now()
      selection.coalescedModelIds = records
        .filter((record) => record.modelAt === undefined)
        .map((record) => record.id)
      const last = records.at(-1)
      for (const record of records) {
        record.selectionOutcome =
          record === last
            ? 'final-endpoint'
            : record.modelAt === undefined
              ? 'coalesced-before-model'
              : 'intermediate-model-only'
        record.selectionEndpointId = last.id
      }
      mark('selection-endpoint')
      requestAnimationFrame(() => {
        selection.nextFrameAt = performance.now()
        mark('selection-next-frame')
      })
    } else selection.frame = requestAnimationFrame(selectionFrame)
  }
  const visible = () => {
    const head = selectionHead(),
      from = head - 1
    if (from < (target === 'source' ? 0 : 1)) return null
    const expected =
      target === 'source'
        ? view.state.doc.sliceString(from, head)
        : view.state.doc.textBetween(from, head)
    const start = view.domAtPos(from),
      end = view.domAtPos(head),
      range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    if (!expected || range.toString() !== expected) return null
    const pane =
        element.closest(target === 'source' ? '.source-pane' : '.rich-pane') ??
        element,
      clip = pane.getBoundingClientRect(),
      rect = range.getBoundingClientRect()
    if (
      !rect.width ||
      !rect.height ||
      rect.bottom <= Math.max(0, clip.top) ||
      rect.top >= Math.min(innerHeight, clip.bottom) ||
      rect.right <= Math.max(0, clip.left) ||
      rect.left >= Math.min(innerWidth, clip.right)
    )
      return null
    return {
      head,
      text: expected,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    }
  }
  const frame = () => {
    measurement.frame = 0
    let glyph
    try {
      glyph = visible()
    } catch {}
    if (glyph) {
      const now = performance.now(),
        batch = measurement.pending.splice(0)
      for (const record of batch) {
        record.visibleFrameAt = now
        record.visible = glyph
        mark(`visible:${record.id}`)
      }
      requestAnimationFrame(() => {
        for (const record of batch) {
          record.nextFrameAt = performance.now()
          mark(`next-frame:${record.id}`)
        }
      })
    }
    if (measurement.pending.length)
      measurement.frame = requestAnimationFrame(frame)
  }
  element.addEventListener(
    'keydown',
    (event) => {
      if (
        !['x', 's', 'Backspace', 'ArrowRight', 'ArrowLeft'].includes(event.key)
      )
        return
      const record = {
        id: measurement.records.length + 1,
        phase: measurement.phase,
        key: event.key,
        repeat: event.repeat,
        eventTime: event.timeStamp,
        keydownAt: performance.now(),
        eventEpoch: performance.timeOrigin + event.timeStamp,
      }
      measurement.records.push(record)
      measurement.latest = record
      measurement.events.keydown++
      mark(`keydown:${record.id}`)
      if (
        measurement.phase === 'selection' &&
        measurement.selection &&
        !measurement.selection.frame
      )
        measurement.selection.frame = requestAnimationFrame(selectionFrame)
      queueMicrotask(() => {
        record.keydownMicrotaskAt = performance.now()
      })
    },
    true,
  )
  window.addEventListener('keydown', (event) => {
    const record = measurement.latest
    if (record?.eventTime !== event.timeStamp) return
    record.keydownBubbleEndAt = performance.now()
    mark(`keydown-end:${record.id}`)
  })
  window.addEventListener('beforeinput', () => {
    const record = measurement.latest
    if (!record) return
    record.beforeinputBubbleEndAt = performance.now()
    mark(`beforeinput-end:${record.id}`)
  })
  element.addEventListener(
    'beforeinput',
    (event) => {
      measurement.events.beforeinput++
      if (measurement.latest) {
        measurement.latest.beforeinputAt = performance.now()
        measurement.latest.inputType = event.inputType
        mark(`beforeinput:${measurement.latest.id}`)
      }
    },
    true,
  )
  element.addEventListener(
    'input',
    () => {
      measurement.events.input++
      if (measurement.latest) measurement.latest.inputAt = performance.now()
    },
    true,
  )
  measurement.model = (surface, update) => {
    if (surface !== target || (!update.docChanged && !update.selectionSet))
      return
    const record = measurement.latest
    if (!record || record.modelAt !== undefined) return
    if (!update.docChanged && !record.key.startsWith('Arrow')) return
    if (update.docChanged) measurement.events.changes++
    record.modelAt = performance.now()
    record.docChanged = update.docChanged
    record.version = ++measurement.version
    record.head = selectionHead()
    mark(`model:${record.id}`)
    if (record.phase === 'selection') return
    measurement.pending.push(record)
    if (!measurement.frame) measurement.frame = requestAnimationFrame(frame)
  }
  window.addEventListener(
    'scroll',
    (event) => {
      if (measurement.phase !== 'scroll') return
      const record = {
        at: performance.now(),
        top: event.target.scrollTop ?? scrollY,
      }
      measurement.scroll.push(record)
      requestAnimationFrame(() => {
        record.frameAt = performance.now()
      })
    },
    true,
  )
  measurement.dump = () => ({
    target,
    phase: measurement.phase,
    timeOrigin: measurement.timeOrigin,
    events: measurement.events,
    records: measurement.records,
    selection: measurement.selection,
    scroll: measurement.scroll,
    spans: measurement.spans,
    methods: measurement.methods,
    pending: measurement.pending.length,
    focused: document.hasFocus(),
    finalVisibleRanges: target === 'source' ? view.visibleRanges : null,
    finalRenderedElements: element.querySelectorAll('*').length,
  })
  window.__inputPaint = measurement
  rich?.on('transaction', ({ transaction }) =>
    measurement.model('visual', {
      docChanged: transaction.docChanged,
      selectionSet: transaction.selectionSet,
    }),
  )
  bare?.onRichTransaction((update) => measurement.model('visual', update))
  if (target === 'source') {
    // Split scroll leadership follows focus when the selection update fires.
    view.focus()
    view.dispatch({
      selection: { anchor: offset },
      effects: codeMirror.view.EditorView.scrollIntoView(offset, {
        y: 'center',
      }),
    })
  } else {
    let raw = 0,
      position = null
    let blockIndex = null,
      blockCount = null
    if (fileVisual) {
      const blocks = []
      richView.state.doc.descendants((node, pos) => {
        if (!node.isTextblock || node.isAtom) return
        blocks.push({ node, pos })
        return false
      })
      if (!blocks.length)
        throw new Error('The document has no editable textblock.')
      blockCount = blocks.length
      blockIndex =
        requestedPosition === 'start'
          ? 0
          : requestedPosition === 'end'
            ? blocks.length - 1
            : Math.floor(blocks.length / 2)
      const block = blocks[blockIndex]
      let within =
        requestedPosition === 'start'
          ? 0
          : requestedPosition === 'end'
            ? block.node.content.size
            : Math.floor(block.node.content.size / 2)
      const seam = block.node.textBetween(
        Math.max(0, within - 1),
        Math.min(block.node.content.size, within + 1),
      )
      if (/^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(seam)) within++
      position = block.pos + 1 + within
    } else
      richView.state.doc.forEach((node, pos) => {
        if (
          position === null &&
          offset >= raw &&
          offset <= raw + node.textContent.length
        )
          position = pos + 1 + offset - raw
        raw += node.textContent.length + 2
      })
    if (position === null)
      throw new Error('Could not map plain fixture offset into visual editor')
    if (bare) bare.setRichSelection(position)
    else rich.chain().setTextSelection(position).focus().scrollIntoView().run()
    return {
      basis: fileVisual ? 'visual-textblock' : 'plain-source-offset',
      richPosition: position,
      blockIndex,
      blockCount,
      textOffset: richView.state.doc.textBetween(0, position, '').length,
      baselineText: fileVisual ? richView.state.doc.textContent : null,
    }
  }
  return { basis: 'normalized-source-offset', editorOffset: offset }
}
async function writeProfile(path, profile) {
  const file = await open(path, 'wx')
  try {
    await file.write('{')
    let separator = ''
    for (const [key, value] of Object.entries(profile)) {
      await file.write(`${separator}${JSON.stringify(key)}:`)
      if (Array.isArray(value)) {
        await file.write('[')
        for (let from = 0; from < value.length; from += 4096)
          await file.write(
            `${from ? ',' : ''}${value
              .slice(from, from + 4096)
              .map((item) => JSON.stringify(item))
              .join(',')}`,
          )
        await file.write(']')
      } else await file.write(JSON.stringify(value))
      separator = ','
    }
    await file.write('}')
  } finally {
    await file.close()
  }
}
async function runCase(config) {
  const name = [
      config.mode,
      config.target,
      config.size,
      config.shape,
      config.position,
    ].join('-'),
    directory = join(output, name),
    profile = join(directory, 'profile'),
    file = join(directory, 'fixture.md'),
    source = fileText ?? documentText(config.size, config.shape),
    fileVisual = sourceFile !== null && config.target === 'visual'
  await mkdir(directory)
  if (!bare) await installProbe(profile)
  await writeFile(file, source)
  const barePage = join(directory, 'bare.html')
  let bareConfigurationSha256 = null
  if (bare) {
    const assetUrl = (path) => pathToFileURL(path).href.replaceAll('&', '&amp;')
    const initial = JSON.stringify({
      mode: config.mode,
      target: config.target,
      source,
      markdownEnabled: !!values['bare-markdown'],
    }).replaceAll('<', '\\u003c')
    bareConfigurationSha256 = createHash('sha256').update(initial).digest('hex')
    await writeFile(
      barePage,
      `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${assetUrl(bareBundle.replace(/\.js$/, '.css'))}"></head><body><script>window.__bareConfig=${initial}</script><script type="module" src="${assetUrl(bareBundle)}"></script></body></html>`,
    )
  }
  let offset =
    config.position === 'start'
      ? 0
      : config.position === 'end'
        ? source.length
        : Math.floor(source.length / 2)
  while (source[offset] === '\n') offset++
  if (
    /^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(
      source.slice(offset - 1, offset + 1),
    )
  )
    offset++
  const editorOffset = source.slice(0, offset).replace(/\r\n/g, '\n').length
  const result = {
    ...config,
    name,
    directory,
    engine: bare ? 'engine-only' : 'hibi',
    bareMarkdown: bare ? !!values['bare-markdown'] : null,
    bareConfigurationSha256,
    addons: bare ? {} : addons,
    integrityScope: bare
      ? 'native-engine-history-and-runner-written-snapshot'
      : 'hibi-canonical-history-and-ipc-disk-save',
    sourceFile,
    chars: source.length,
    words: source.match(/\S+/g)?.length ?? 0,
    fixtureSha256: createHash('sha256').update(source).digest('hex'),
    offset: fileVisual ? null : offset,
    holdMs,
    idleMs: 2000,
    rate,
    repetitions,
    dispatched: [],
    saves: [],
    status: 'running',
    statusScope,
  }
  summary.cases.push(result)
  let app
  try {
    app = bare
      ? await electron.launch({
          timeout: 30000,
          args: [
            resolve('scripts/bare-input-main.mjs'),
            `--fixture=${barePage}`,
            `--user-data-dir=${profile}`,
          ],
        })
      : await launchBenchmarkApp(profile)
  } catch (error) {
    result.status = 'failed'
    result.error = error.stack ?? String(error)
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify(result, null, 2),
    )
    throw error
  }
  let page,
    session,
    finishTrace,
    placement,
    tracing = false,
    profiling = false
  const watchdog = setTimeout(
    () => app.process().kill('SIGKILL'),
    holdMs * 2 + 180000,
  )
  try {
    result.nativeRuntime = await app.evaluate(() => process.versions)
    page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    if (!bare && values['fixed-chrome']) {
      await page.evaluate(() => {
        localStorage.setItem('hide-titlebar', 'false')
        localStorage.setItem(
          'hibi:toolbar',
          JSON.stringify({
            ...JSON.parse(localStorage.getItem('hibi:toolbar') ?? '{}'),
            autoHide: false,
          }),
        )
      })
      await page.reload()
    }
    session = await page.context().newCDPSession(page)
    result.windowMode = await app.evaluate(({ BrowserWindow }, background) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (background) {
        win.setFocusable(false)
        win.webContents.setBackgroundThrottling(false)
        win.showInactive()
      } else {
        win.setFocusable(true)
        win.show()
        win.focus()
      }
      return {
        mode: background ? 'visible-inactive-focus-emulated' : 'foreground',
        focusEmulation: background,
        visible: win.isVisible(),
        focusable: win.isFocusable(),
        focused: win.isFocused(),
        backgroundThrottling: win.webContents.getBackgroundThrottling(),
      }
    }, !!values.background)
    if (values.background)
      await session.send('Emulation.setFocusEmulationEnabled', {
        enabled: true,
      })
    if (bare) {
      await page.waitForFunction(() => !!window.__bareInput)
      result.engineConfiguration = await page.evaluate(
        () => window.__bareInput.engineMetadata,
      )
    } else {
      await waitForEditor(page)
      await page.waitForFunction(() => !!window.__inputPaintContext)
      if (config.mode === 'source') await switchToSource(app, page)
      if (config.mode === 'split')
        await pressShortcut(
          app,
          `${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+\\`,
        )
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        })
      }, file)
      await clickMenu(app, 'Open…')
    }
    await page.waitForFunction(
      (text) =>
        (window.__bareInput
          ? window.__bareInput.getDocument()
          : window.__inputPaintContext.editor.getDocument()
        )?.markdown === text,
      source,
      { timeout: 60000 },
    )
    const readiness = await page.waitForFunction((target) => {
      const element = document.querySelector(
        target === 'source' ? '.cm-content' : '.tiptap',
      )
      const notice =
        target === 'visual'
          ? document.querySelector(
              '.rich-editor-host .source-notice .document-notice',
            )
          : null
      if (
        notice &&
        !notice.closest('[hidden], [inert], [aria-hidden="true"]') &&
        notice.getBoundingClientRect().width > 0 &&
        getComputedStyle(notice).visibility === 'visible'
      )
        return { status: 'unavailable', notice: notice.textContent.trim() }
      if (
        document.hasFocus() &&
        element?.isContentEditable &&
        !element.closest('[inert]') &&
        element.getBoundingClientRect().width > 0 &&
        document.querySelector('.app-shell')?.getAttribute('aria-busy') !==
          'true'
      )
        return { status: 'ready' }
      return false
    }, config.target)
    const ready = await readiness.jsonValue()
    await readiness.dispose()
    await page.evaluate(() => document.fonts.ready.then(() => {}))
    const measureGeometry = () => {
      const measure = (selector, textSelector = selector) => {
        const element = document.querySelector(selector)
        if (!element) return null
        const rect = element.getBoundingClientRect(),
          style = getComputedStyle(
            document.querySelector(textSelector) ?? element,
          )
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          scrollTop: element.scrollTop,
          scrollLeft: element.scrollLeft,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          fontKerning: style.fontKerning,
          fontFeatureSettings: style.fontFeatureSettings,
          fontVariantLigatures: style.fontVariantLigatures,
          textRendering: style.textRendering,
          whiteSpace: style.whiteSpace,
          overflowWrap: style.overflowWrap,
          padding: style.padding,
        }
      }
      return {
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        fonts: document.fonts.status,
        source: measure('.source-pane', '.cm-scroller'),
        sourceScroller: measure('.cm-scroller'),
        sourceContent: measure('.cm-content'),
        visual: measure('.rich-pane', '.tiptap'),
        visualContent: measure('.tiptap'),
      }
    }
    result.geometry = await page.evaluate(measureGeometry)
    if (ready.status === 'unavailable') {
      const screenshot = join(directory, 'preservation-notice.png')
      result.unavailable = {
        reason: 'source-preservation',
        notice: ready.notice,
        screenshot,
      }
      await page.screenshot({ path: screenshot, timeout: 5000 })
      if (!fileVisual)
        throw new Error(
          `Generated visual fixture is unexpectedly protected: ${ready.notice}`,
        )
      assert.equal(
        await page.evaluate(
          () => window.__inputPaintContext.editor.getDocument().markdown,
        ),
        source,
        'Protected document source changed before input',
      )
      assert.equal(
        await readFile(file, 'utf8'),
        source,
        'Protected fixture bytes changed before input',
      )
      result.preservation = { canonicalUnchanged: true, diskUnchanged: true }
      result.status = 'unavailable'
      process.exitCode = 1
      return
    }
    placement = await page.evaluate(instrument, {
      target: config.target,
      offset: config.target === 'source' ? editorOffset : offset,
      fileVisual,
      requestedPosition: config.position,
    })
    result.selectedPosition = { ...placement }
    delete result.selectedPosition.baselineText
    const expectedHead = placement.editorOffset ?? placement.richPosition
    try {
      const placed = await page.waitForFunction(
        (expectedHead) => {
          const caret = window.__inputPaint.placement()
          return caret.visible && caret.head === expectedHead
        },
        expectedHead,
        { timeout: 5000 },
      )
      await placed.dispose()
    } finally {
      result.geometryAfterPlacement = await page.evaluate(measureGeometry)
      result.placementVisibility = await page.evaluate(() =>
        window.__inputPaint.placement(),
      )
    }
    assert.equal(result.placementVisibility.head, expectedHead)
    assert.ok(
      result.placementVisibility.visible,
      `Initial caret is not focused inside the editor viewport: ${JSON.stringify(result.placementVisibility)}`,
    )
    const clockBefore = performance.timeOrigin + performance.now(),
      rendererEpoch = await page.evaluate(
        () => performance.timeOrigin + performance.now(),
      ),
      clockAfter = performance.timeOrigin + performance.now()
    result.clockCalibration = {
      hostBeforeEpoch: clockBefore,
      rendererEpoch,
      hostAfterEpoch: clockAfter,
    }
    finishTrace = createTraceFinalizer(session, join(directory, 'trace.json'))
    result.traceCategories = [
      'input',
      'latencyInfo',
      'devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'blink.user_timing',
      'v8',
      'cc',
      'viz',
      ...(values['cpu-profile'] ? ['toplevel'] : []),
      ...(values['trace-screenshots']
        ? ['disabled-by-default-devtools.screenshot']
        : []),
    ]
    await session.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      streamFormat: 'json',
      categories: result.traceCategories.join(','),
      screenshotMaxSize: 800,
      screenshotMaxCount: 24,
    })
    tracing = true
    const key = (character) =>
      character === 'Backspace'
        ? { key: character, code: character, windowsVirtualKeyCode: 8 }
        : character.startsWith('Arrow')
          ? {
              key: character,
              code: character,
              windowsVirtualKeyCode: character === 'ArrowRight' ? 39 : 37,
              modifiers: 8,
            }
          : {
              key: character,
              code: `Key${character.toUpperCase()}`,
              windowsVirtualKeyCode: character.toUpperCase().charCodeAt(0),
              text: character,
              unmodifiedText: character,
            }
    async function dispatch(phase, character, count, duration) {
      await page.evaluate((phase) => {
        window.__inputPaint.phase = phase
        window.__inputPaint.latest = null
        performance.mark(`input-paint:${phase}:start`)
      }, phase)
      const start = performance.now(),
        flights = []
      for (let index = 0; index < count; index++) {
        const scheduled = start + (duration ? (index * duration) / count : 0)
        if (duration) await sleep(scheduled - performance.now())
        const sent = performance.now(),
          generatedEpoch = performance.timeOrigin + sent,
          record = {
            phase,
            index,
            character,
            scheduledEpoch: performance.timeOrigin + scheduled,
            generatedEpoch,
          }
        result.dispatched.push(record)
        flights.push(
          session
            .send('Input.dispatchKeyEvent', {
              type: 'keyDown',
              ...key(character),
              autoRepeat: index > 0,
              timestamp: generatedEpoch / 1000,
            })
            .then(
              () => {
                record.ackEpoch = performance.timeOrigin + performance.now()
              },
              (error) => {
                record.error = error.message
              },
            ),
        )
      }
      // Keyup follows every queued repeat; waiting for paint never controls cadence.
      if (duration) await sleep(start + duration - performance.now())
      flights.push(
        session.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          ...key(character),
          text: '',
          unmodifiedText: '',
        }),
      )
      await deadline(Promise.all(flights), settleMs, `${phase} dispatch queue`)
      assert.equal(
        result.dispatched.filter((row) => row.phase === phase && row.error)
          .length,
        0,
        `${phase}: input dispatch failed`,
      )
    }
    let acceptedSource = source
    async function save(expected, stage, expectedRichText) {
      const startedEpoch = performance.timeOrigin + performance.now()
      await page.evaluate(
        (stage) => performance.mark(`input-paint:save:${stage}:start`),
        stage,
      )
      if (expectedRichText !== undefined) {
        const accepted = await deadline(
          page.evaluate(() => ({
            text: document.querySelector('.tiptap').editor.state.doc
              .textContent,
            source: window.__inputPaintContext.editor.getDocument().markdown,
          })),
          settleMs,
          `${stage} rich input validation`,
        )
        assert.equal(
          accepted.text,
          expectedRichText,
          `${stage}: rich document omitted or changed accepted input`,
        )
        assert.notEqual(
          accepted.source,
          acceptedSource,
          `${stage}: rich input was not committed to canonical source`,
        )
        expected = accepted.source
      }
      const saved = await deadline(
        bare
          ? page.evaluate(benchmarkDocument)
          : page.evaluate(() => window.hibi.saveDocument(false)),
        settleMs,
        `${stage} save`,
      )
      if (bare) await writeFile(file, saved.markdown)
      assert.equal(
        saved.markdown,
        expected,
        `${stage}: ${bare ? 'engine snapshot' : 'native save'} omitted or changed input`,
      )
      assert.equal(
        await readFile(file, 'utf8'),
        expected,
        `${stage}: disk differs from accepted input`,
      )
      assert.equal(
        (await page.evaluate(benchmarkDocument)).markdown,
        expected,
        `${stage}: renderer differs from accepted input`,
      )
      result.saves.push({
        stage,
        method: bare ? 'runner-written-engine-snapshot' : 'hibi-ipc-save',
        chars: expected.length,
        verified: true,
        startedEpoch,
        finishedEpoch: performance.timeOrigin + performance.now(),
      })
      acceptedSource = expected
      return expected
    }
    async function settle(phase, count) {
      await page.waitForFunction(
        ({ phase, count }) => {
          const records = window.__inputPaint.records.filter(
            (row) => row.phase === phase,
          )
          return (
            records.length === count &&
            records.every(
              (row) =>
                row.modelAt !== undefined && row.nextFrameAt !== undefined,
            )
          )
        },
        { phase, count },
        { timeout: settleMs },
      )
    }
    const rawFirst = `${source.slice(0, offset)}x${source.slice(offset)}`,
      richFirst = fileVisual
        ? `${placement.baselineText.slice(0, placement.textOffset)}x${placement.baselineText.slice(placement.textOffset)}`
        : undefined
    await sleep(2000)
    if (values['cpu-profile']) {
      await deadline(
        session.send('Profiler.enable'),
        5000,
        'CPU profiler enable',
      )
      await deadline(
        session.send('Profiler.setSamplingInterval', { interval: 1000 }),
        5000,
        'CPU profiler interval',
      )
      await deadline(session.send('Profiler.start'), 5000, 'CPU profiler start')
      profiling = true
    }
    await dispatch('first-after-idle', 'x', 1, 0)
    await settle('first-after-idle', 1)
    const first = await save(rawFirst, 'first-after-visible', richFirst)
    let final = first
    await page.screenshot({ path: join(directory, 'first-key.png') })
    if (repetitions) {
      await dispatch('hold-s', 's', repetitions, holdMs)
      await save(
        `${source.slice(0, offset)}x${'s'.repeat(repetitions)}${source.slice(offset)}`,
        'hold-immediate',
        fileVisual
          ? `${placement.baselineText.slice(0, placement.textOffset)}x${'s'.repeat(repetitions)}${placement.baselineText.slice(placement.textOffset)}`
          : undefined,
      )
      await settle('hold-s', repetitions)
      await dispatch('hold-backspace', 'Backspace', repetitions, holdMs)
      final = await save(first, 'backspace-immediate', richFirst)
      await settle('hold-backspace', repetitions)
    }
    const selectionKey = (
      fileVisual
        ? config.position === 'end'
        : offset === source.length
    )
      ? 'ArrowLeft'
      : 'ArrowRight'
    result.selectionPlan = await page.evaluate(
      (key) => window.__inputPaint.prepareSelection(key, 20),
      selectionKey,
    )
    await dispatch('selection', selectionKey, 20, 500)
    await page.waitForFunction(
      () => window.__inputPaint.selection?.nextFrameAt !== undefined,
      undefined,
      { timeout: settleMs },
    )
    result.selection = await page.evaluate(() => window.__inputPaint.selection)
    assert.deepEqual(
      result.selection.probe.model,
      result.selectionPlan.expected,
      'Final model selection differs from the planned range',
    )
    assert.deepEqual(
      result.selection.probe.dom,
      result.selectionPlan.expected,
      'Final DOM selection differs from the planned range',
    )
    assert.equal((await page.evaluate(benchmarkDocument)).markdown, final)
    const scroll = await page.evaluate(() => {
      const state = window.__inputPaint
      state.phase = 'scroll'
      let element = document.querySelector(
        state.target === 'source' ? '.cm-scroller' : '.tiptap',
      )
      while (element && element.scrollHeight <= element.clientHeight + 5)
        element = element.parentElement
      if (!element) throw new Error('Fixture has no scrollable editor')
      const rect = element.getBoundingClientRect()
      return {
        x: Math.max(1, Math.min(innerWidth - 1, rect.x + rect.width / 2)),
        y: Math.max(1, Math.min(innerHeight - 1, rect.y + rect.height / 2)),
        delta:
          element.scrollTop + element.clientHeight >= element.scrollHeight - 2
            ? -500
            : 500,
      }
    })
    await page.mouse.move(scroll.x, scroll.y)
    await page.mouse.wheel(0, scroll.delta)
    await page.waitForFunction(
      () => window.__inputPaint.scroll.some((row) => row.frameAt !== undefined),
      undefined,
      { timeout: settleMs },
    )
    result.renderer = await page.evaluate(() => window.__inputPaint.dump())
    result.traceCollection = await finishTrace()
    tracing = false
    const history = await deadline(
      page.evaluate(
        async ({ source, final, target, initialRichText, finalRichText }) => {
          const bare = window.__bareInput,
            context = window.__inputPaintContext,
            sdk = window.__inputPaintSdk,
            rich = document.querySelector('.tiptap')?.editor,
            richView = bare?.richView ?? rich?.view,
            getDocument = () =>
              bare ? bare.getDocument() : context.editor.getDocument(),
            view =
              target === 'source'
                ? (bare?.sourceView ??
                  sdk.codeMirror.view.EditorView.findFromDOM(
                    document.querySelector('.cm-content'),
                  ))
                : null
          window.__inputPaint.phase = 'validation'
          window.__inputPaint.latest = null
          let undos = 0
          while (getDocument().markdown !== source && undos < 128) {
            const done = bare
              ? bare.undo()
              : target === 'source'
                ? sdk.codeMirror.commands.undo(view)
                : rich.commands.undo()
            if (!done)
              throw new Error(
                'Undo ended before the original fixture was restored',
              )
            undos++
          }
          if (getDocument().markdown !== source)
            throw new Error('Undo did not restore original source exactly')
          if (
            initialRichText !== undefined &&
            richView.state.doc.textContent !== initialRichText
          )
            throw new Error(
              'Undo did not restore original rich document text exactly',
            )
          for (let index = 0; index < undos; index++) {
            const done = bare
              ? bare.redo()
              : target === 'source'
                ? sdk.codeMirror.commands.redo(view)
                : rich.commands.redo()
            if (!done)
              throw new Error(
                'Redo ended before all accepted input was restored',
              )
          }
          if (getDocument().markdown !== final)
            throw new Error('Redo did not restore all accepted input exactly')
          if (
            finalRichText !== undefined &&
            richView.state.doc.textContent !== finalRichText
          )
            throw new Error(
              'Redo did not restore accepted rich document text exactly',
            )
          return {
            undos,
            restoredOriginal: true,
            restoredFinal: true,
            method: bare ? 'native-engine-history' : 'hibi-canonical-history',
          }
        },
        {
          source,
          final,
          target: config.target,
          initialRichText: fileVisual ? placement.baselineText : undefined,
          finalRichText: richFirst,
        },
      ),
      settleMs,
      'undo/redo validation',
    )
    result.history = history
    await save(final, 'redo')
    result.status = 'passed'
  } catch (error) {
    result.status = 'failed'
    result.error = error.stack ?? String(error)
    if (page)
      result.renderer = await deadline(
        page.evaluate(() => window.__inputPaint?.dump()),
        2000,
        'partial measurement',
      ).catch(() => null)
    throw error
  } finally {
    if (profiling) {
      try {
        const { profile } = await deadline(
          session.send('Profiler.stop'),
          5000,
          'CPU profiler stop',
        )
        result.cpuProfile = join(directory, 'CPUprofile.json')
        await deadline(
          writeProfile(result.cpuProfile, profile),
          10000,
          'CPU profile write',
        )
      } catch (error) {
        result.cpuProfileError = error.message
        result.status = 'failed'
        process.exitCode = 1
      }
    }
    if (tracing)
      try {
        result.traceCollection = await finishTrace()
      } catch (error) {
        result.traceError = error.message
      }
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify(result, null, 2),
    )
    await deadline(app.close(), 5000, 'benchmark app close').catch((error) => {
      result.closeError = error.message
      app.process().kill('SIGKILL')
    })
    clearTimeout(watchdog)
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify(result, null, 2),
    )
  }
}
async function captureSplitTabsKey({
  app,
  page,
  session,
  directory,
  side,
  selector,
  expected,
}) {
  const before = (
    await session.send('Page.captureScreenshot', { format: 'png' })
  ).data
  await page.evaluate(
    ({ selector, expected, side }) => {
      const element = document.querySelector(selector)
      if (!element?.isContentEditable)
        throw new Error('Target editor is not editable.')
      const probe = {
        keydownCount: 0,
        beforeinputCount: 0,
        inputCount: 0,
        viewport: { width: innerWidth, height: innerHeight },
      }
      window.__twoPaneProbe = probe
      const frame = () => {
        if (element.textContent !== expected)
          return requestAnimationFrame(frame)
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let last
        while (walker.nextNode())
          if (walker.currentNode.textContent) last = walker.currentNode
        if (!last?.textContent.endsWith('x'))
          return requestAnimationFrame(frame)
        const range = document.createRange()
        range.setStart(last, last.textContent.length - 1)
        range.setEnd(last, last.textContent.length)
        const rect = range.getBoundingClientRect()
        if (
          range.toString() !== 'x' ||
          rect.width <= 2 ||
          rect.height <= 2 ||
          rect.left < 0 ||
          rect.right > innerWidth ||
          rect.top < 0 ||
          rect.bottom > innerHeight
        )
          return requestAnimationFrame(frame)
        probe.glyph = {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        }
        probe.firstRafAt = performance.now()
        probe.focused = document.activeElement === element
        probe.active =
          element.closest('.editor-page')?.getAttribute('data-active') ===
          'true'
        performance.mark('input-paint:split-tabs:' + side + ':glyph-raf')
        requestAnimationFrame(() => {
          probe.nextRafAt = performance.now()
        })
      }
      element.addEventListener(
        'keydown',
        (event) => {
          if (event.key !== 'x') return
          probe.keydownCount++
          probe.keydownAt = performance.now()
          performance.mark('input-paint:split-tabs:' + side + ':keydown')
          requestAnimationFrame(frame)
        },
        true,
      )
      element.addEventListener(
        'beforeinput',
        (event) => {
          probe.beforeinputCount++
          probe.inputType = event.inputType
        },
        true,
      )
      element.addEventListener(
        'input',
        () => {
          probe.inputCount++
        },
        true,
      )
    },
    { selector, expected, side },
  )
  const captures = []
  let collecting = true,
    samplerError
  const sampler = (async () => {
    while (collecting && captures.length < 120) {
      const data = (
        await deadline(
          session.send('Page.captureScreenshot', { format: 'png' }),
          5000,
          side + ' frame sample',
        )
      ).data
      captures.push({
        data,
        receivedEpoch: performance.timeOrigin + performance.now(),
      })
    }
  })().catch((error) => {
    samplerError = error
  })
  const issuedEpoch = performance.timeOrigin + performance.now()
  try {
    await page.keyboard.press('x')
    await page.waitForFunction(
      () => window.__twoPaneProbe?.nextRafAt,
      undefined,
      { timeout: settleMs },
    )
    await sleep(100)
  } finally {
    collecting = false
    await deadline(sampler, 5000, side + ' sample drain')
  }
  if (samplerError) throw samplerError
  const probe = await page.evaluate(() => window.__twoPaneProbe)
  assert.equal(probe.keydownCount, 1)
  assert.equal(probe.beforeinputCount, 1)
  assert.equal(probe.inputCount, 1)
  assert.equal(probe.inputType, 'insertText')
  assert.ok(probe.focused && probe.active)
  const after = (
    await session.send('Page.captureScreenshot', { format: 'png' })
  ).data
  const image = await app.evaluate(
    (
      { nativeImage },
      { before, after, captures, glyph, viewport, issuedEpoch },
    ) => {
      const decode = (data) =>
        nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
      const size = decode(before).getSize()
      const crop = {
        x: Math.ceil(((glyph.left + 1) * size.width) / viewport.width),
        y: Math.ceil(((glyph.top + 1) * size.height) / viewport.height),
        width:
          Math.floor(((glyph.right - 1) * size.width) / viewport.width) -
          Math.ceil(((glyph.left + 1) * size.width) / viewport.width),
        height:
          Math.floor(((glyph.bottom - 1) * size.height) / viewport.height) -
          Math.ceil(((glyph.top + 1) * size.height) / viewport.height),
      }
      if (crop.width < 2 || crop.height < 2)
        throw new Error('Glyph crop is too small.')
      const pixels = (data) => {
        const image = decode(data),
          current = image.getSize()
        if (current.width !== size.width || current.height !== size.height)
          throw new Error('Capture image size changed.')
        return image.crop(crop).toBitmap()
      }
      const distance = (a, b) => {
        let total = 0
        for (let offset = 0; offset < a.length; offset += 4)
          for (let channel = 0; channel < 3; channel++)
            total += Math.abs(a[offset + channel] - b[offset + channel])
        return total / ((a.length / 4) * 3)
      }
      const initial = pixels(before),
        final = pixels(after),
        change = distance(initial, final)
      if (change <= 3) throw new Error('Captured glyph crop did not change.')
      const first = captures.findIndex((capture) => {
        if (capture.receivedEpoch < issuedEpoch) return false
        const sample = pixels(capture.data)
        return (
          distance(sample, final) < distance(sample, initial) / 2 &&
          distance(sample, initial) > change / 2
        )
      })
      return {
        index: first,
        receivedEpoch: captures[first]?.receivedEpoch ?? null,
        framesSampled: captures.length,
        imageChange: change,
        crop,
      }
    },
    {
      before,
      after,
      captures,
      glyph: probe.glyph,
      viewport: probe.viewport,
      issuedEpoch,
    },
  )
  await writeFile(
    join(directory, side + '-before.png'),
    Buffer.from(before, 'base64'),
  )
  await writeFile(
    join(directory, side + '-after.png'),
    Buffer.from(after, 'base64'),
  )
  if (image.index >= 0)
    await writeFile(
      join(directory, side + '-first-changed.png'),
      Buffer.from(captures[image.index].data, 'base64'),
    )
  assert.ok(image.index >= 0, side + ': no image-verified changed frame sample')
  return {
    side,
    probe,
    image,
    keydownToGlyphRafMs: probe.firstRafAt - probe.keydownAt,
    keydownToNextRafMs: probe.nextRafAt - probe.keydownAt,
    keyIssueToChangedCaptureReceiptMs: image.receivedEpoch - issuedEpoch,
  }
}

async function runSplitTabsCase() {
  const directory = join(output, 'split-tabs-two-documents'),
    profile = join(directory, 'profile'),
    fixtures = {
      left: {
        file: join(directory, 'left.md'),
        source: 'left pane baseline',
        target: 'source',
      },
      right: {
        file: join(directory, 'right.md'),
        source: 'right pane baseline',
        target: 'visual',
      },
    },
    result = {
      mode: 'split-tabs',
      directory,
      status: 'running',
      statusScope,
      integrityScope: 'two-hibi-documents-canonical-and-app-save',
      edits: [],
    }
  await mkdir(directory)
  await installProbe(profile)
  for (const fixture of Object.values(fixtures))
    await writeFile(fixture.file, fixture.source)
  summary.cases.push(result)
  let app,
    session,
    finishTrace,
    tracing = false,
    watchdog
  try {
    app = await launchBenchmarkApp(profile)
    watchdog = setTimeout(() => app.process().kill('SIGKILL'), 180000)
    const page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.show()
      win.focus()
    })
    await waitForEditor(page)
    const openFixture = async (fixture) => {
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        })
      }, fixture.file)
      await clickMenu(app, 'Open…')
      await page.waitForFunction(
        async ({ name, source }) => {
          const doc = await window.hibi.getDocument()
          return (
            doc.name === name &&
            doc.markdown === source &&
            document.querySelector('.app')?.getAttribute('aria-busy') ===
              'false'
          )
        },
        { name: basename(fixture.file), source: fixture.source },
      )
      fixture.id = (await page.evaluate(() => window.hibi.getDocument())).tabId
    }
    await openFixture(fixtures.left)
    await openFixture(fixtures.right)
    await page.getByRole('tab', { name: 'left.md' }).click()
    await page.waitForFunction(
      async (id) =>
        (await window.hibi.getDocument()).tabId === id &&
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
      fixtures.left.id,
    )
    await page
      .locator('[data-tab-key="' + fixtures.right.id + '"] .tab-split')
      .click()
    await page.locator('.editor-page[data-side="left"] .tiptap').click()
    await page.waitForFunction(
      async (id) =>
        (await window.hibi.getDocument()).tabId === id &&
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
      fixtures.left.id,
    )
    await page.getByRole('button', { name: 'Source view', exact: true }).click()
    const editors = {
      left: page.locator('.editor-page[data-side="left"] .cm-content'),
      right: page.locator('.editor-page[data-side="right"] .tiptap'),
    }
    await editors.left.waitFor()
    await editors.right.waitFor()
    await editors.right.click()
    await page.waitForFunction(
      async (id) =>
        (await window.hibi.getDocument()).tabId === id &&
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
      fixtures.right.id,
    )
    await page.evaluate(() => {
      window.__twoPaneNodes = {
        left: document.querySelector(
          '.editor-page[data-side="left"] .cm-content',
        ),
        right: document.querySelector(
          '.editor-page[data-side="right"] .tiptap',
        ),
      }
    })
    session = await page.context().newCDPSession(page)
    await session.send('Page.enable')
    result.traceCategories = [
      'input',
      'latencyInfo',
      'devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'blink.user_timing',
      'v8',
      'cc',
      'viz',
    ]
    finishTrace = createTraceFinalizer(session, join(directory, 'trace.json'))
    await session.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      streamFormat: 'json',
      categories: result.traceCategories.join(','),
    })
    tracing = true
    for (const side of ['left', 'right']) {
      const fixture = fixtures[side],
        other = fixtures[side === 'left' ? 'right' : 'left'],
        selector =
          side === 'left'
            ? '.editor-page[data-side="left"] .cm-content'
            : '.editor-page[data-side="right"] .tiptap'
      assert.ok(
        await page.evaluate(
          async ({ side, otherId }) =>
            document
              .querySelector('.editor-page[data-side="' + side + '"]')
              ?.getAttribute('data-active') === 'false' &&
            (await window.hibi.getDocument()).tabId === otherId &&
            window.__twoPaneNodes.left ===
              document.querySelector(
                '.editor-page[data-side="left"] .cm-content',
              ) &&
            window.__twoPaneNodes.right ===
              document.querySelector('.editor-page[data-side="right"] .tiptap'),
          { side, otherId: other.id },
        ),
        side + ': target not mounted and inactive',
      )
      const focusStart = performance.timeOrigin + performance.now()
      await editors[side].click()
      await page.waitForFunction(
        async ({ side, id }) =>
          document
            .querySelector('.editor-page[data-side="' + side + '"]')
            ?.getAttribute('data-active') === 'true' &&
          document.querySelector('.app')?.getAttribute('aria-busy') ===
            'false' &&
          (await window.hibi.getDocument()).tabId === id,
        { side, id: fixture.id },
      )
      const focusReady = performance.timeOrigin + performance.now()
      await editors[side].press('End')
      await page.waitForFunction(
        ({ selector, source }) => {
          const node = document.querySelector(selector)
          return document.activeElement === node && node?.textContent === source
        },
        { selector, source: fixture.source },
      )
      await page.evaluate(() => document.fonts.ready)
      await sleep(2000)
      const expected = fixture.source + 'x',
        edit = await captureSplitTabsKey({
          app,
          page,
          session,
          directory,
          side,
          selector,
          expected,
        })
      edit.target = fixture.target
      edit.focusTransitionDriverMs = focusReady - focusStart
      await page.waitForFunction(
        async ({ id, expected }) => {
          const doc = await window.hibi.getDocument()
          return doc.tabId === id && doc.markdown === expected
        },
        { id: fixture.id, expected },
        { timeout: settleMs },
      )
      await clickMenu(app, 'Save')
      await page.waitForFunction(
        (side) =>
          !document
            .querySelector(
              '.editor-page[data-side="' + side + '"] .split-tab-heading span',
            )
            ?.textContent.includes('•') &&
          document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
        side,
        { timeout: settleMs },
      )
      assert.equal(await readFile(fixture.file, 'utf8'), expected)
      assert.equal(
        await readFile(other.file, 'utf8'),
        side === 'left' ? other.source : other.source + 'x',
      )
      edit.canonicalAndDiskVerified = true
      result.edits.push(edit)
    }
    for (const side of ['left', 'right']) {
      const fixture = fixtures[side]
      await editors[side].click()
      await page.waitForFunction(
        async ({ id, expected }) => {
          const doc = await window.hibi.getDocument()
          return doc.tabId === id && doc.markdown === expected
        },
        { id: fixture.id, expected: fixture.source + 'x' },
      )
      assert.equal(await readFile(fixture.file, 'utf8'), fixture.source + 'x')
    }
    result.mountedAfter = await page.evaluate(
      () =>
        window.__twoPaneNodes.left ===
          document.querySelector(
            '.editor-page[data-side="left"] .cm-content',
          ) &&
        window.__twoPaneNodes.right ===
          document.querySelector('.editor-page[data-side="right"] .tiptap'),
    )
    assert.ok(result.mountedAfter)
    result.traceCollection = await finishTrace()
    tracing = false
    result.status = 'passed'
  } catch (error) {
    result.status = 'failed'
    result.error = error.stack ?? String(error)
    throw error
  } finally {
    if (tracing)
      result.traceCollection = await finishTrace().catch((error) => ({
        error: error.message,
      }))
    if (app)
      await deadline(app.close(), 5000, 'benchmark app close').catch(() =>
        app.process().kill('SIGKILL'),
      )
    clearTimeout(watchdog)
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify(result, null, 2),
    )
  }
}
try {
  if (splitTabsMode) await runSplitTabsCase()
  else
    for (const mode of modes)
      for (const size of sizes)
        for (const shape of shapes)
          for (const position of positions) {
            const targets =
              mode === 'split'
                ? values.target === 'both'
                  ? ['source', 'visual']
                  : [values.target]
                : [mode]
            for (const target of targets) {
              try {
                await runCase({ mode, target, size, shape, position })
              } catch (error) {
                if (!values['continue-on-error']) throw error
                process.exitCode = 1
                console.error(
                  `${mode}/${target}/${size}/${shape}/${position}: ${error.message}`,
                )
              }
              await writeFile(
                join(output, 'summary.json'),
                JSON.stringify(summary, null, 2),
              )
            }
          }
} catch (error) {
  process.exitCode = 1
  console.error(error.message)
} finally {
  await writeFile(
    join(output, 'summary.json'),
    JSON.stringify(summary, null, 2),
  )
}
