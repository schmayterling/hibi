import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import { contribution as obsidian } from '../src/addons/markdown/formatted-obsidian.ts'
import { obsidianSyntax } from '../src/addons/markdown/formatted-syntax.ts'
import { contributions } from '../src/addons/text-extras/formatted.ts'
import {
  subscriptSyntax,
  subtextSyntax,
} from '../src/addons/text-extras/formatted-syntax.ts'

const textExtras = parser.configure([GFM, subscriptSyntax, subtextSyntax])
const obsidianMarkdown = parser.configure([GFM, obsidianSyntax])

/** Nodes whose renderers show the references in their text as characters. */
const kinds = [
  {
    label: 'subscript',
    name: 'Subscript',
    parser: textExtras,
    contribution: contributions.subscript,
    wrap: (text) => `x ~${text}~ y`,
  },
  {
    label: 'small text',
    name: 'Subtext',
    parser: textExtras,
    contribution: contributions.subtext,
    wrap: (text) => `-# ${text}`,
  },
  {
    label: 'highlight',
    name: 'Highlight',
    parser: obsidianMarkdown,
    contribution: obsidian,
    wrap: (text) => `x ==${text}== y`,
  },
  {
    label: 'wikilink alias',
    name: 'WikiLink',
    parser: obsidianMarkdown,
    contribution: obsidian,
    wrap: (text) => `x [[Note|${text}]] y`,
  },
  {
    label: 'wikilink target',
    name: 'WikiLink',
    parser: obsidianMarkdown,
    contribution: obsidian,
    // Its label is its target, which the link's data attribute holds.
    wrap: (text) => `x [[${text}]] y`,
  },
]

function find(tree, name) {
  let found = null
  tree.iterate({
    enter(ref) {
      if (found) return false
      if (ref.name === name) {
        found = ref.node
        return false
      }
    },
  })
  assert.ok(found, name)
  return found
}

// Syntax node navigation, counted only while a renderer runs.
let visits = -1
// A paragraph is a tree node; the emphasis in it is stored in a buffer.
const sample = textExtras.parse('*a*')
const treeNode = Object.getPrototypeOf(sample.topNode)
const bufferNode = Object.getPrototypeOf(sample.topNode.firstChild.firstChild)
assert.notEqual(treeNode, bufferNode)
function count(proto, keys) {
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key)
    assert.ok(descriptor, key)
    const original = descriptor.get ?? descriptor.value
    const counted = function (...args) {
      if (visits >= 0) visits++
      return original.apply(this, args)
    }
    Object.defineProperty(
      proto,
      key,
      descriptor.get
        ? { ...descriptor, get: counted }
        : { ...descriptor, value: counted },
    )
  }
}
for (const proto of [treeNode, bufferNode])
  count(proto, [
    'firstChild',
    'lastChild',
    'parent',
    'nextSibling',
    'prevSibling',
    'childAfter',
    'childBefore',
    'enter',
  ])
count(Object.getPrototypeOf(treeNode), [
  'cursor',
  'getChild',
  'getChildren',
  'resolve',
  'resolveInner',
])
count(Object.getPrototypeOf(sample.cursor()), [
  'firstChild',
  'lastChild',
  'childAfter',
  'childBefore',
  'enter',
  'parent',
  'nextSibling',
  'prevSibling',
  'next',
  'prev',
  'moveTo',
])

/**
 * Draw `node` for `visible` as the formatted view does, with the document
 * text read through the state and the syntax nodes visited.
 */
function draw(kind, node, state, visible, revealed = false) {
  const drawn = {
    glyphs: [],
    marks: [],
    other: 0,
    reads: 0,
    visits: 0,
  }
  const out = {
    mark: (from, to, attributes) => drawn.marks.push([from, to, attributes]),
    link: (from, to, attributes) => drawn.marks.push([from, to, attributes]),
    replace: (from, to, widget) =>
      drawn.glyphs.push([
        from,
        to,
        widget?.text,
        widget?.attributes ?? widget?.className,
      ]),
    syntax: () => drawn.other++,
    line: () => drawn.other++,
    widget: () => drawn.other++,
  }
  const { doc } = state
  const proto = Object.getPrototypeOf(doc)
  doc.sliceString = (from, to = doc.length, separator) => {
    drawn.reads += Math.max(0, to - from)
    return proto.sliceString.call(doc, from, to, separator)
  }
  doc.toString = () => {
    drawn.reads += doc.length
    return proto.toString.call(doc)
  }
  for (const key of ['lineAt', 'line'])
    doc[key] = (at) => {
      const line = proto[key].call(doc, at)
      return new Proxy(line, {
        get(target, name) {
          if (name === 'text') drawn.reads += target.text.length
          return Reflect.get(target, name, target)
        },
      })
    }
  visits = 0
  try {
    for (const view of kind.contribution.views)
      if (view.nodes.includes(kind.name))
        view.decorate(node, out, { state, visible, revealed })
  } finally {
    drawn.visits = visits
    visits = -1
    for (const key of ['sliceString', 'toString', 'lineAt', 'line'])
      delete doc[key]
  }
  return drawn
}

