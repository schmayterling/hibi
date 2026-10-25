import assert from 'node:assert/strict'
import test from 'node:test'
import { history, undo } from '@tiptap/pm/history'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { findWrapping, liftTarget } from '@tiptap/pm/transform'
import {
  findNext,
  findPrev,
  firstRichMatch,
  richFind,
  richFindKey,
  setRichFindQuery,
} from '../src/renderer/src/rich-find.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*' },
    codeBlock: { group: 'block', content: 'text*', marks: '' },
    blockquote: { group: 'block', content: 'block+' },
    hardBreak: { group: 'inline', inline: true },
    chip: { group: 'inline', inline: true, content: 'text*' },
  },
  marks: { strong: {} },
})
const paragraph = (...content) =>
  schema.nodes.paragraph.create(
    null,
    content.map((part) =>
      typeof part === 'string' ? schema.text(part) : part,
    ),
  )
const create = (blocks, plugins = []) =>
  EditorState.create({
    schema,
    plugins: [richFind(), ...plugins],
    doc: schema.nodes.doc.create(null, blocks),
  })

// Fold each character alone, so σ and ς are the same letter in any context.
const fold = (text) => text.toLowerCase().replaceAll('ς', 'σ')

// Reference: fold every character, match anywhere, and report whole source characters.
function expectedMatches(doc, query) {
  const needle = fold(query)
  const text = (node) => {
    let value = ''
    node.forEach((child) => {
      value += child.isText
        ? child.text
        : child.isLeaf
          ? '\ufffc'
          : ` ${text(child)} `
    })
    return value
  }
  const matches = []
  doc.descendants((node, pos) => {
    if (!node.inlineContent) return true
    const units = []
    let offset = 0
    for (const character of text(node)) {
      for (const code of fold(character).split(''))
        units.push({ code, start: offset, end: offset + character.length })
      offset += character.length
    }
    for (let at = 0; at + needle.length <= units.length; ) {
      const candidate = units.slice(at, at + needle.length)
      if (candidate.map((unit) => unit.code).join('') === needle) {
        const end = units[at + needle.length - 1].end
        matches.push({ from: pos + 1 + units[at].start, to: pos + 1 + end })
        while (at < units.length && units[at].start < end) at++
      } else at++
    }
    return false
  })
  return matches
}

function verify(state, query) {
  const expected = expectedMatches(state.doc, query)
  const find = richFindKey.getState(state)
  const { from, to } = state.selection
  const selected = expected.findIndex(
    (match) => match.from === from && match.to === to,
  )
  assert.deepEqual(
    find.deco
      .find()
      .map((deco) => ({
        from: deco.from,
        to: deco.to,
        active: deco.type.attrs.class === 'ProseMirror-active-search-match',
      }))
      .sort((a, b) => a.from - b.from),
    expected.map((match, index) => ({ ...match, active: index === selected })),
  )
  assert.equal(find.total, expected.length)
  assert.equal(find.current, selected + 1)
  return expected
}

function target(state, command) {
  let selection = null
  command(state, (tr) => {
    selection = { from: tr.selection.from, to: tr.selection.to }
  })
  return selection
}

