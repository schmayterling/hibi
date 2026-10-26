import assert from 'node:assert/strict'
import test from 'node:test'
import { StreamLanguage } from '@codemirror/language'
import { Fragment, Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { CodeHighlight } from '../src/renderer/src/CodeHighlight.ts'
import {
  codeLanguages,
  codeSpans,
  highlightCode,
} from '../src/renderer/src/code-languages.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { group: 'block', content: 'text*' },
    blockquote: { group: 'block', content: 'block+' },
    codeBlock: {
      group: 'block',
      content: 'text*',
      attrs: { language: { default: 'javascript' } },
    },
  },
})
const paragraph = (text) =>
  schema.nodes.paragraph.create(null, schema.text(text))
const code = (text, language) =>
  schema.nodes.codeBlock.create(
    language === undefined ? null : { language },
    schema.text(text),
  )
const sort = (values) =>
  values.sort(
    (a, b) =>
      a.from - b.from || a.to - b.to || a.classes.localeCompare(b.classes),
  )
const tokens = (decorations) =>
  sort(
    decorations.find().map((token) => ({
      from: token.from,
      to: token.to,
      classes: token.type.attrs.class,
    })),
  )
const expected = (doc) => {
  const result = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return
    for (const token of highlightCode(node.textContent, node.attrs.language))
      result.push({
        from: pos + 1 + token.from,
        to: pos + 1 + token.to,
        classes: token.classes,
      })
  })
  return sort(result)
}
const keyword = () =>
  StreamLanguage.define({
    token(stream) {
      stream.skipToEnd()
      return 'keyword'
    },
  })

/**
 * Mounts the plugin view with controllable frames and line geometry: document
 * position `origin()` sits at the top of an 800 px pane and `scale` positions
 * fill it, unless `y` and `x` place positions directly. Without `x`, lines
 * start far off screen to the left and have no measurable width.
 */
function mount(t, plugin, state, geometry = {}) {
  const frames = new Map()
  const idle = new Map()
  const listeners = new Map()
  const observers = []
  const mutations = []
  let id = 0
  const listen = (target) => ({
    addEventListener: (type, listener) =>
      listeners.set(`${target}${type}`, listener),
    removeEventListener: (type) => listeners.delete(`${target}${type}`),
  })
  const y =
    geometry.y ??
    ((pos) =>
      ((pos - (geometry.origin?.() ?? -1e6)) * 800) / (geometry.scale ?? 3000))
  const x = geometry.x ?? (() => -5000)
  const globals = {
    requestAnimationFrame: (callback) => {
      frames.set(++id, callback)
      return id
    },
    cancelAnimationFrame: (frame) => frames.delete(frame),
    requestIdleCallback: (callback) => {
      idle.set(++id, callback)
      return id
    },
    cancelIdleCallback: (slice) => idle.delete(slice),
    ResizeObserver: class {
      constructor(callback) {
        observers.push(callback)
      }
      observe() {}
      disconnect() {}
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback
      }
      observe() {
        mutations.push(this.callback)
      }
      disconnect() {
        mutations.length = 0
      }
    },
    getComputedStyle: () => ({
      visibility: geometry.hidden === 'style' ? 'hidden' : 'visible',
      overflowX: 'visible',
      overflowY: 'visible',
      whiteSpace: geometry.whiteSpace ?? 'pre',
    }),
    document: listen('document:'),
    window: { innerHeight: 800, innerWidth: 800, ...listen('window:') },
  }
  const previous = Object.fromEntries(
    Object.keys(globals).map((name) => [name, globalThis[name]]),
  )
  Object.assign(globalThis, globals)
  let pluginView
  const view = {
    state,
    dispatches: 0,
    dom: {
      parentElement: { parentElement: null },
      contains: () => false,
      getBoundingClientRect: () =>
        geometry.hidden === 'size'
          ? { top: 0, bottom: 0, left: 0, right: 0 }
          : { top: 0, bottom: 800, left: 0, right: 800 },
    },
    nodeDOM: (pos) => ({
      getBoundingClientRect: () => ({
        top: y(pos + 1),
        bottom: y(pos + view.state.doc.nodeAt(pos).nodeSize - 1) + 1,
        left: 0,
        right: 800,
      }),
    }),
    coordsAtPos: (pos) => ({ left: x(pos), top: y(pos), bottom: y(pos) + 1 }),
    dispatch(transaction) {
      const before = view.state
      view.dispatches++
      view.state = before.apply(transaction)
      pluginView.update?.(view, before)
    },
    /** Runs the next frame. */
    frame() {
      const [frame, callback] = frames.entries().next().value
      frames.delete(frame)
      callback(performance.now())
    },
    /** Runs the next idle slice with `remaining` milliseconds. */
    idle(remaining = 50) {
      const [slice, callback] = idle.entries().next().value
      idle.delete(slice)
      callback({ didTimeout: false, timeRemaining: () => remaining })
    },
    /** Runs the next frame, or idle slice without one; false when nothing is scheduled. */
    step() {
      if (frames.size) view.frame()
      else if (idle.size) view.idle()
      else return false
      return true
    },
    /** Runs frames and idle slices until no more work is scheduled. */
    flush() {
      for (let count = 0; frames.size || idle.size; count++) {
        assert.ok(count < 10000, 'highlighting kept scheduling work')
        if (frames.size) view.frame()
        else view.idle()
      }
    },
    scroll: () =>
      listeners.get('document:scroll')?.({ target: { contains: () => true } }),
    resize: () => {
      for (const callback of observers) callback()
    },
    /** Reports a class or style change on an ancestor. */
    mutate: () => {
      for (const callback of [...mutations]) callback([])
    },
    listeners,
  }
  pluginView = plugin.spec.view(view)
  t.after(() => {
    pluginView.destroy()
    Object.assign(globalThis, previous)
  })
  return view
}
/** Joins tokens split where decoration pieces meet. */
const joined = (values) =>
  values.reduce((result, token) => {
    const last = result.at(-1)
    if (last && last.to === token.from && last.classes === token.classes)
      last.to = token.to
    else result.push({ ...token })
    return result
  }, [])