/** What a draw did, wherever its viewport is. */
const tally = ({ reads, visits, glyphs, marks, other }) => ({
  reads,
  visits,
  glyphs: glyphs.length,
  marks: marks.length,
  other,
})

test('references draw only where the viewport shows them, each whole across its ends', () => {
  // Every kind of reference, the longest that decodes, ones that do not, and
  // characters outside the basic plane, with references at both ends.
  const body = `&lt;é😀&amp;&#x1F600; &CounterClockwiseContourIntegral;&NotEqualTilde; &#9999999;&#0; &nosuch; &${'a'.repeat(40)}; &amp&gt;`
  for (const kind of kinds) {
    const source = kind.wrap(body)
    const node = find(kind.parser.parse(source), kind.name)
    const state = EditorState.create({
      doc: source,
      selection: { anchor: source.indexOf('&amp;') + 2 },
    })
    for (const revealed of [false, true]) {
      const all = { from: 0, to: source.length }
      const full = draw(kind, node, state, all, revealed)
      if (!revealed) assert.ok(full.glyphs.length >= 6, kind.label)
      for (const size of [1, 7, 40])
        for (let at = 0; at + size <= source.length; at++) {
          const visible = { from: at, to: at + size }
          const { glyphs, marks } = draw(kind, node, state, visible, revealed)
          assert.deepEqual(
            { glyphs, marks },
            {
              glyphs: full.glyphs.filter(
                ([from, to]) => from < visible.to && to > visible.from,
              ),
              marks: full.marks.flatMap(([from, to, attributes]) => {
                from = Math.max(from, visible.from)
                to = Math.min(to, visible.to)
                return from < to ? [[from, to, attributes]] : []
              }),
            },
            `${kind.label}, ${JSON.stringify({ revealed, ...visible })}`,
          )
        }
    }
  }
})

test('references read, visit and draw the same in a viewport at 2,000 and 32,000 entities and in a 50 MiB note', () => {
  const unit = '&amp; '
  const window = 64
  const large = 50 * 1024 * 1024
  for (const kind of kinds) {
    const results = []
    for (const [entities, padded] of [
      [2000, false],
      [32000, false],
      [32000, true],
    ]) {
      const cluster = unit.repeat(entities)
      // A 50 MiB note pads the node's text around the references: in code
      // spans where the text is parsed, so that the note parses quickly.
      const code = kind.parser === textExtras
      const pad = padded
        ? 'p'.repeat(Math.ceil((large - cluster.length) / 2))
        : ''
      const side = pad && (code ? `\`${pad}\` ` : pad)
      const source = kind.wrap(
        `a ${side}${cluster}${pad && (code ? ` \`${pad}\`` : pad)} b`,
      )
      if (padded) assert.ok(source.length >= large, `${source.length}`)
      const node = find(kind.parser.parse(source), kind.name)
      const start = source.indexOf(cluster)
      const from = start + unit.length * Math.floor(entities / 2) + 3
      const visible = { from, to: from + window }
      const state = EditorState.create({ doc: source })
      const first = draw(kind, node, state, visible)
      const again = draw(kind, node, state, visible)
      // Whole references across the viewport's ends, marks inside it.
      const expected = []
      for (
        let at = start + unit.length * Math.floor((from - start) / unit.length);
        at < visible.to;
        at += unit.length
      )
        if (at + 5 > visible.from) expected.push([at, at + 5])
      assert.deepEqual(
        first.glyphs.map(([from, to, text]) => [from, to, text]),
        expected.map(([from, to]) => [from, to, '&']),
        kind.label,
      )
      for (const [from, to] of first.marks)
        assert.ok(from >= visible.from && to <= visible.to, kind.label)
      results.push({ first: tally(first), again: tally(again) })
    }
    // The first draw of the node, and every later one, do the same work at
    // every size: that of the viewport and the references across its ends.
    const [small, ...rest] = results
    for (const { first, again } of rest) {
      assert.deepEqual(first, small.first, kind.label)
      assert.deepEqual(again, small.again, kind.label)
    }
    const { first } = small
    assert.ok(first.reads <= 4 * window, `${kind.label}: ${first.reads} reads`)
    assert.ok(
      first.visits <= 16 * first.glyphs + 32,
      `${kind.label}: ${first.visits} visits`,
    )
    assert.ok(first.marks <= first.glyphs + 1, kind.label)
  }
})
