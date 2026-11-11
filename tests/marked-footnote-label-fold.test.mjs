import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { Marked } from 'marked'
import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'
import { countText } from '../src/addons/word-count/count.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { Footnotes } from '../src/shared/markdown-extra-syntax.ts'
import { blockMarkdown } from '../src/shared/marked-blocks.ts'
import { markedGithubFootnote } from '../src/shared/marked-footnotes.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

registerHooks({
  load: (url, context, next) =>
    url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : next(url, context),
})
const { formattedMarkdown } = await import(
  '../src/renderer/src/formatted-contributions.ts'
)
const {
  defined,
  definitionsRead,
  footnoteDefinitions,
  footnoteScan,
  readDefinitions,
} = await import('../src/renderer/src/formatted/footnote-definitions.ts')

// [definition label, reference label]: GFM folds case fully, so these match.
const folded = [
  ['ß', 'SS'],
  ['ẞ', 'ss'],
  ['ß', 'ẞ'],
  ['ﬀ', 'FF'],
  ['σ', 'ς'],
  ['Σ', 'ς'],
  ['ı', 'I'],
  ['İ', 'i̇'],
  ['é', 'É'],
  ['Straße', 'STRASSE'],
]
// And these do not: GFM folds case, not canonical equivalence.
const distinct = [
  ['é', 'é'],
  ['a', 'b'],
]
const references = (html) => (html.match(/data-footnote-ref/g) ?? []).length
const note = ([definition, reference]) =>
  `x[^${reference}]\n\n[^${definition}]: note`

test('footnote labels match by GFM case folding in export', () => {
  for (const pair of [...folded, ...distinct]) {
    const source = note(pair)
    const expected = references(
      micromark(source, { extensions: [gfm()], htmlExtensions: [gfmHtml()] }),
    )
    assert.equal(expected, folded.includes(pair) ? 1 : 0, source)
    assert.equal(
      references(
        new Marked(blockMarkdown, markedGithubFootnote()).parse(source),
      ),
      expected,
      source,
    )
  }
})

test('footnote labels keep their written text in export ids and tokens', () => {
  const markdown = new Marked(blockMarkdown, markedGithubFootnote())
  const source = 'x[^Straße] and y[^STRASSE]\n\n[^Straße]: note'
  const tokens = markdown.lexer(source)
  const definition = tokens.find((token) => token.type === 'footnoteDef')
  assert.equal(definition.label, 'Straße')
  assert.equal(definition.raw, '[^Straße]: note')
  const [paragraph] = tokens
  assert.deepEqual(
    paragraph.tokens
      .filter((token) => token.type === 'footnoteRef')
      .map((token) => token.raw),
    ['[^Straße]', '[^STRASSE]'],
  )
  // Both references point at one footnote.
  assert.equal((markdown.parse(source).match(/<li id="fn-/g) ?? []).length, 1)
})

test('footnote labels match by GFM case folding in word count', () => {
  const syntax = { ...defaultNoteSyntax, gfm: true }
  for (const pair of [...folded, ...distinct]) {
    const source = note(pair)
    // A resolved reference holds no words; an unresolved one stays text.
    const text = richText(source, syntax)
    assert.equal(text.includes('[^'), !folded.includes(pair), source)
    assert.equal(
      countText(text.slice(1)).words,
      folded.includes(pair) ? 2 : 2 + countText(pair[1]).words,
      source,
    )
  }
})

test('footnote labels match by GFM case folding in the formatted view', () => {
  for (const pair of [...folded, ...distinct]) {
    let state = EditorState.create({
      doc: note(pair),
      extensions: [formattedMarkdown.of(Footnotes), footnoteDefinitions],
    })
    while (!definitionsRead(state))
      state = state.update({
        effects: readDefinitions.of(footnoteScan.slice),
      }).state
    assert.equal(defined(state, pair[1]), folded.includes(pair), note(pair))
  }
})
