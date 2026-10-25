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

/** Mounts the plugin view with controllable frames and a block that fills the pane. */
function mount(t, plugin, state, geometry = {}) {
  const frames = new Map()
  const listeners = new Map()
  let id = 0
  const listen = (target) => ({
    addEventListener: (type, listener) =>
      listeners.set(`${target}${type}`, listener),
    removeEventListener: (type) => listeners.delete(`${target}${type}`),
  })
  const text = {}
  const globals = {
    requestAnimationFrame: (callback) => {
      frames.set(++id, callback)
      return id
    },
    cancelAnimationFrame: (frame) => frames.delete(frame),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    document: {
      ...listen('document:'),
      caretPositionFromPoint: (_x, y) => ({
        offsetNode: text,
        offset: geometry.at(y),
      }),
    },
    window: { innerHeight: 800, ...listen('window:') },
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
      parentElement: null,
      getBoundingClientRect: () => ({ top: 0, bottom: 800 }),
    },
    nodeDOM: () => ({
      getBoundingClientRect: () => ({ top: -1e6, bottom: 1e6 }),
      contains: (node) => node === text,
    }),
    coordsAtPos: () => ({ left: 10 }),
    posAtDOM: (_node, offset) => offset,
    dispatch(transaction) {
      const before = view.state
      view.dispatches++
      view.state = before.apply(transaction)
      pluginView.update?.(view, before)
    },
    /** Runs frames until no more work is scheduled. */
    flush() {
      for (let count = 0; frames.size; count++) {
        assert.ok(count < 10000, 'highlighting kept scheduling frames')
        const [frame, callback] = frames.entries().next().value
        frames.delete(frame)
        callback(performance.now())
      }
    },
    scroll: () => listeners.get('document:scroll')?.(),
  }
  pluginView = plugin.spec.view(view)
  t.after(() => {
    pluginView.destroy()
    Object.assign(globalThis, previous)
  })
  return view
}

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
      const view = mount(t, plugin, state, {
        at: (y) => Math.round(top + (y / 800) * 3_000),
      })
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
          tokens(decorations).filter(settled),
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