test('mapped code decorations match full highlighting through text, block, and language changes', async (t) => {
  await codeLanguages.ensure('javascript')
  for (const method of ['findDiffStart', 'findDiffEnd'])
    t.mock.method(Fragment.prototype, method, () => {
      assert.fail(
        'code highlighting must use step maps, not whole-text comparisons',
      )
    })
  const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
  const state = EditorState.create({
    schema,
    plugins: [plugin],
    doc: schema.nodes.doc.create(null, [
      paragraph('prefix'),
      code('const x = "one"'),
      code('// two\nlet y = 2'),
      paragraph('suffix'),
    ]),
  })
  const view = mount(t, plugin, state)
  const verify = () =>
    assert.deepEqual(
      tokens(plugin.getState(view.state).decorations),
      expected(view.state.doc),
    )
  const apply = (tr) => {
    view.dispatch(tr)
    verify()
  }
  verify()
  let tr = view.state.tr
  const multiple = tr.insertText('abcdefgh', 1)
  multiple.insertText('return ', multiple.doc.firstChild.nodeSize + 1)
  multiple.delete(1, 5)
  apply(multiple)
  const firstCode = view.state.doc.firstChild.nodeSize
  apply(view.state.tr.setNodeAttribute(firstCode, 'language', 'text'))
  apply(view.state.tr.setNodeAttribute(firstCode, 'language', 'javascript'))
  apply(view.state.tr.join(firstCode + view.state.doc.child(1).nodeSize))
  apply(view.state.tr.split(firstCode + 4))
  // A transaction can change steps without changing its final document.
  apply(view.state.tr.insertText('x', 1).delete(1, 2))
  for (let index = 0; index < 120; index++) {
    const blocks = []
    view.state.doc.forEach((node, pos) => {
      blocks.push({ node, pos })
    })
    const { node, pos } = blocks[(index * 7) % blocks.length]
    tr = view.state.tr
    switch (index % 5) {
      case 0:
        apply(tr.insertText(index % 2 ? 'z' : ' ', pos + 1))
        break
      case 1:
        apply(
          tr.setNodeMarkup(
            pos,
            node.type.name === 'codeBlock'
              ? schema.nodes.paragraph
              : schema.nodes.codeBlock,
          ),
        )
        break
      case 2:
        apply(tr.insert(view.state.doc.content.size, code('const later = 42')))
        break
      case 3:
        apply(tr.delete(pos, pos + node.nodeSize))
        break
      case 4:
        if (node.content.size) apply(tr.delete(pos + 1, pos + 2))
        break
    }
  }
  const nested = schema.nodes.blockquote.create(null, [
    code('const nested = 1'),
    paragraph('after'),
  ])
  apply(view.state.tr.insert(0, nested))
  apply(view.state.tr.insertText(' ', 2))
  apply(view.state.tr.setNodeMarkup(1, schema.nodes.paragraph))
  apply(view.state.tr.delete(0, view.state.doc.firstChild.nodeSize))
  const dispatches = view.dispatches
  codeLanguages.setEnabled('javascript', false)
  assert.equal(view.dispatches, dispatches, 'refreshes wait for a frame')
  view.flush()
  verify()
  assert.equal(plugin.getState(view.state).decorations.find().length, 0)
  codeLanguages.setEnabled('javascript', true)
  view.flush()
  verify()
  assert.ok(plugin.getState(view.state).decorations.find().length)
})