test('rich find keeps highlights, counts, and navigation exact through edits', () => {
  let seed = 7
  const random = (limit) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % limit
  }
  const query = 'NeeDle'
  const insertions = [
    'needle',
    'NEE',
    'dle',
    'x',
    ' ',
    'İ',
    '😀',
    'need',
    'le ',
  ]
  let state = create(
    [
      paragraph(
        'needle ',
        schema.text('nee', [schema.marks.strong.create()]),
        'dle',
      ),
      paragraph(
        'İx needle 😀 needle',
        schema.nodes.hardBreak.create(),
        'needle',
      ),
      schema.nodes.blockquote.create(null, [paragraph('a needle in a quote')]),
      schema.nodes.codeBlock.create(null, schema.text('NEEDLE\nneedle')),
      paragraph(
        'chip ',
        schema.nodes.chip.create(null, schema.text('needle')),
        ' needle',
      ),
    ],
    [history()],
  )
  state = state.apply(setRichFindQuery(state.tr, query))
  verify(state, query)
  const apply = (tr) => {
    state = state.apply(tr)
    const expected = verify(state, query)
    // Navigation matches a full scan of the current document.
    const { from, to } = state.selection
    const after = expected.find((match) => match.from >= to)
    const first = expected[0]
    assert.deepEqual(
      target(state, findNext),
      after ?? (first && first.to <= from ? first : null),
    )
    const before = expected.findLast((match) => match.to <= from)
    const last = expected.at(-1)
    assert.deepEqual(
      target(state, findPrev),
      before ?? (last && last.from >= to ? last : null),
    )
    assert.deepEqual(firstRichMatch(state), first ?? null)
  }
  const blocks = () => {
    const found = []
    state.doc.descendants((node, pos) => {
      if (node.inlineContent) found.push({ node, pos })
      return !node.inlineContent
    })
    return found
  }
  for (let step = 0; step < 400; step++) {
    const all = blocks()
    const { node, pos } = all[random(all.length)]
    const inside = pos + 1 + random(node.content.size + 1)
    const tr = state.tr
    switch (step % 13) {
      case 0:
        tr.insertText(insertions[random(insertions.length)], inside)
        break
      case 1:
        if (node.content.size)
          tr.delete(
            inside === pos + 1 + node.content.size ? inside - 1 : inside,
            Math.min(inside + 1 + random(6), pos + 1 + node.content.size),
          )
        break
      case 2:
        if (
          node.type !== schema.nodes.codeBlock &&
          state.doc.resolve(inside).parent === node
        )
          tr.split(inside)
        break
      case 3:
        if (
          pos > 0 &&
          state.doc.resolve(pos).nodeBefore?.inlineContent &&
          state.doc.resolve(pos).nodeBefore.type === node.type
        )
          tr.join(pos)
        break
      case 4:
        if (node.type !== schema.nodes.codeBlock)
          tr.addMark(pos + 1, inside, schema.marks.strong.create())
        break
      case 5:
        if (node.type !== schema.nodes.codeBlock)
          tr.setNodeMarkup(
            pos,
            node.type === schema.nodes.heading
              ? schema.nodes.paragraph
              : schema.nodes.heading,
          )
        break
      case 6: {
        const range = state.doc.resolve(pos + 1).blockRange()
        const lift = range && liftTarget(range)
        const wrapping = range && findWrapping(range, schema.nodes.blockquote)
        if (lift != null) tr.lift(range, lift)
        else if (wrapping) tr.wrap(range, wrapping)
        break
      }
      case 7:
        if (
          node.type !== schema.nodes.codeBlock &&
          state.doc.resolve(inside).parent === node
        )
          tr.insert(
            inside,
            random(2)
              ? schema.nodes.hardBreak.create()
              : schema.nodes.chip.create(null, schema.text('needle')),
          )
        break
      case 8: {
        // Delete into the next block, joining what remains, or add a block.
        const next = all[all.findIndex((block) => block.pos === pos) + 1]
        if (next && random(2))
          tr.delete(inside, next.pos + 1 + random(next.node.content.size + 1))
        else
          tr.insert(
            pos + node.nodeSize,
            paragraph(`needle ${insertions[random(insertions.length)]}needle`),
          )
        break
      }
      case 9:
        // Several steps in different blocks.
        for (const block of [all[0], all.at(-1), all[random(all.length)]])
          tr.insertText('needle', tr.mapping.map(block.pos + 1))
        if (random(2))
          tr.setSelection(
            TextSelection.near(tr.doc.resolve(random(tr.doc.content.size))),
          )
        break
      case 10:
        undo(state, (undone) => tr.setMeta('undone', undone))
        break
      case 11: {
        // Select a match, or an arbitrary range.
        const matches = expectedMatches(state.doc, query)
        const match =
          matches.length && random(3) ? matches[random(matches.length)] : null
        tr.setSelection(
          TextSelection.create(
            state.doc,
            match?.from ?? inside,
            match?.to ?? inside,
          ),
        )
        break
      }
      case 12:
        // Replacing everything with the same nodes discards all mapped highlights.
        if (!random(4))
          tr.replaceWith(0, state.doc.content.size, state.doc.content)
        else tr.setSelection(TextSelection.create(state.doc, inside))
        break
    }
    const undone = tr.getMeta('undone')
    apply(undone ?? tr)
  }
  state = state.apply(setRichFindQuery(state.tr, ''))
  assert.equal(richFindKey.getState(state).deco.find().length, 0)
  assert.equal(richFindKey.getState(state).total, 0)
})

test('rich find folds a dense paragraph once and restyles only the selected match', (t) => {
  const text = 'needle word '.repeat(20000).trimEnd()
  let state = create([paragraph(text)], [history()])
  let folded = 0
  const lower = String.prototype.toLowerCase
  t.mock.method(String.prototype, 'toLowerCase', function () {
    folded += this.length
    return lower.call(this)
  })
  state = state.apply(setRichFindQuery(state.tr, 'needle'))
  assert.equal(folded, text.length + 'needle'.length)
  assert.equal(richFindKey.getState(state).total, 20000)
  const move = (command) => {
    command(state, (tr) => {
      state = state.apply(tr)
    })
    const { current, total } = richFindKey.getState(state)
    return `${current}/${total}`
  }
  folded = 0
  assert.equal(move(findNext), '1/20000')
  assert.equal(move(findNext), '2/20000')
  assert.equal(move(findPrev), '1/20000')
  assert.equal(move(findPrev), '20000/20000')
  assert.equal(move(findNext), '1/20000')
  assert.equal(move(findNext), '2/20000')
  assert.equal(folded, 0, 'selection-only steps must not rescan text')
  assert.deepEqual(
    richFindKey
      .getState(state)
      .deco.find(0, 30)
      .map((deco) => [deco.from, deco.to, deco.type.attrs.class]),
    [
      [1, 7, 'ProseMirror-search-match'],
      [13, 19, 'ProseMirror-active-search-match'],
      [25, 31, 'ProseMirror-search-match'],
    ],
  )
  // Replacing the selected match rescans its one textblock.
  state = state.apply(state.tr.insertText('pin'))
  assert.equal(folded, text.length - 3)
  assert.deepEqual(
    [richFindKey.getState(state).current, richFindKey.getState(state).total],
    [0, 19999],
  )
  folded = 0
  undo(state, (tr) => {
    state = state.apply(tr)
  })
  assert.equal(folded, text.length)
  assert.equal(state.doc.textContent, text)
  assert.deepEqual(
    [richFindKey.getState(state).current, richFindKey.getState(state).total],
    [2, 20000],
  )
})

