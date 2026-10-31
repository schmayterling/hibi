import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { EditorState, Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { GFM, parser } from '@lezer/markdown'
import {
  maximumSlashQueryUnits,
  slashQuery,
} from '../src/addons/slash-commands/commands.ts'
import {
  frontmatterBounds,
  frontmatterProbe,
  frontmatterSearch,
} from '../src/renderer/src/formatted-frontmatter.ts'
import { readFrontmatter } from '../src/shared/frontmatter.ts'

async function load(file, name, bindings) {
  const source = stripTypeScriptTypes(
    await readFile(
      new URL(`../src/addons/slash-commands/${file}.ts`, import.meta.url),
      'utf8',
    ),
    { mode: 'transform' },
  )
    .replace(/^import .* from .*$/gm, '')
    .replace(/^export /gm, '')
  return new Function(...Object.keys(bindings), `${source}\nreturn ${name}`)(
    ...Object.values(bindings),
  )
}
const sourceBounds = (state) => state.field(frontmatterBounds, false)
const astral = '\u{10400}'.repeat(48)

test('source reads only a possible slash prefix, even near the start of a long line', async () => {
  const ranges = []
  let treeReads = 0
  const current = await load('source', 'current', {
    EditorView: { editable: Symbol('editable') },
    syntaxTree: () => {
      treeReads++
      return { resolveInner: () => null }
    },
    slashQuery,
    maximumSlashQueryUnits,
    frontmatterBounds,
  })
  const match = (source, head = source.length) => {
    ranges.length = 0
    const text = Text.of([source])
    return current({
      hasFocus: true,
      scrollDOM: { classList: { contains: () => false } },
      state: {
        readOnly: false,
        facet: () => true,
        selection: { main: { head, empty: true }, ranges: [{}] },
        field: () => undefined,
        doc: {
          lineAt: () => ({
            from: 0,
            get text() {
              throw new Error('must not read the full line')
            },
          }),
          sliceString: (from, to) => {
            ranges.push([from, to])
            return text.sliceString(from, to)
          },
        },
      },
    })
  }
  assert.equal(match('x'.repeat(100_000)), null)
  assert.deepEqual(ranges, [])
  assert.equal(match('ordinary'), null)
  assert.equal(treeReads, 0)
  assert.deepEqual(ranges, [[0, 8]])
  assert.equal(match(`/a${'x'.repeat(100_000)}`, 2).query, 'a')
  assert.deepEqual(ranges, [[0, 2]])
  assert.equal(`/${astral}`.length, maximumSlashQueryUnits)
  assert.equal(match(`/${astral}`).query, astral)
  assert.deepEqual(ranges, [[0, maximumSlashQueryUnits]])
  assert.equal(match(`/${astral}\u{10400}`), null)
  assert.deepEqual(ranges, [])
})

test('source slash queries stay blocked while frontmatter bounds are unfinished', async () => {
  const current = await load('source', 'current', {
    EditorView,
    syntaxTree: () => ({ resolveInner: () => null }),
    slashQuery,
    maximumSlashQueryUnits,
    frontmatterBounds,
  })
  const prefix = '---\nprevious: ok\n/h2'
  const suffix = '\n---\n\n/h2'
  const start = `${prefix}: value\npadding: `
  const text =
    start + 'x'.repeat(78_035 - start.length - suffix.length) + suffix
  assert.equal(prefix.length, 20)
  assert.ok(readFrontmatter(text))
  for (const bom of ['', '\uFEFF']) {
    let state = EditorState.create({
      doc: bom + text,
      selection: { anchor: prefix.length + bom.length },
      extensions: [frontmatterBounds],
    })
    const view = () => ({
      hasFocus: true,
      scrollDOM: { classList: { contains: () => false } },
      state,
    })
    assert.equal(state.field(frontmatterBounds).end, 0)
    assert.ok(state.field(frontmatterBounds).searched < state.doc.length)
    assert.equal(current(view(), undefined, sourceBounds), null)
    while (!state.field(frontmatterBounds).closer)
      state = state.update({ effects: frontmatterSearch.of(null) }).state
    assert.ok(state.field(frontmatterBounds).end > state.selection.main.head)
    assert.equal(current(view(), undefined, sourceBounds), null)
    state = state.update({ selection: { anchor: state.doc.length } }).state
    assert.equal(current(view(), undefined, sourceBounds).query, 'h2')
  }
})

test('source frontmatter checks read nothing per query, and edits only the lines they touch', async () => {
  const current = await load('source', 'current', {
    EditorView: { editable: Symbol('editable') },
    syntaxTree: () => ({ resolveInner: () => null }),
    slashQuery,
    maximumSlashQueryUnits,
    frontmatterBounds,
    readFrontmatter,
  })
  const body = 'ordinary words in a paragraph\n\n'.repeat(
    Math.ceil((50 * 1024 * 1024) / 31),
  )
  // The query after a note's `/h2`, and the units the check read.
  const check = (state) => {
    let units = 0
    const { head } = state.selection.main
    const match = current(
      {
        hasFocus: true,
        scrollDOM: { classList: { contains: () => false } },
        state: {
          readOnly: false,
          facet: () => true,
          selection: { main: { head, empty: true }, ranges: [{}] },
          field: (field, require) => state.field(field, require),
          doc: {
            length: state.doc.length,
            lineAt: (pos) => state.doc.lineAt(pos),
            sliceString(from, to) {
              const read = state.doc.sliceString(from, to)
              units += read.length
              return read
            },
            toString() {
              units += state.doc.length
              return state.doc.toString()
            },
          },
        },
      },
      undefined,
      sourceBounds,
    )
    return { query: match?.query ?? null, units }
  }
  const note = (before, after) =>
    EditorState.create({
      doc: `${before}/h2${after}`,
      selection: { anchor: before.length + 3 },
      extensions: [frontmatterBounds],
    })
  assert.deepEqual(
    check(note('---\ntitle: Long note\n---\n\n', `\n\n${body}`)),
    { query: 'h2', units: 3 },
  )
  assert.deepEqual(check(note('---\ntitle: Long note\n', `\n---\n\n${body}`)), {
    query: null,
    units: 3,
  })
  let oversized = note(`---\ntitle: ${'x'.repeat(300000)}\n`, '\n...\nbody')
  while (!oversized.field(frontmatterBounds).complete)
    oversized = oversized.update({ effects: frontmatterSearch.of(null) }).state
  assert.equal(oversized.field(frontmatterBounds).oversized, true)
  assert.deepEqual(check(oversized), { query: null, units: 3 })
  // A divider without a closing line: the editor reads a bounded part of
  // the note at first and the rest in idle time; edits read their lines.
  frontmatterProbe.lines = 0
  let divider = note('---\n\n', `\n\n${body}`)
  assert.ok(frontmatterProbe.lines < 10_000, String(frontmatterProbe.lines))
  for (let query = 0; query < 3; query++)
    assert.deepEqual(check(divider), { query: null, units: 3 })
  frontmatterProbe.lines = 0
  frontmatterProbe.parses = 0
  divider = divider.update({ changes: { from: 4, insert: 'x' } }).state
  assert.ok(frontmatterProbe.lines < 10_000, String(frontmatterProbe.lines))
  assert.equal(frontmatterProbe.parses, 0)
})

test('formatted queries begin at text blocks, keep container prefixes and reject code and continuation lines', async () => {
  const current = await load('source', 'current', {
    EditorView: { editable: Symbol('editable') },
    syntaxTree: (state) => parser.configure(GFM).parse(state.doc.toString()),
    slashQuery,
    maximumSlashQueryUnits,
  })
  const match = (source, properties = {}) => {
    const head = source.indexOf('/h2') + 3
    return current(
      {
        hasFocus: true,
        composing: false,
        scrollDOM: { classList: { contains: () => false } },
        state: {
          doc: Text.of(source.split('\n')),
          selection: { main: { head, empty: true }, ranges: [{}] },
          readOnly: false,
          facet: () => true,
        },
        ...properties,
      },
      (state) => parser.configure(GFM).parse(state.doc.toString()),
    )
  }
  for (const [source, from] of [
    ['/h2', 0],
    ['> /h2', 2],
    ['- /h2', 2],
    ['1. /h2', 3],
    ['# /h2', 2],
    ['- [ ] /h2', 6],
    ['/h2\n---', 0],
  ]) {
    const value = match(source)
    assert.equal(value?.query, 'h2', source)
    assert.equal(value.from, from, source)
  }
  for (const source of [
    'one\n/h2',
    '`/h2`',
    '```\n/h2\n```',
    '    /h2',
    '<div>\n/h2\n</div>',
  ])
    assert.equal(match(source), null, source)
  assert.equal(match('/h2', { composing: true }), null)
  assert.equal(match('/h2', { hasFocus: false }), null)
  assert.equal(
    match('/h2', { scrollDOM: { classList: { contains: () => true } } }),
    null,
  )
})

test('formatted prefix reads stay bounded without materializing complete documents', async () => {
  const source = '/h2' + 'x'.repeat(100_000)
  const parsed = parser.configure(GFM).parse(source)
  const state = EditorState.create({ doc: source, selection: { anchor: 3 } })
  const reads = []
  const current = await load('source', 'current', {
    EditorView: { editable: Symbol('editable') },
    slashQuery,
    maximumSlashQueryUnits,
  })
  const doc = {
    lineAt: (position) => ({ from: state.doc.lineAt(position).from }),
    sliceString: (from, to) => {
      reads.push(to - from)
      return state.doc.sliceString(from, to)
    },
    toString() {
      throw new Error('must not materialize the document')
    },
  }
  const view = {
    hasFocus: true,
    composing: false,
    scrollDOM: { classList: { contains: () => false } },
    state: { doc, selection: state.selection, facet: () => true },
  }
  assert.equal(current(view, () => parsed).query, 'h2')
  assert.deepEqual(reads, [3])
  reads.length = 0
  view.state.selection = {
    main: { head: source.length, empty: true },
    ranges: [{}],
  }
  assert.equal(
    current(view, () => parsed),
    null,
  )
  assert.deepEqual(reads, [])
})