test('a language arrival rehighlights only its own blocks, once per frame', async (t) => {
  const first = keyword()
  const parse = t.mock.method(first.parser, 'parse')
  const loads = {}
  t.after(
    codeLanguages.register('arrival', { id: 'arrival-a', language: first }),
  )
  for (const id of ['arrival-b', 'arrival-c', 'arrival-d'])
    t.after(
      codeLanguages.register('arrival', {
        id,
        aliases: [`${id}-alias`],
        load: () =>
          new Promise((resolve) => {
            loads[id] = resolve
          }),
      }),
    )
  const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
  const view = mount(
    t,
    plugin,
    EditorState.create({
      schema,
      plugins: [plugin],
      doc: schema.nodes.doc.create(null, [
        code('first', 'arrival-a'),
        code('second', 'ARRIVAL-A title'),
        code('third', 'arrival-b'),
        code('alias', 'arrival-b-alias'),
        code('later', 'arrival-c'),
        code('disabled', 'arrival-d'),
        code('registered later', 'arrival-e'),
        code('fourth', 'arrival-a'),
      ]),
    }),
  )
  const verify = () =>
    assert.deepEqual(
      tokens(plugin.getState(view.state).decorations),
      expected(view.state.doc),
    )
  const highlighted = () =>
    tokens(plugin.getState(view.state).decorations).map((token) =>
      view.state.doc.textBetween(token.from, token.to),
    )
  assert.equal(parse.mock.callCount(), 3)
  assert.deepEqual(highlighted(), ['first', 'second', 'fourth'])
  await new Promise((resolve) => setImmediate(resolve))
  codeLanguages.setEnabled('arrival-d', false)
  parse.mock.resetCalls()
  const dispatches = view.dispatches
  loads['arrival-b'](keyword())
  loads['arrival-c'](keyword())
  loads['arrival-d'](keyword())
  await codeLanguages.settle()
  view.flush()
  assert.equal(view.dispatches - dispatches, 1)
  assert.equal(parse.mock.callCount(), 0, 'arrivals rehighlighted language a')
  assert.deepEqual(highlighted(), [
    'first',
    'second',
    'third',
    'alias',
    'later',
    'fourth',
  ])
  verify()
  parse.mock.resetCalls()
  codeLanguages.setEnabled('arrival-b', false)
  view.flush()
  assert.deepEqual(highlighted(), ['first', 'second', 'later', 'fourth'])
  codeLanguages.setEnabled('arrival-b', true)
  codeLanguages.setEnabled('arrival-d', true)
  view.flush()
  assert.equal(parse.mock.callCount(), 0)
  assert.equal(highlighted().length, 7)
  verify()
  // A language registered after opening loads for blocks that already name it.
  t.after(
    codeLanguages.register('arrival', {
      id: 'arrival-e',
      load: async () => keyword(),
    }),
  )
  view.flush()
  await codeLanguages.settle()
  view.flush()
  assert.ok(highlighted().includes('registered later'))
  verify()
})