test('rich find rescans only changed textblocks in a long document', (t) => {
  let state = create(
    Array.from({ length: 2000 }, () => paragraph('needle word')),
  )
  state = state.apply(setRichFindQuery(state.tr, 'needle'))
  let folded = 0
  const lower = String.prototype.toLowerCase
  t.mock.method(String.prototype, 'toLowerCase', function () {
    folded += this.length
    return lower.call(this)
  })
  const middle = 1000 * 13 + 1
  state = state.apply(state.tr.insertText('needle ', middle))
  assert.equal(folded, 'needle needle word'.length)
  assert.equal(richFindKey.getState(state).total, 2001)
  folded = 0
  state = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, middle, middle + 6)),
  )
  assert.equal(folded, 0)
  assert.deepEqual(
    [richFindKey.getState(state).current, richFindKey.getState(state).total],
    [1001, 2001],
  )
})

test('rich find does not move from the only match', () => {
  let state = create([paragraph('one needle here')])
  state = state.apply(setRichFindQuery(state.tr, 'needle'))
  state = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, 5, 11)),
  )
  assert.equal(richFindKey.getState(state).current, 1)
  assert.equal(findNext(state), false)
  assert.equal(findPrev(state), false)
  // A selection overlapping the match neither wraps onto it.
  state = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, 7, 13)),
  )
  assert.equal(findNext(state), false)
  assert.equal(findPrev(state), false)
})

test('rich find unselects a shifted match when the selection leaves it', () => {
  let state = create([paragraph('before'), paragraph('needle and needle')])
  state = state.apply(setRichFindQuery(state.tr, 'needle'))
  state = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, 20, 26)),
  )
  assert.equal(verify(state, 'needle').length, 2)
  assert.equal(richFindKey.getState(state).current, 2)
  const tr = state.tr.insertText('x', 1)
  state = state.apply(tr.setSelection(TextSelection.create(tr.doc, 1)))
  verify(state, 'needle')
})

test('rich find matches Greek sigma in every position of a word', () => {
  let state = create([
    paragraph('ΣΣ'),
    paragraph('ΟΔΟΣ οδος οδοσ'),
    paragraph('ΣΣΣΣ'),
  ])
  for (const [query, total] of [
    ['Σ', 9],
    ['σ', 9],
    ['ς', 9],
    ['ΟΔΟΣ', 3],
    ['οδος', 3],
  ]) {
    state = state.apply(setRichFindQuery(state.tr, query))
    assert.equal(verify(state, query).length, total)
  }
  // Every occurrence is reachable in order, and both directions wrap.
  state = state.apply(setRichFindQuery(state.tr, 'Σ'))
  const expected = verify(state, 'Σ')
  for (const match of [...expected, expected[0]]) {
    assert.deepEqual(target(state, findNext), match)
    findNext(state, (tr) => {
      state = state.apply(tr)
    })
    verify(state, 'Σ')
  }
  assert.deepEqual(target(state, findPrev), expected.at(-1))
})

test('lowercasing depends on neighboring letters only for Greek final sigma', () => {
  // rich-find folds whole textblocks at once, so every other character must
  // lowercase the same in context as alone.
  for (let code = 0; code <= 0x10ffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue
    const character = String.fromCodePoint(code)
    const alone = fold(character)
    assert.equal(
      fold(`Α${character}Α${character}`),
      `α${alone}α${alone}`,
      `U+${code.toString(16)}`,
    )
  }
})

test('rich find maps lengthened lowercase characters to whole source characters', () => {
  let state = create([paragraph('İx needle İİ i')])
  state = state.apply(setRichFindQuery(state.tr, 'needle'))
  assert.deepEqual(
    richFindKey
      .getState(state)
      .deco.find()
      .map((deco) => state.doc.textBetween(deco.from, deco.to)),
    ['needle'],
  )
  state = state.apply(setRichFindQuery(state.tr, 'İ'))
  assert.deepEqual(
    richFindKey
      .getState(state)
      .deco.find()
      .map((deco) => state.doc.textBetween(deco.from, deco.to)),
    ['İ', 'İ', 'İ'],
  )
  state = state.apply(setRichFindQuery(state.tr, 'i'))
  assert.deepEqual(
    richFindKey
      .getState(state)
      .deco.find()
      .map((deco) => state.doc.textBetween(deco.from, deco.to)),
    ['İ', 'İ', 'İ', 'i'],
  )
})
