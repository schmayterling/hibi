import assert from 'node:assert/strict'
import test from 'node:test'
import { history, undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import { formattedTree } from '../src/renderer/src/formatted-contributions.ts'
import { formattedReferences } from '../src/renderer/src/formatted-references.ts'
import { sourceFormatting } from '../src/renderer/src/source-formatting.ts'

const markdown = parser.configure(GFM)
function view(doc, text, reference = null) {
  const target = {
    dom: { isConnected: true },
    state: EditorState.create({
      doc,
      selection: { anchor: doc.indexOf(text) + 1 },
      extensions: [
        history(),
        formattedTree.of((state) => markdown.parse(state.doc.toString())),
        formattedReferences.of({
          syntax: () => '',
          resolve: async () => ({ status: 'resolved', value: reference }),
        }),
      ],
    }),
    dispatch(spec) {
      this.state = this.state.update(spec).state
    },
    focus() {},
  }
  target.dispatch = target.dispatch.bind(target)
  return target
}

for (const [name, source, text, href, expected, reference] of [
  [
    'title',
    'See [**docs**](https://old.example "Keep me") here.',
    'docs',
    'https://old.example',
    'See [**docs**](https://new.example "Keep me") here.',
  ],
  [
    'escaped destination',
    'See [docs](https://old.example/a\\(b\\)?x=1&amp;y=2) here.',
    'docs',
    'https://old.example/a(b)?x=1&y=2',
    'See [docs](https://new.example) here.',
  ],
  [
    'autolink',
    'See <https://old.example> here.',
    'https',
    'https://old.example',
    'See [https://old.example](https://new.example) here.',
  ],
  [
    'reference',
    'See [docs][ref] here.\n\n[ref]: https://old.example "Keep me"',
    'docs',
    'https://old.example',
    'See [docs](https://new.example "Keep me") here.\n\n[ref]: https://old.example "Keep me"',
    { href: 'https://old.example', title: 'Keep me' },
  ],
  [
    'table cell',
    '| title |\n| --- |\n| [docs](https://old.example "Keep me") |',
    'docs',
    'https://old.example',
    '| title |\n| --- |\n| [docs](https://new.example "Keep me") |',
  ],
]) {
  test(`link capture and save preserve ${name}, with one undo`, async () => {
    const target = view(source, text, reference)
    const captured = sourceFormatting(target).capture()
    assert.equal(await captured.href, href)
    assert.equal(
      captured.run('link', { url: 'https://new.example', alt: '' }),
      true,
    )
    assert.equal(target.state.doc.toString(), expected)
    assert.equal(undo(target), true)
    assert.equal(target.state.doc.toString(), source)
  })
}