test('long code blocks parse incrementally and decorate only text near the viewport', async (t) => {
  for (const [language, line] of [
    [
      'javascript',
      'function sample(value) {\n  // note\n  return value * 42 + "text";\n}\n',
    ],
    ['shell', 'echo "$HOME" # note\n'],
  ]) {
    await t.test(language, async (t) => {
      const parser = (await codeLanguages.ensure(language)).parser
      const startParse = parser.startParse.bind(parser)
      const parses = []
      let recording = true
      t.mock.method(parser, 'startParse', (input, fragments, ranges) => {
        const parse = startParse(input, fragments, ranges)
        const record = { reused: fragments?.length ?? 0, advances: 0 }
        if (recording) parses.push(record)
        const advance = parse.advance.bind(parse)
        parse.advance = () => {
          record.advances++
          return advance()
        }
        return parse
      })
      const text = line.repeat(Math.ceil(200_000 / line.length))
      const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
      const state = EditorState.create({
        schema,
        plugins: [plugin],
        doc: schema.nodes.doc.create(null, [
          paragraph('before'),
          code(text, language),
          paragraph('after'),
        ]),
      })
      let start = state.doc.firstChild.nodeSize + 1
      let top = start + 50_000
      // Lines start off screen to the left, so only line geometry finds what is visible.
      const view = mount(t, plugin, state, { origin: () => top })
      assert.equal(plugin.getState(view.state).decorations.find().length, 0)
      view.flush()
      const verify = () => {
        const { viewport, decorations } = plugin.getState(view.state)
        const block = view.state.doc.child(1)
        recording = false
        const full = parser.parse(block.textContent)
        recording = true
        const from = Math.max(viewport.from, start) - start
        const to = Math.min(viewport.to, start + block.content.size) - start
        assert.ok(viewport.from <= top && top + 3_000 <= viewport.to)
        // A parse stopped at the range end may still be inside its last token.
        const settled = (token) => token.to < start + to - line.length
        assert.deepEqual(
          joined(tokens(decorations)).filter(settled),
          codeSpans(full, from, to)
            .map((span) => ({
              from: start + span.from,
              to: start + span.to,
              classes: span.classes,
            }))
            .filter(settled),
        )
        return decorations.find().length
      }
      const visible = verify()
      const total = codeSpans(parser.parse(text)).length
      assert.ok(visible > 100 && visible * 10 < total, `${visible} tokens`)
      assert.ok(parses.length, 'the block was parsed')
      const initial = parses.reduce((sum, parse) => sum + parse.advances, 0)
      parses.length = 0
      view.dispatch(view.state.tr.insertText('let typed = 1\n', top + 100))
      view.flush()
      verify()
      const edit = parses.reduce((sum, parse) => sum + parse.advances, 0)
      assert.ok(parses[0].reused > 0, 'the edit reused the parsed tree')
      assert.ok(edit * 4 < initial, `edit took ${edit} of ${initial} advances`)
      top = start + 150_000
      view.scroll()
      view.flush()
      assert.ok(verify() * 10 < total)
      assert.ok(
        plugin
          .getState(view.state)
          .decorations.find()
          .every((token) => token.from >= start + 140_000),
      )
      // Replacing the document clears the range until the view measures again.
      view.dispatch(
        view.state.tr.replaceWith(0, view.state.doc.content.size, [
          paragraph('replaced'),
          code(text, language),
        ]),
      )
      assert.equal(plugin.getState(view.state).viewport, null)
      start = view.state.doc.firstChild.nodeSize + 1
      top = start + 20_000
      view.flush()
      assert.ok(verify() * 10 < total)
    })
  }
})

test('one budget covers parsing every long block in a frame', (t) => {
  let advances = 0
  const language = {
    parser: {
      parse: () => assert.fail('long blocks parse incrementally'),
      startParse: () => ({
        stoppedAt: null,
        stopAt(to) {
          this.stoppedAt = to
        },
        advance() {
          advances++
          return null
        },
      }),
    },
  }
  t.after(codeLanguages.register('budget', { id: 'budget-probe', language }))
  const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
  const view = mount(
    t,
    plugin,
    EditorState.create({
      schema,
      plugins: [plugin],
      doc: schema.nodes.doc.create(
        null,
        Array.from({ length: 12 }, () =>
          code('x'.repeat(11_000), 'budget-probe'),
        ),
      ),
    }),
    { origin: () => 0, scale: 200_000 },
  )
  let clock = 0
  const now = performance.now
  performance.now = () => ++clock
  t.after(() => {
    performance.now = now
  })
  view.frame()
  // Each check costs 1 ms here: three advances fit in 4 ms, and the other blocks wait.
  assert.equal(advances, 3)
  assert.equal(view.dispatches, 1, 'the new range is published')
  view.frame()
  assert.equal(advances, 6, 'later frames continue the work')
  view.idle(4)
  assert.equal(advances, 9, 'idle periods add more')
})

test('long-block presence stays exact and scrolling skips document walks', async (t) => {
  await codeLanguages.ensure('javascript')
  const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
  let top = 1_000
  const view = mount(
    t,
    plugin,
    EditorState.create({
      schema,
      plugins: [plugin],
      doc: schema.nodes.doc.create(null, [
        code('function sample() {\n  return 42;\n}\n'.repeat(1_000)),
        ...Array.from({ length: 10_000 }, () => paragraph('short')),
      ]),
    }),
    { origin: () => top },
  )
  view.flush()
  assert.deepEqual(
    plugin.getState(view.state).blocks.map(({ pos }) => pos),
    [0],
  )
  assert.ok(plugin.getState(view.state).decorations.find().length)
  let walks = 0
  const counted =
    (visit) =>
    (...args) => {
      walks++
      return visit(...args)
    }
  const { doc } = view.state
  const { descendants, nodesBetween } = doc
  doc.descendants = (visit) => descendants.call(doc, counted(visit))
  doc.nodesBetween = (from, to, visit, start) =>
    nodesBetween.call(doc, from, to, counted(visit), start)
  top = 20_000
  view.scroll()
  view.flush()
  assert.ok(walks < 100, `scrolling visited ${walks} nodes`)
  view.dispatch(view.state.tr.delete(0, view.state.doc.firstChild.nodeSize))
  view.flush()
  assert.deepEqual(plugin.getState(view.state).blocks, [])
  assert.ok(!view.listeners.has('document:scroll'))
})

