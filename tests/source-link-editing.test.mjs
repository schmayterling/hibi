import assert from 'node:assert/strict'
import test from 'node:test'
import { history, undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import { formattedTree } from '../src/renderer/src/formatted-contributions.ts'
import { formattedReferences } from '../src/renderer/src/formatted-references.ts'
import { sourceFormatting } from '../src/renderer/src/source-formatting.ts'

const markdown = parser.configure(GFM)

test('a hovered link edits its captured target instead of the current caret', async () => {
  const source = '[first](one.md) and [second](two.md)'
  const target = view(source, 'first')
  const captured = sourceFormatting(target).capture(
    source.indexOf('second') + 2,
  )
  assert.equal(await captured.href, 'two.md')
  assert.equal(captured.run('link', { url: 'new.md', alt: '' }), true)
  assert.equal(
    target.state.doc.toString(),
    '[first](one.md) and [second](new.md)',
  )
})

for (const source of [
  'https://example.com/a',
  'www.example.com/path',
  'person@example.com',
]) {
  test(`removing a detected link keeps its text unlinked: ${source}`, () => {
    const target = view(source, source.slice(0, 3))
    assert.equal(sourceFormatting(target).run('unlink'), true)
    assert.doesNotMatch(
      markdown.parse(target.state.doc.toString()).toString(),
      /(?:Link|URL)\(/,
    )
    assert.equal(undo(target), true)
    assert.equal(target.state.doc.toString(), source)
  })
}

test('a captured link cannot overwrite a newer document', () => {
  const source = '[first](one.md) and [second](two.md)'
  const target = view(source, 'first')
  const captured = sourceFormatting(target).capture(
    source.indexOf('second') + 2,
  )
  target.dispatch({ changes: { from: 0, insert: 'New: ' } })
  assert.equal(captured.run('link', { url: 'new.md', alt: '' }), false)
  assert.equal(target.state.doc.toString(), 'New: ' + source)
})

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
