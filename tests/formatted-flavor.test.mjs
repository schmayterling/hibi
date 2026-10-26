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
            out.mark(node.from, node.to, { class: 'cell-proof' })
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
      assert.deepEqual(root.children[0]?.attributes, { class: 'cell-proof' })
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
      assert.deepEqual(errors, [failure])
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