test('hidden editors keep language changes until they are visible', async (t) => {
  const language = keyword()
  const parse = t.mock.method(language.parser, 'parse')
  let finish
  t.after(
    codeLanguages.register('hidden', {
      id: 'hidden-probe',
      load: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    }),
  )
  const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
  // Source mode hides the rich pane with its style while it keeps its size.
  const geometry = { hidden: 'style' }
  const view = mount(
    t,
    plugin,
    EditorState.create({
      schema,
      plugins: [plugin],
      doc: schema.nodes.doc.create(null, [code('hidden', 'hidden-probe')]),
    }),
    geometry,
  )
  await new Promise((resolve) => setImmediate(resolve))
  finish(language)
  await codeLanguages.settle()
  view.flush()
  assert.equal(view.dispatches, 0)
  assert.equal(parse.mock.callCount(), 0)
  geometry.hidden = false
  view.mutate()
  view.flush()
  assert.equal(view.dispatches, 1)
  assert.equal(parse.mock.callCount(), 1)
  assert.equal(plugin.getState(view.state).decorations.find().length, 1)
})

test('a single long line decorates only the columns near the visible ones', async (t) => {
  await codeLanguages.ensure('javascript')
  const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
  const text = 'const horizontal = 42; '.repeat(5000)
  let scrolled = 0
  const view = mount(
    t,
    plugin,
    EditorState.create({
      schema,
      plugins: [plugin],
      doc: schema.nodes.doc.create(null, [code(text)]),
    }),
    // One 8 px wide character per column, scrolled `scrolled` px to the right.
    { y: () => 100, x: (pos) => (pos - 1) * 8 - scrolled },
  )
  view.flush()
  const columns = () =>
    plugin
      .getState(view.state)
      .decorations.find()
      .map((token) => token.from - 1)
  let shown = columns()
  assert.ok(shown.length > 20 && shown.length < 200, `${shown.length} tokens`)
  assert.ok(Math.max(...shown) < 400)
  view.dispatch(view.state.tr.insertText(' ', 50))
  view.flush()
  shown = columns()
  assert.ok(shown.length < 200, `${shown.length} tokens after typing`)
  scrolled = 80_000
  view.scroll()
  view.flush()
  shown = columns()
  assert.ok(shown.length > 20 && shown.length < 200, `${shown.length} tokens`)
  assert.ok(Math.min(...shown) > 9_000 && Math.max(...shown) < 10_400)
})

test('decorating long blocks stops at the budget and continues in later frames', async (t) => {
  await codeLanguages.ensure('javascript')
  const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
  const text =
    'function sample(value) {\n  return value * 42 + "text";\n}\n'.repeat(2_000)
  // Reading near the end parses everything before it.
  let origin = 100_000
  let scale = 3_000
  const view = mount(
    t,
    plugin,
    EditorState.create({
      schema,
      plugins: [plugin],
      doc: schema.nodes.doc.create(null, [code(text)]),
    }),
    { y: (pos) => ((pos - origin) * 800) / scale },
  )
  view.flush()
  const full = codeLanguages.resolve('javascript').parser.parse(text)
  const expected = () => {
    const { viewport } = plugin.getState(view.state)
    return codeSpans(full, viewport.from - 1, viewport.to - 1).map((span) => ({
      from: 1 + span.from,
      to: 1 + span.to,
      classes: span.classes,
    }))
  }
  assert.deepEqual(
    joined(tokens(plugin.getState(view.state).decorations)),
    expected(),
  )
  // Each clock read costs 1 ms: one frame decorates a few pieces, visible ones first.
  origin = 40_000
  scale = 20_000
  let clock = 0
  const now = performance.now
  performance.now = () => ++clock
  t.after(() => {
    performance.now = now
  })
  view.scroll()
  view.frame()
  const { viewport } = plugin.getState(view.state)
  assert.ok(viewport.from < 40_000 && viewport.to > 60_000)
  const at = (from, to) =>
    plugin
      .getState(view.state)
      .decorations.find(from, to)
      .filter((token) => token.from >= from && token.to <= to).length
  assert.ok(at(40_000, 44_000) > 0, 'the first visible pieces are decorated')
  assert.equal(at(50_000, 60_000), 0, 'later pieces wait for later frames')
  performance.now = now
  view.flush()
  assert.deepEqual(
    joined(tokens(plugin.getState(view.state).decorations)),
    expected(),
  )
})

