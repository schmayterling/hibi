import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: `
      export { registerFormattedFlavor } from './src/renderer/src/formatted-flavor.ts'
      export { formattedRegistry } from './src/renderer/src/formatted-registry.ts'
      export { renderInline } from './src/renderer/src/formatted/table-cells.ts'
      export { formattedViews } from './src/renderer/src/formatted-contributions.ts'
      export { cellContent } from './src/renderer/src/formatted/table-source.ts'
      export { EditorState, StateField } from '@codemirror/state'
      export { WidgetType } from '@codemirror/view'
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
})
const {
  registerFormattedFlavor,
  formattedRegistry,
  renderInline,
  formattedViews,
  cellContent,
  EditorState,
  StateField,
  WidgetType,
} = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
)

test('cell renderers retain the owner state and canonical source positions', async () => {
  const original = globalThis.document
  class Element {
    children = []
    attributes = {}
    setAttribute(name, value) {
      this.attributes[name] = value
    }
    append(...children) {
      this.children.push(...children)
    }
  }
  globalThis.document = {
    createElement: () => new Element(),
    createTextNode: (text) => ({ text }),
  }
  const errors = []
  const seen = []
  const length = StateField.define({
    create: (state) => state.doc.length,
    update: (_, transaction) => transaction.newDoc.length,
  })
  const remove = registerFormattedFlavor(
    'owner',
    {
      id: 'cell',
      render: [
        {
          nodes: ['StrongEmphasis'],
          decorate(node, out, { state, visible }) {
            seen.push({
              state,
              length: state.field(length),
              text: state.sliceDoc(node.from, node.to),
              mark: state.sliceDoc(
                node.node.firstChild.from,
                node.node.firstChild.to,
              ),
              visible,
            })
            out.link(node.from, node.to, { class: 'cell-proof' })
          },
        },
      ],
    },
    (error) => errors.push(error),
  )
  try {
    const view = formattedRegistry.entries()[0].load().views[0]
    const prefix = 'before 😀\r\n| '
    const raw = '**a\\|b**'
    let state = EditorState.create({
      doc: prefix + raw + ' |\r\n',
      extensions: [
        EditorState.lineSeparator.of('\n'),
        length,
        formattedViews.of(view),
      ],
    })
    for (const replacement of [null, '**longer\\|cell**']) {
      if (replacement)
        state = state.update({
          changes: {
            from: prefix.length,
            to: prefix.length + raw.length,
            insert: replacement,
          },
        }).state
      const source = replacement ?? raw
      const content = cellContent(source)
      const root = new Element()
      renderInline({ state }, content.text, root, prefix.length, content.source)
      assert.equal(seen.at(-1)?.state, state)
      assert.equal(seen.at(-1)?.length, state.doc.length)
      assert.equal(seen.at(-1)?.text, source)
      assert.equal(seen.at(-1)?.mark, '**')
      assert.deepEqual(seen.at(-1)?.visible, {
        from: prefix.length,
        to: prefix.length + source.length,
      })
      assert.deepEqual(root.children[0]?.attributes, {
        class: 'hibi-lp-link cell-proof',
        role: 'link',
      })
      const textOf = (node) => node.text ?? node.children.map(textOf).join('')
      assert.equal(
        textOf(root.children[0]),
        source.slice(2, -2).replace('\\|', '|'),
      )
    }
    await Promise.resolve()
    assert.deepEqual(errors, [])
    assert.equal(formattedRegistry.entries().length, 1)
  } finally {
    remove()
    globalThis.document = original
  }
})

for (const hook of ['decorate', 'layout', 'container', 'paint']) {
  test(`a failed ${hook} callback removes only its flavor and reports once`, async () => {
    const failure = new Error(`${hook} failed`)
    const errors = []
    let calls = 0
    const callback = () => {
      calls++
      throw failure
    }
    const remove = registerFormattedFlavor(
      'owner',
      {
        id: 'failing',
        render: [
          {
            nodes: ['Paragraph'],
            ...(hook === 'paint'
              ? { container: () => ({ paint: callback }) }
              : { [hook]: callback }),
          },
        ],
      },
      (error) => errors.push(error),
    )
    const other = registerFormattedFlavor(
      'other',
      {
        id: 'healthy',
        render: [{ nodes: ['Paragraph'], decorate: () => undefined }],
      },
      assert.fail,
    )
    try {
      const contribution = formattedRegistry.entries()[0].load()
      const view = contribution.views[0]
      const invoke = () =>
        hook === 'paint'
          ? view.container({}, {}).paint('0px', '0px')
          : view[hook]({}, {}, {})
      assert.doesNotThrow(invoke)
      if (hook !== 'paint') assert.doesNotThrow(invoke)
      assert.equal(calls, 1)
      await Promise.resolve()
      assert.equal(errors.length, 1)
      assert.equal(errors[0].message, `owner.failing: ${hook} failed`)
      assert.equal(errors[0].cause, failure)
      assert.deepEqual(
        formattedRegistry.entries().map(({ id }) => id),
        ['flavor:other.healthy'],
      )
      assert.equal(
        formattedRegistry.entries()[0].load().views[0].decorate({}, {}, {}),
        undefined,
      )
    } finally {
      remove()
      other()
    }
  })
}

/** Just enough DOM for widgets and attribute names; names follow the HTML parser's rule. */
class Element {
  setAttribute(name) {
    if (!/^[a-z][a-z0-9-]*$/i.test(name))
      throw new Error(`'${name}' is not a valid attribute name.`)
  }
}
function installDocument() {
  const original = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
  }
  globalThis.document = { createElement: () => new Element() }
  globalThis.HTMLElement = Element
  return () => Object.assign(globalThis, original)
}
const doc = 'one\ntwo\n\nthree\n'
const renderState = EditorState.create({ doc })
const paragraph = { from: 4, to: 7, name: 'Paragraph' }
/** Calls a registered view's hook with a sink that records what reaches the renderer. */
function render(id, hook) {
  const calls = []
  const record =
    (name) =>
    (...args) =>
      calls.push([name, ...args])
  const view = formattedRegistry
    .entries()
    .find((entry) => entry.id === `flavor:${id}`)
    .load().views[0]
  view[hook](
    paragraph,
    Object.fromEntries(
      ['mark', 'link', 'syntax', 'line', 'widget', 'replace'].map((name) => [
        name,
        record(name),
      ]),
    ),
    {
      state: renderState,
      revealed: false,
      visible: hook === 'decorate' ? { from: 0, to: doc.length } : null,
    },
  )
  return calls
}
class Label extends WidgetType {
  constructor(text) {
    super()
    this.text = text
  }
  eq(other) {
    return other.text === this.text
  }
  toDOM() {
    return new Element()
  }
}

test('formatted output the renderer cannot keep fails in its owner guard before it is kept', async () => {
  const restore = installDocument()
  const cases = [
    ['decorate', (out) => out.line(doc.length + 1, {})],
    ['decorate', (out) => out.line(5, { class: 'mid-line' })],
    ['decorate', (out) => out.syntax(0, 7)],
    ['decorate', (out) => out.replace(4, 9)],
    ['decorate', (out) => out.mark(-1, 2, {})],
    ['decorate', (out) => out.link(-1, 2)],
    ['decorate', (out) => out.link(2, doc.length + 1)],
    ['decorate', (out) => out.link(0, 1.5)],
    ['decorate', (out) => out.link(2, 1)],
    ['decorate', (out) => out.link(0, 2, { title: 1 })],
    ['decorate', (out) => out.link(0, 2, { 'bad name': 'x' })],
    ['decorate', (out) => out.syntax(5, 4)],
    ['decorate', (out) => out.mark(0, 1.5, {})],
    ['decorate', (out) => out.mark(0, 2, { title: 1 })],
    ['decorate', (out) => out.mark(0, 2, { 'bad name': 'x' })],
    ['decorate', (out) => out.widget(0, { toDOM: () => new Element() })],
    ['decorate', (out) => out.widget(0, new Label('x'), 0)],
    ['layout', (out) => out.replace(4, doc.length + 7, new Label('x'))],
    ['layout', (out) => out.widget(9, new Label('x'), { block: true })],
    ['layout', (out) => out.replace(0, 7)],
    ['layout', (out) => out.replace(7, 4)],
  ]
  try {
    for (const [hook, emit] of cases) {
      const errors = []
      const remove = registerFormattedFlavor(
        'owner',
        {
          id: 'checked',
          render: [
            {
              nodes: ['Paragraph'],
              [hook](_node, out) {
                if (hook === 'decorate') out.mark(4, 7, { class: 'kept' })
                else out.replace(4, 7)
                emit(out)
              },
            },
          ],
        },
        (error) => errors.push(error),
      )
      try {
        const calls = render('owner.checked', hook)
        assert.deepEqual(
          calls,
          hook === 'decorate'
            ? [['mark', 4, 7, { class: 'kept' }]]
            : [['replace', 4, 7, undefined, undefined]],
          String(emit),
        )
        await Promise.resolve()
        assert.equal(errors.length, 1, String(emit))
        assert.match(errors[0].message, /^owner\.checked: /)
        assert.ok(errors[0].cause instanceof Error)
        assert.equal(formattedRegistry.entries().length, 0, String(emit))
      } finally {
        remove()
      }
    }
  } finally {
    restore()
  }
})

test('valid formatted output reaches the renderer with addon widgets drawn in their owner guard', async () => {
  const restore = installDocument()
  const updates = []
  class Counter extends WidgetType {
    constructor(count) {
      super()
      this.count = count
    }
    eq(other) {
      return other.count === this.count
    }
    toDOM() {
      return new Element()
    }
    updateDOM(dom, _view, from) {
      updates.push([dom, from])
      return true
    }
    get estimatedHeight() {
      return 12
    }
  }
  const errors = []
  const label = new Label('a')
  const remove = registerFormattedFlavor(
    'owner',
    {
      id: 'valid',
      render: [
        {
          nodes: ['Paragraph'],
          decorate(_node, out) {
            out.mark(0, 3, {
              class: 'a',
              'data-kind': 'b',
              style: 'color: red',
            })
            out.syntax(4, 5)
            out.syntax(5, 5)
            out.line(9, { class: 'line' })
            out.widget(doc.length, label, -1)
            out.replace(9, 14, new Counter(1))
            out.replace(0, 1)
            out.link(0, 3)
            out.link(4, 7, { class: 'link-proof' })
          },
          layout(_node, out) {
            out.replace(4, 7, new Counter(2), { block: true })
            out.widget(7, new Label('below'), { block: true, side: 1 })
          },
        },
      ],
    },
    (error) => errors.push(error),
  )
  try {
    const decorated = render('owner.valid', 'decorate')
    const laid = render('owner.valid', 'layout')
    assert.deepEqual(
      decorated.map(([name, ...args]) =>
        [name, ...args].map((arg) =>
          arg instanceof WidgetType ? 'widget' : arg,
        ),
      ),
      [
        ['mark', 0, 3, { class: 'a', 'data-kind': 'b', style: 'color: red' }],
        ['syntax', 4, 5],
        ['syntax', 5, 5],
        ['line', 9, { class: 'line' }],
        ['widget', doc.length, 'widget', -1],
        ['replace', 9, 14, 'widget'],
        ['replace', 0, 1, undefined],
        ['link', 0, 3, undefined],
        ['link', 4, 7, { class: 'link-proof' }],
      ],
    )
    assert.deepEqual(
      laid.map(([name, ...args]) =>
        [name, ...args].map((arg) =>
          arg instanceof WidgetType ? 'widget' : arg,
        ),
      ),
      [
        ['replace', 4, 7, 'widget', { block: true }],
        ['widget', 7, 'widget', { block: true, side: 1 }],
      ],
    )
    const owned = decorated[4][2]
    assert.notEqual(owned, label)
    assert.ok(owned.toDOM({}) instanceof Element)
    const [first, second] = [decorated[5][3], laid[0][3]]
    const again = render('owner.valid', 'decorate')[5][3]
    // Same-class widgets compare and update through the addon's own methods.
    assert.ok(first.compare(again))
    assert.ok(!first.compare(second))
    assert.ok(!first.compare(owned))
    const dom = new Element()
    assert.equal(second.updateDOM(dom, {}, first), true)
    assert.equal(updates[0][0], dom)
    assert.ok(updates[0][1] instanceof Counter)
    assert.equal(owned.updateDOM(dom, {}, first), false)
    assert.equal(first.estimatedHeight, 12)
    assert.equal(owned.estimatedHeight, -1)
    assert.equal(owned.lineBreaks, 0)
    await Promise.resolve()
    assert.deepEqual(errors, [])
    assert.equal(formattedRegistry.entries().length, 1)
  } finally {
    remove()
    restore()
  }
})

test('a failing addon widget draws empty and removes only its owner', async () => {
  const restore = installDocument()
  const failure = new Error('draw failed')
  const broken = {
    toDOM() {
      throw failure
    },
    'not an element': {
      toDOM: () => ({}),
    },
    eq: {
      eq() {
        throw failure
      },
    },
    height: {
      get estimatedHeight() {
        return Number.NaN
      },
    },
    'line breaks': {
      get lineBreaks() {
        return -1
      },
    },
  }
  try {
    for (const [name, methods] of Object.entries({
      toDOM: { toDOM: broken.toDOM },
      ...Object.fromEntries(
        Object.entries(broken).filter(([key]) => key !== 'toDOM'),
      ),
    })) {
      let draws = 0
      class Broken extends Label {}
      for (const [key, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(methods),
      ))
        Object.defineProperty(Broken.prototype, key, descriptor)
      const original = Broken.prototype.toDOM
      Broken.prototype.toDOM = function (view) {
        draws++
        return original.call(this, view)
      }
      const errors = []
      const remove = registerFormattedFlavor(
        'owner',
        {
          id: 'broken',
          render: [
            {
              nodes: ['Paragraph'],
              decorate(_node, out) {
                out.replace(0, 3, new Broken('x'))
              },
            },
          ],
        },
        (error) => errors.push(error),
      )
      const other = registerFormattedFlavor(
        'other',
        {
          id: 'healthy',
          render: [{ nodes: ['Paragraph'], decorate: () => undefined }],
        },
        assert.fail,
      )
      try {
        const widget = render('owner.broken', 'decorate')[0][3]
        const twin = render('owner.broken', 'decorate')[0][3]
        const results = {
          eq: widget.compare(twin),
          dom: widget.toDOM({}),
          height: widget.estimatedHeight,
          breaks: widget.lineBreaks,
        }
        assert.equal(results.dom instanceof Element, true, name)
        assert.equal(results.height, -1, name)
        assert.equal(results.breaks, 0, name)
        if (name === 'eq') assert.equal(results.eq, false)
        // Nothing of a failed owner runs again.
        const after = draws
        widget.toDOM({})
        assert.equal(draws, after, name)
        await Promise.resolve()
        assert.equal(errors.length, 1, name)
        assert.match(errors[0].message, /^owner\.broken: /, name)
        if (name === 'toDOM' || name === 'eq')
          assert.equal(errors[0].cause, failure)
        assert.deepEqual(
          formattedRegistry.entries().map(({ id }) => id),
          ['flavor:other.healthy'],
          name,
        )
      } finally {
        remove()
        other()
      }
    }
  } finally {
    restore()
  }
})

test('widgets of a failed owner still release what they hold, reporting only the first failure', async () => {
  const restore = installDocument()
  const failure = new Error('draw failed')
  const released = []
  let draws = 0
  let releaseFails = false
  class Held extends Label {
    toDOM() {
      draws++
      if (this.text === 'broken') throw failure
      return super.toDOM()
    }
    destroy(dom) {
      released.push([this.text, dom])
      if (releaseFails) throw new Error('release failed')
    }
  }
  const errors = []
  const register = (id) =>
    registerFormattedFlavor(
      'owner',
      {
        id,
        render: [
          {
            nodes: ['Paragraph'],
            decorate(_node, out) {
              out.replace(0, 1, new Held('drawn'))
              out.replace(4, 5, new Held('broken'))
            },
          },
        ],
      },
      (error) => errors.push(error),
    )
  const remove = register('held')
  try {
    const [[, , , drawn], [, , , broken]] = render('owner.held', 'decorate')
    const dom = drawn.toDOM({})
    const placeholder = broken.toDOM({})
    assert.equal(draws, 2)
    // Other callbacks of a failed owner stay off.
    assert.ok(drawn.toDOM({}) instanceof Element)
    assert.equal(draws, 2)
    releaseFails = true
    assert.doesNotThrow(() => drawn.destroy(dom))
    assert.doesNotThrow(() => broken.destroy(placeholder))
    assert.deepEqual(released, [
      ['drawn', dom],
      ['broken', placeholder],
    ])
    await Promise.resolve()
    assert.equal(errors.length, 1)
    assert.equal(errors[0].message, 'owner.held: draw failed')
    assert.equal(errors[0].cause, failure)
    assert.equal(formattedRegistry.entries().length, 0)
  } finally {
    remove()
  }
  // A failing release is the owner's first failure when nothing failed before.
  errors.length = 0
  released.length = 0
  const again = register('release')
  try {
    const [[, , , drawn]] = render('owner.release', 'decorate')
    const dom = drawn.toDOM({})
    assert.doesNotThrow(() => drawn.destroy(dom))
    assert.doesNotThrow(() => drawn.destroy(dom))
    assert.equal(released.length, 2)
    await Promise.resolve()
    assert.equal(errors.length, 1)
    assert.equal(errors[0].message, 'owner.release: release failed')
    assert.equal(formattedRegistry.entries().length, 0)
  } finally {
    again()
    restore()
  }
})