test('a wrapped long line decorates the rows on screen', async (t) => {
  await codeLanguages.ensure('javascript')
  const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
  const text = 'const wrapped = 42; '.repeat(5000)
  let scrolled = 0
  // 100 characters per 20 px row.
  const view = mount(
    t,
    plugin,
    EditorState.create({
      schema,
      plugins: [plugin],
      doc: schema.nodes.doc.create(null, [code(text)]),
    }),
    {
      y: (pos) => Math.floor((pos - 1) / 100) * 20 - scrolled,
      x: (pos) => ((pos - 1) % 100) * 8,
      whiteSpace: 'pre-wrap',
    },
  )
  scrolled = 20 * 500
  view.flush()
  const shown = plugin
    .getState(view.state)
    .decorations.find()
    .map((token) => token.from - 1)
  assert.ok(shown.length > 100 && shown.length < 5000, `${shown.length} tokens`)
  assert.ok(shown.some((at) => at >= 50_000 && at < 54_000))
  assert.ok(shown.every((at) => at > 40_000 && at < 64_000))
})

test('a frame decorates one piece once its budget is spent, across blocks', async (t) => {
  await codeLanguages.ensure('javascript')
  const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
  const block = 'const value = 1;\n'.repeat(700)
  const view = mount(
    t,
    plugin,
    EditorState.create({
      schema,
      plugins: [plugin],
      doc: schema.nodes.doc.create(
        null,
        Array.from({ length: 12 }, () => code(block)),
      ),
    }),
    { origin: () => 0, scale: 400_000 },
  )
  view.flush()
  const decorated = () => {
    let count = 0
    view.state.doc.forEach((node, pos) => {
      if (
        plugin.getState(view.state).decorations.find(pos, pos + node.nodeSize)
          .length
      )
        count++
    })
    return count
  }
  assert.equal(decorated(), 12)
  // Turning the language off and on again redecorates blocks whose trees are cached.
  codeLanguages.setEnabled('javascript', false)
  view.flush()
  assert.equal(decorated(), 0)
  codeLanguages.setEnabled('javascript', true)
  // Every clock read costs 5 ms, more than a frame's budget.
  let clock = 0
  const now = performance.now
  performance.now = () => (clock += 5)
  t.after(() => {
    performance.now = now
  })
  view.frame()
  assert.ok(decorated() <= 1, `${decorated()} blocks decorated in one frame`)
  performance.now = now
  view.flush()
  assert.equal(decorated(), 12)
})

/** Pixel offsets of each character in `line`: tabs stop every 8 cells; CJK takes two. */
function advances(line) {
  const x = [0]
  for (const character of line) {
    const at = x.at(-1)
    const cell =
      character === '\t'
        ? 64 - (at % 64)
        : /[\u3000-\u9fff]/.test(character)
          ? 16
          : 8
    for (const _unit of character) x.push(at + cell)
  }
  return x
}

for (const [name, line] of [
  ['tab-indented', `${'\t'.repeat(400)}const tabbed = 42;`],
  ['CJK', `const text = "${'漢'.repeat(20_000)}";`],
]) {
  test(`horizontally scrolled ${name} lines keep their visible tokens`, async (t) => {
    await codeLanguages.ensure('javascript')
    const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
    const text = `const header = 42;\n${line}\n${'const filler = 1;\n'.repeat(700)}`
    const offsets = advances(line)
    const second = 'const header = 42;\n'.length
    let scrolled = 0
    const view = mount(
      t,
      plugin,
      EditorState.create({
        schema,
        plugins: [plugin],
        doc: schema.nodes.doc.create(null, [code(text)]),
      }),
      {
        // The header and the long line are on screen; filler lines follow.
        y: (pos) =>
          pos - 1 < second
            ? 0
            : pos - 1 <= second + line.length
              ? 20
              : 40 + (pos - 1) / 1000,
        // Every line starts at the same x, moved left by the horizontal scroll;
        // the other lines have plain 8 px characters.
        x: (pos) => {
          const offset = pos - 1
          if (offset >= second && offset <= second + line.length)
            return offsets[offset - second] - scrolled
          const filler = second + line.length + 1
          return (
            (offset < second ? offset : (offset - filler) % 18) * 8 - scrolled
          )
        },
      },
    )
    view.flush()
    // Scrolled near the end of the long line, the tokens there must be decorated.
    scrolled = offsets.at(-1) - 400
    view.scroll()
    view.flush()
    const visible = plugin
      .getState(view.state)
      .decorations.find()
      .filter((token) => {
        const offset = token.from - 1 - second
        return (
          offset >= 0 &&
          offset < line.length &&
          offsets[offset] - scrolled < 800 &&
          offsets[Math.min(token.to - 1 - second, line.length)] - scrolled > 0
        )
      })
    assert.ok(visible.length > 0, 'no visible token was decorated')
    // Only characters near the visible ones are decorated on the long line.
    const covered = plugin
      .getState(view.state)
      .decorations.find(1 + second, 1 + second + line.length)
      .reduce((sum, token) => sum + token.to - token.from, 0)
    assert.ok(covered < line.length / 2, `${covered} characters decorated`)
  })
}

test('a short first line does not stop clipping decisions for wrapping blocks', async (t) => {
  await codeLanguages.ensure('javascript')
  const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
  const text = `const header = 42;\n${'const wrapped = 42; '.repeat(5000)}`
  const second = 'const header = 42;\n'.length
  let scrolled = 0
  // The long second line wraps every 100 characters into 20 px rows.
  const view = mount(
    t,
    plugin,
    EditorState.create({
      schema,
      plugins: [plugin],
      doc: schema.nodes.doc.create(null, [code(text)]),
    }),
    {
      y: (pos) =>
        (pos - 1 < second
          ? 0
          : 20 + Math.floor((pos - 1 - second) / 100) * 20) - scrolled,
      x: (pos) =>
        pos - 1 < second ? (pos - 1) * 8 : ((pos - 1 - second) % 100) * 8,
      whiteSpace: 'pre-wrap',
    },
  )
  scrolled = 20 * 600
  view.flush()
  const shown = plugin
    .getState(view.state)
    .decorations.find()
    .map((token) => token.from - 1 - second)
  assert.ok(
    shown.some((offset) => offset >= 60_000 && offset < 64_000),
    'the wrapped rows on screen are decorated',
  )
})

test('a long block decorates again after scrolling away and back', async (t) => {
  await codeLanguages.ensure('javascript')
  const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
  let origin = 0
  const view = mount(
    t,
    plugin,
    EditorState.create({
      schema,
      plugins: [plugin],
      doc: schema.nodes.doc.create(null, [
        code('const value = 1;\n'.repeat(700)),
        ...Array.from({ length: 3_000 }, () => paragraph('between')),
        code('const other = 2;\n'.repeat(700)),
      ]),
    }),
    { origin: () => origin },
  )
  view.flush()
  const first = () =>
    plugin
      .getState(view.state)
      .decorations.find(0, view.state.doc.firstChild.nodeSize).length
  assert.ok(first() > 0)
  origin = view.state.doc.content.size - 3_000
  view.scroll()
  view.flush()
  assert.equal(first(), 0, 'blocks out of range drop their tokens')
  origin = 0
  view.scroll()
  view.flush()
  assert.ok(first() > 0, 'returning decorates the block again')
})

test('moved and restored long blocks decorate again', async (t) => {
  await codeLanguages.ensure('javascript')
  const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
  const block = code('const moved = 42;\n'.repeat(1_000))
  // The whole block is on screen wherever it is.
  const view = mount(
    t,
    plugin,
    EditorState.create({
      schema,
      plugins: [plugin],
      doc: schema.nodes.doc.create(null, [paragraph('before'), block]),
    }),
    { origin: () => 0, scale: 100_000 },
  )
  view.flush()
  const verify = () =>
    assert.deepEqual(
      joined(tokens(plugin.getState(view.state).decorations)),
      joined(expected(view.state.doc)),
    )
  verify()
  // Moving the same node replaces the text that held its tokens.
  const { doc } = view.state
  view.dispatch(
    view.state.tr.replaceWith(0, doc.content.size, [block, doc.child(0)]),
  )
  view.flush()
  verify()
  // Deleted and restored, as undo does, the same node decorates again.
  view.dispatch(view.state.tr.delete(0, block.nodeSize))
  view.flush()
  assert.equal(plugin.getState(view.state).decorations.find().length, 0)
  view.dispatch(view.state.tr.insert(0, block))
  view.flush()
  verify()
})

test('text typed at either end of the decorated range is decorated', async (t) => {
  await codeLanguages.ensure('javascript')
  const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
  // The whole block is on screen, so the range starts and ends with it.
  const view = mount(
    t,
    plugin,
    EditorState.create({
      schema,
      plugins: [plugin],
      doc: schema.nodes.doc.create(null, [
        code('let value = 1;\n'.repeat(1_000)),
      ]),
    }),
    { origin: () => 0, scale: 100_000 },
  )
  view.flush()
  view.dispatch(
    view.state.tr.insertText(
      '\nconst last = 1',
      view.state.doc.content.size - 1,
    ),
  )
  view.dispatch(view.state.tr.insertText('const first = 1\n', 1))
  view.flush()
  assert.deepEqual(
    joined(tokens(plugin.getState(view.state).decorations)),
    joined(expected(view.state.doc)),
  )
})

for (const [name, change] of [
  [
    'typing makes a block long',
    (state) =>
      state.tr.insertText('const more = 2;\n', state.doc.content.size - 1),
  ],
  [
    'a long block is inserted',
    (state) =>
      state.tr.insert(
        state.doc.content.size,
        code('const inserted = 3;\n'.repeat(600)),
      ),
  ],
]) {
  test(`decoration follows without a layout change when ${name}`, async (t) => {
    await codeLanguages.ensure('javascript')
    const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
    const line = 'let value = 1;\n'
    const short = code(line.repeat(666))
    assert.ok(short.content.size <= 10_000)
    // Every block stays on screen and the editor never resizes.
    const view = mount(
      t,
      plugin,
      EditorState.create({
        schema,
        plugins: [plugin],
        doc: schema.nodes.doc.create(null, [code(line.repeat(1_000)), short]),
      }),
      { origin: () => 0, scale: 100_000 },
    )
    view.flush()
    const verify = () =>
      assert.deepEqual(
        joined(tokens(plugin.getState(view.state).decorations)),
        joined(expected(view.state.doc)),
      )
    verify()
    view.dispatch(change(view.state))
    view.flush()
    assert.equal(plugin.getState(view.state).blocks.length, 2)
    verify()
  })
}

test('line planning measures a few lines per frame, about a screen past the visible ones', async (t) => {
  await codeLanguages.ensure('javascript')
  const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
  // A very long first line, then long and short lines; every line is 20 px tall.
  const header = `//${'x'.repeat(40_000)}\n`
  const rows = Array.from({ length: 2_000 }, (_, row) =>
    row % 2 ? '//x\n' : `${`const v${row} = 42;`.padEnd(270)}\n`,
  )
  const starts = [0, header.length]
  for (const row of rows) starts.push(starts.at(-1) + row.length)
  // The last line starting at or before `offset`.
  const lineOf = (offset) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (starts[middle] <= offset) low = middle
      else high = middle - 1
    }
    return low
  }
  let scrolled = 20 * 1_950
  let clock = 0
  let calls = 0
  const view = mount(
    t,
    plugin,
    EditorState.create({
      schema,
      plugins: [plugin],
      doc: schema.nodes.doc.create(null, [code(header + rows.join(''))]),
    }),
    {
      y: (pos) => lineOf(pos - 1) * 20 - scrolled,
      // 8 px characters; each horizontal measurement costs 1 ms.
      x: (pos) => {
        calls++
        clock++
        return (pos - 1 - starts[lineOf(pos - 1)]) * 8
      },
    },
  )
  view.flush()
  t.mock.method(performance, 'now', () => clock)
  scrolled = 0
  view.scroll()
  let most = 0
  for (calls = 0; view.step(); calls = 0) most = Math.max(most, calls)
  assert.ok(most < 100, `${most} measurements in one frame`)
  const lines = plugin
    .getState(view.state)
    .decorations.find()
    .map((token) => lineOf(token.from - 1))
  assert.ok(lines.includes(1), 'the first rows on screen are decorated')
  assert.ok(Math.max(...lines) < 90, `line ${Math.max(...lines)} decorated`)
})

test('measured columns stay limited to the lines of live blocks', async (t) => {
  await codeLanguages.ensure('javascript')
  // Measured columns are kept in maps from long line text.
  const caches = new Set()
  const set = Map.prototype.set
  t.mock.method(Map.prototype, 'set', function (key, value) {
    if (typeof key === 'string' && key.length > 256 && value?.to >= 0)
      caches.add(this)
    return set.call(this, key, value)
  })
  const entries = () => [...caches].reduce((sum, cache) => sum + cache.size, 0)
  const [plugin] = CodeHighlight.config.addProseMirrorPlugins()
  const text = (version) => `const version${version} = 42; `.repeat(700)
  const view = mount(
    t,
    plugin,
    EditorState.create({
      schema,
      plugins: [plugin],
      doc: schema.nodes.doc.create(null, [code(text(0))]),
    }),
    { y: () => 100, x: (pos) => (pos - 1) * 8 },
  )
  view.flush()
  assert.equal(entries(), 1)
  for (let version = 1; version <= 25; version++) {
    view.dispatch(
      view.state.tr.replaceWith(
        0,
        view.state.doc.content.size,
        code(text(version)),
      ),
    )
    view.flush()
  }
  assert.equal(entries(), 1, 'replaced blocks kept their measurements')
  view.dispatch(view.state.tr.insertText('typed ', 1))
  view.flush()
  assert.equal(entries(), 1, 'the edited line kept its old measurement')
  view.dispatch(
    view.state.tr.replaceWith(
      0,
      view.state.doc.content.size,
      paragraph('no code'),
    ),
  )
  assert.equal(entries(), 0, 'deleted blocks kept their measurements')
})
