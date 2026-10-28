import assert from 'node:assert/strict'
import test from 'node:test'
import { TreeFragment } from '@lezer/common'
import { GFM, parser, Table } from '@lezer/markdown'
import {
  ChunkedMarkdownParser,
  listWindow,
  parsedChunks,
  readAhead,
  uncovered,
} from '../src/renderer/src/chunked-markdown.ts'

const base = parser.configure(GFM)

const nodes = (tree, from = 0, to = tree.length) => {
  const out = []
  tree.iterate({
    from,
    to,
    enter(node) {
      if (node.from >= from && node.to <= to)
        out.push(`${node.name}:${node.from}-${node.to}`)
    },
  })
  return out
}

/** Report the first differing node with nearby source, instead of two long lists. */
function same(actual, expected, text, label) {
  const index = actual.findIndex((entry, i) => entry !== expected[i])
  if (index < 0 && actual.length === expected.length) return
  const at = index < 0 ? Math.min(actual.length, expected.length) : index
  const range = (expected[at] ?? actual[at] ?? ':0-0')
    .split(':')[1]
    .split('-')
    .map(Number)
  assert.fail(
    `${label}: node ${at}\nactual   ${actual.slice(Math.max(0, at - 2), at + 3).join(' ')}\nexpected ${expected.slice(Math.max(0, at - 2), at + 3).join(' ')}\nsource near ${range[0]}: ${JSON.stringify(text.slice(Math.max(0, range[0] - 80), range[1] + 80))}`,
  )
}

function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const words = [
  'alpha',
  '*em*',
  '**strong**',
  '`code`',
  '[link](/url)',
  '~~gone~~',
  '<b>x</b>',
  'word',
  '\\*',
  'text',
]
const blocks = [
  (r) =>
    Array.from({ length: 1 + Math.floor(r() * 3) }, () =>
      Array.from(
        { length: 2 + Math.floor(r() * 5) },
        () => words[Math.floor(r() * words.length)],
      ).join(' '),
    ).join('\n'),
  (r) =>
    `${'#'.repeat(1 + Math.floor(r() * 6))} heading ${words[Math.floor(r() * words.length)]}`,
  (r) => `Title text\n${r() < 0.5 ? '===' : '---'}`,
  (r) =>
    Array.from(
      { length: 1 + Math.floor(r() * 4) },
      (_, i) =>
        `${r() < 0.3 && i ? '  ' : ''}- item ${i}${r() < 0.3 ? '\n\n  continued paragraph' : ''}`,
    ).join(r() < 0.5 ? '\n' : '\n\n'),
  (r) =>
    Array.from(
      { length: 1 + Math.floor(r() * 3) },
      (_, i) => `${r() < 0.5 ? i + 1 : 1}. step ${i}`,
    ).join('\n'),
  (r) => `- [ ] task\n- [x] done${r() < 0.5 ? '\n- [ ]' : ''}`,
  (r) =>
    `> quote line\n${r() < 0.5 ? 'lazy continuation\n' : ''}> > nested${r() < 0.4 ? '\n>\n> after blank' : ''}`,
  (r) =>
    `${r() < 0.5 ? '```js' : '~~~'}\nconst x = 1\n\n# not a heading\n\n- not a list\n${r() < 0.85 ? (r() < 0.5 ? '```' : '~~~') : ''}`,
  () => '    indented code\n\n    more code',
  () => '<div>\nhtml block\n</div>',
  () => '<!-- comment\n\nstill comment -->',
  () => '<script>\nlet a\n\nlet b\n</script>',
  () => '<?php\n\necho 1;\n?>',
  () => '<![CDATA[\n\nraw\n]]>',
  () => '<span>inline html</span> starting a paragraph',
  () => '| a | b |\n| --- | --- |\n| 1 | 2 |',
  (r) => ['---', '***', '- - -'][Math.floor(r() * 3)],
  () => '[ref]: /url "title"',
  () => '- \n  item after empty marker',
  () => '1) parenthesized\n2) list',
  // An open fence or raw block in a list item takes in the blank lines after it.
  (r) =>
    `- ${['```', '~~~', '<script>', '<!--'][Math.floor(r() * 4)]}${r() < 0.5 ? '\n  ' : ''}`,
]
function document(seed, count = 24) {
  const r = random(seed)
  let text = ''
  for (let i = 0; i < count; i++) {
    const block = blocks[Math.floor(r() * blocks.length)](r)
    const gap = r() < 0.15 ? '\n' : r() < 0.85 ? '\n\n' : '\n\n\n'
    text += (i ? gap : '') + block
  }
  return r() < 0.5 ? `${text}\n` : text
}

test('markdown lookahead keeps nonempty chunks beyond the active parse range', () => {
  let checks = 0
  const grammar = parser.configure({
    wrap(inner, input, _fragments, ranges) {
      const end = ranges.at(-1).to
      if (end < input.length) {
        assert.notEqual(input.chunk(end), '')
        checks++
      }
      return inner
    },
  })
  new ChunkedMarkdownParser(grammar, grammar, {
    chunkSize: 16,
    groupSize: 4,
    giantBlock: 64,
  }).parse('- item\n'.repeat(100))
  assert.ok(checks > 0)
})

const full = base
const tiny = (options = {}) =>
  new ChunkedMarkdownParser(full, base, {
    chunkSize: 16,
    groupSize: 3,
    ...options,
  })
const probe = () => ({
  parsedChunks: 0,
  parsedUnits: 0,
  scannedUnits: 0,
  reusedNodes: 0,
  builtGroups: 0,
})

test('chunked parses match whole-document lezer trees node for node', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const text = document(seed)
    same(
      nodes(tiny().parse(text)),
      nodes(full.parse(text)),
      text,
      `seed ${seed}`,
    )
  }
})

test('incremental chunked parses stay exact through random edits and reuse unchanged chunks', () => {
  const inserts = [
    'x',
    '\n',
    '\n\n',
    '```',
    '> ',
    '- ',
    '# ',
    '<!--',
    '-->',
    '    ',
    '|',
    '*',
    '\n---\n',
  ]
  let reused = 0
  for (let seed = 1; seed <= 200; seed++) {
    const r = random(seed * 7919)
    let text = document(seed, 30)
    const chunked = tiny()
    let tree = chunked.parse(text)
    for (let step = 0; step < 6; step++) {
      const from = Math.floor(r() * (text.length + 1))
      const to = Math.min(
        text.length,
        from + (r() < 0.4 ? Math.floor(r() * 12) : 0),
      )
      const insert = r() < 0.2 ? '' : inserts[Math.floor(r() * inserts.length)]
      const next = text.slice(0, from) + insert + text.slice(to)
      const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [
        { fromA: from, toA: to, fromB: from, toB: from + insert.length },
      ])
      const counts = probe()
      tree = new ChunkedMarkdownParser(full, base, {
        chunkSize: 16,
        groupSize: 3,
        probe: counts,
      }).parse(next, fragments)
      reused += counts.reusedNodes
      text = next
      same(
        nodes(tree),
        nodes(full.parse(text)),
        text,
        `seed ${seed} step ${step}: ${JSON.stringify(insert)} at ${from}-${to}`,
      )
    }
  }
  assert.ok(reused > 1000, `reused ${reused}`)
})

const finish = (parse) => {
  for (;;) {
    const tree = parse.advance()
    if (tree) return tree
  }
}
/** Parsed ranges of a chunked tree, merged. */
const parsedRanges = (tree) =>
  parsedChunks(tree).reduce((ranges, { from, chunk }) => {
    const last = ranges.at(-1)
    if (last && last.to === from) last.to = from + chunk.length
    else ranges.push({ from, to: from + chunk.length })
    return ranges
  }, [])

test('viewport parsing leaves distant chunks pending and parses them exactly when revealed', () => {
  const text = Array.from({ length: 1200 }, (_, i) =>
    document(i + 1000, 4),
  ).join('\n\n')
  const whole = nodes(full.parse(text))
  const exact = (tree, from, to) => {
    const inside = whole.filter((entry) => {
      const [a, b] = entry.split(':')[1].split('-').map(Number)
      return a >= from && b <= to
    })
    same(nodes(tree, from, to), inside, text, `${from}-${to}`)
  }
  const make = (counts) =>
    new ChunkedMarkdownParser(full, base, {
      chunkSize: 256,
      groupSize: 8,
      probe: counts,
    })
  const run = (counts, fragments, demand) =>
    finish(
      make(counts).startChunkedParse(
        {
          length: text.length,
          chunk: (from) => text.slice(from),
          read: (from, to) => text.slice(from, to),
          lineChunks: false,
        },
        fragments,
        demand,
      ),
    )
  let counts = probe()
  let tree = run(counts, [], { from: 0, to: 600 })
  assert.ok(counts.parsedUnits < 4000, JSON.stringify(counts))
  const first = parsedRanges(tree)
  assert.equal(first.length, 1)
  exact(tree, 0, first[0].to)
  assert.ok(uncovered(tree, first[0].to, text.length))
  assert.deepEqual(nodes(tree, first[0].to, text.length), [])
  // A far jump scans block structure up to the viewport and parses only around it.
  const far = Math.floor(text.length * 0.7)
  counts = probe()
  tree = run(counts, TreeFragment.addTree(tree), { from: far, to: far + 1000 })
  assert.ok(counts.parsedUnits < 6000, JSON.stringify(counts))
  assert.ok(counts.scannedUnits >= far - first[0].to, JSON.stringify(counts))
  const near = parsedRanges(tree).find((range) => range.to > far)
  assert.ok(near.from <= far && near.to >= far + 1000, JSON.stringify(near))
  exact(tree, near.from, near.to)
  assert.ok(uncovered(tree, first[0].to, near.from))
  assert.ok(!uncovered(tree, far, far + 1000))
  // Scrolling back parses the revealed pending chunks exactly.
  const back = Math.floor(text.length * 0.4)
  counts = probe()
  tree = run(counts, TreeFragment.addTree(tree), { from: back, to: back + 600 })
  assert.ok(counts.parsedUnits < 8000, JSON.stringify(counts))
  assert.ok(counts.scannedUnits < 16_000, JSON.stringify(counts))
  const revealed = parsedRanges(tree).find((range) => range.to > back)
  assert.ok(revealed.from <= back && revealed.to >= back + 600)
  exact(tree, revealed.from, revealed.to)
  // Chunks far from the viewport drop their trees, so memory follows it.
  assert.deepEqual(nodes(tree, near.from, near.to), [])
  assert.ok(uncovered(tree, near.from, near.to))
})

test('typing deep in a 50 MiB note parses one chunk per edit and rebuilds a bounded number of groups', () => {
  const unit = [
    '# Heading one\n\n',
    'Plain paragraph text with **bold words**, *emphasis*, `code`, and a [link](https://example.com/path) inside it.\n\n',
    '- list item one with *style*\n- list item two\n  - nested item\n\n',
    '> a quote line with **strong** text\n\n',
    '```js\nconst x = 1\n```\n\n',
    '1. numbered\n2. numbered two\n\n',
  ].join('')
  const size = 50 * 1024 * 1024
  let text = unit.repeat(Math.ceil(size / unit.length))
  const middle = Math.floor(text.length / 2)
  const viewport = { from: middle, to: middle + 6000 }
  const input = (value) => ({
    length: value.length,
    chunk: (from) => value.slice(from),
    read: (from, to) => value.slice(from, to),
    lineChunks: false,
  })
  const make = (counts) =>
    new ChunkedMarkdownParser(full, base, { probe: counts })
  let counts = probe()
  let tree = finish(make(counts).startChunkedParse(input(text), [], viewport))
  assert.ok(counts.parsedUnits < 32 * 1024, JSON.stringify(counts))
  const chunks = Math.ceil(text.length / 4096)
  for (let key = 0; key < 12; key++) {
    const at = middle + 3000 + key
    const next = `${text.slice(0, at)}x${text.slice(at)}`
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [
      { fromA: at, toA: at, fromB: at, toB: at + 1 },
    ])
    counts = probe()
    tree = finish(
      make(counts).startChunkedParse(input(next), fragments, viewport),
    )
    text = next
    // One edited chunk is rescanned and reparsed; nothing outside it is parsed again.
    assert.ok(counts.parsedChunks <= 2, JSON.stringify(counts))
    assert.ok(counts.parsedUnits <= 4 * 4096, JSON.stringify(counts))
    assert.ok(counts.scannedUnits <= 8 * 4096, JSON.stringify(counts))
    // Work is independent of the 50 MiB prefix: whole groups are reused.
    assert.ok(counts.builtGroups <= 3, JSON.stringify(counts))
    assert.ok(
      counts.reusedNodes <= chunks / 64 + 3 * 64,
      JSON.stringify(counts),
    )
  }
  // Compare the edited viewport with an exact parse that starts at a unit boundary.
  const start = middle - (middle % unit.length) - 20 * unit.length
  const exact = full.parse(text.slice(start, middle + 40_000))
  const shift = (entry) => {
    const [name, range] = entry.split(':')
    const [from, to] = range.split('-').map(Number)
    return `${name}:${from + start}-${to + start}`
  }
  assert.deepEqual(
    nodes(tree, middle, middle + 6000),
    nodes(exact, middle - start, middle + 6000 - start).map(shift),
  )
})

/** Run a parse to the end, recording the largest amount of text one step read. */
function steps(parse, counts) {
  let largest = 0,
    last = counts.scannedUnits + counts.parsedUnits
  for (;;) {
    const tree = parse.advance()
    const now = counts.scannedUnits + counts.parsedUnits
    largest = Math.max(largest, now - last)
    last = now
    if (tree) return { tree, largest }
  }
}
const blockNames = new Set(
  full.nodeSet.types
    .filter((type) => type.is('Block'))
    .map((type) => type.name),
)
const stringInput = (text) => ({
  length: text.length,
  chunk: (from) => text.slice(from),
  read: (from, to) => text.slice(from, to),
  lineChunks: false,
})
/** Block nodes around `pos`, innermost first. */
const chain = (tree, pos) => {
  const out = []
  for (let node = tree.resolveInner(pos, 1); node; node = node.parent)
    if (node.type.is('Block')) out.push(node.name)
  return out.join('>')
}
/** The numbers the formatted view shows for ordered list items starting in `from`-`to`. */
const numbers = (tree, text, from, to) => {
  const out = []
  tree.iterate({
    from,
    to,
    enter(ref) {
      if (ref.name !== 'ListItem' || ref.from < from || ref.from >= to) return
      const item = ref.node,
        list = item.parent
      if (list.name !== 'OrderedList') return
      const first = list.getChild('ListItem').getChild('ListMark')
      let top = list
      while (top.parent && top.parent.name !== 'Document') top = top.parent
      let index = 0
      for (
        let node = list.firstChild;
        node.from < item.from;
        node = node.nextSibling
      )
        if (node.name === 'ListItem') index++
      out.push(
        `${item.from}:${Number.parseInt(text.slice(first.from, first.to), 10) + (top.tree?.prop(listWindow)?.get(list.from - top.from) ?? 0) + index}`,
      )
    },
  })
  return out
}

test('blocks longer than a window continue from replay points with bounded steps and exact block structure', () => {
  const lines = (count, line) =>
    Array.from({ length: count }, (_, i) => line(i)).join('\n')
  const giants = {
    fence: `~~~js\n${lines(2000, (i) => `const v${i} = ${i} // *not* emphasis`)}\n~~~`,
    open: `~~~\n${lines(2000, (i) => `line ${i} # not a heading`)}`,
    indented: lines(2000, (i) => (i % 7 === 3 ? '' : `    code ${i}`)),
    script: `<script>\n${lines(2000, (i) => `let a${i} = ${i}`)}\n</script>`,
    comment: `<!-- start\n${lines(2000, (i) => (i % 5 ? `note ${i}` : ''))}\n-->`,
    paragraph: lines(2000, (i) => `words ${i} with *em* and \`code\` [l](/u)`),
    link: lines(2000, (i) => `[link ${i}](/u) and words`),
    setext: `${lines(2000, (i) => `title ${i} *x*`)}\n===`,
    table: `| a | b |\n| --- | --- |\n${lines(2000, (i) => `| ${i} | *${i}* |`)}`,
    lazy: `- an item\n${lines(2000, (i) => `lazy ${i} line`)}`,
    items: lines(
      2600,
      (i) => `${i + 1}. item ${i}${i % 9 ? '' : '\n\n   more'}`,
    ),
    quote: lines(2000, (i) => (i % 6 ? `> quoted ${i}` : '>')),
    // Blocks inside quotes and list items that opened on earlier lines.
    nestedFence: `- parent\n\n  > ~~~js\n${lines(2000, (i) => `  > const v${i} = ${i}`)}\n  > ~~~`,
    quotedSetext: `${lines(2000, (i) => `> title ${i} *x*`)}\n> ===`,
    itemSetext: `- parent\n\n${lines(2000, (i) => `  title ${i} *x*`)}\n  ---`,
    quotedItems: lines(
      2600,
      (i) => `> 1. item ${i}${i % 9 ? '' : '\n>\n>    more'}`,
    ),
    nestedItems: `1. outer\n\n${lines(2600, (i) => `   1. inner ${i}`)}`,
    blankItem: `-\n  first\n\n${lines(2000, (i) => (i % 5 ? `  para ${i}` : ''))}`,
    blankItemFence: `-\n  first\n  ~~~\n  code\n  ~~~\n\n${lines(2000, (i) => `  prose ${i} *x*`)}`,
    paragraphs: lines(4000, (i) =>
      i % 40 === 39 ? '>' : i % 80 === 38 ? '> ===' : `> words ${i}`,
    ),
  }
  const before = '# Title\n\n- a\n- b\n\nSome *intro* text.\n\n'
  const after = '\n\n## After\n\nClosing **words**.\n'
  const inserts = [
    'x',
    '\n',
    '\n\n',
    '~~~',
    '</script>',
    '-->',
    '    ',
    '|',
    '*',
    '===',
    '- ',
  ]
  const make = (counts) =>
    new ChunkedMarkdownParser(full, base, {
      chunkSize: 32,
      groupSize: 4,
      giantBlock: 512,
      probe: counts,
    })
  for (const [kind, giant] of Object.entries(giants)) {
    const r = random(kind.length * 7919)
    let text = before + giant + after
    let tree = null
    for (let step = 0; step < 24; step++) {
      // Viewports inside and around the block, then edits next to them.
      const at = Math.floor(r() * text.length)
      const demand = { from: at, to: Math.min(text.length, at + 150) }
      let fragments = []
      if (tree && step % 2) {
        const from = Math.min(text.length, at + Math.floor(r() * 150))
        const insert = inserts[Math.floor(r() * inserts.length)]
        const next = text.slice(0, from) + insert + text.slice(from)
        fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [
          { fromA: from, toA: from, fromB: from, toB: from + insert.length },
        ])
        text = next
      } else if (tree) fragments = TreeFragment.addTree(tree)
      const counts = probe()
      const result = steps(
        make(counts).startChunkedParse(stringInput(text), fragments, demand),
        counts,
      )
      tree = result.tree
      const label = `${kind} step ${step} at ${at}`
      // No step reads more than a few windows, whatever the block's length; a
      // paragraph starting with a bracket replays its first 1,000 characters.
      assert.ok(result.largest <= 4 * 512 + 4096, `${label}: ${result.largest}`)
      assert.ok(!uncovered(tree, demand.from, demand.to), label)
      const exact = full.parse(text)
      for (const pos of [
        demand.from,
        Math.floor((demand.from + demand.to) / 2),
      ])
        assert.equal(chain(tree, pos), chain(exact, pos), `${label} at ${pos}`)
      // Nodes inside the viewport match, except giant blocks' own extents,
      // code text split at window seams, and inline nodes of giant paragraphs,
      // which are parsed per window.
      const giant = []
      exact.iterate({
        from: demand.from,
        to: demand.to,
        enter: (node) => {
          if (node.type.is('Block') && node.to - node.from > 512)
            giant.push({ name: node.name, from: node.from, to: node.to })
        },
      })
      const want = nodes(exact, demand.from, demand.to).filter((entry) => {
        const [name, range] = entry.split(':')
        const [from, to] = range.split('-').map(Number)
        if (name === 'CodeText') return false
        return !giant.some(
          (node) =>
            (node.from === from && node.to === to) ||
            (/Paragraph|SetextHeading/.test(node.name) &&
              from >= node.from &&
              to <= node.to &&
              !blockNames.has(name)),
        )
      })
      const have = new Set(nodes(tree, demand.from, demand.to))
      const missing = want.filter((entry) => !have.has(entry))
      assert.deepEqual(missing, [], label)
      assert.deepEqual(
        numbers(tree, text, demand.from, demand.to),
        numbers(exact, text, demand.from, demand.to),
        label,
      )
    }
  }
})

test('a structural edit at the top of a 50 MiB note reads bounded ranges per step', () => {
  const unit = '# heading\n\nparagraph words\n\n- one\n- two\n\n> quote\n\n'
  let text = unit.repeat(Math.ceil((50 * 1024 * 1024) / unit.length))
  const make = (counts) =>
    new ChunkedMarkdownParser(full, base, { probe: counts })
  const top = { from: 0, to: 6000 }
  let counts = probe()
  let { tree } = steps(
    make(counts).startChunkedParse(stringInput(text), [], top),
    counts,
  )
  const edit = (from, to, insert, demand) => {
    const next = text.slice(0, from) + insert + text.slice(to)
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [
      { fromA: from, toA: to, fromB: from, toB: from + insert.length },
    ])
    text = next
    counts = probe()
    const result = steps(
      make(counts).startChunkedParse(stringInput(text), fragments, demand),
      counts,
    )
    tree = result.tree
    return { ...counts, largest: result.largest }
  }
  const window = 2 * 65536
  // Opening a fence: the block continues only to just past the viewport.
  const opened = edit(0, 0, '~~~\n', top)
  assert.ok(opened.largest <= window + 64, JSON.stringify(opened))
  assert.ok(opened.scannedUnits <= 4 * 65536, JSON.stringify(opened))
  assert.equal(chain(tree, 3000), 'FencedCode>Document')
  // Typing inside it rescans one window and resumes from the old frontier.
  const typed = edit(20, 20, 'x', top)
  assert.ok(typed.scannedUnits <= 16384, JSON.stringify(typed))
  // Closing it at the end of the note leaves the unscanned rest alone.
  const closed = edit(text.length, text.length, '\n~~~\n', top)
  assert.ok(closed.scannedUnits === 0, JSON.stringify(closed))
  // A far jump continues the block in bounded windows to the viewport.
  const middle = Math.floor(text.length / 2)
  counts = probe()
  const jumped = steps(
    make(counts).startChunkedParse(
      stringInput(text),
      TreeFragment.addTree(tree),
      {
        from: middle,
        to: middle + 6000,
      },
    ),
    counts,
  )
  tree = jumped.tree
  assert.ok(jumped.largest <= window + 64, JSON.stringify(jumped.largest))
  assert.equal(chain(tree, middle + 3000), 'FencedCode>Document')
  // The end of the note: the fence closes there.
  const end = text.length - 2
  counts = probe()
  tree = steps(
    make(counts).startChunkedParse(
      stringInput(text),
      TreeFragment.addTree(tree),
      {
        from: end - 6000,
        to: end,
      },
    ),
    counts,
  ).tree
  let fence = tree.resolveInner(end - 3000, 1)
  while (fence.name !== 'FencedCode') fence = fence.parent
  assert.equal(fence.lastChild.name, 'CodeMark')
  // Removing the opener restores headings at the top in a bounded parse.
  const unfenced = edit(0, 4, '', top)
  assert.ok(unfenced.largest <= window + 64, JSON.stringify(unfenced))
  assert.ok(unfenced.scannedUnits <= 64 * 1024, JSON.stringify(unfenced))
  assert.equal(chain(tree, 0), 'ATXHeading1>Document')
})

test('deleting or restoring the closing line at the end of a note reparses the lines before it', () => {
  const body = Array.from({ length: 2000 }, (_, i) => `body words ${i}`).join(
    '\n',
  )
  const cases = {
    fence: [`~~~\n${body}\n`, '~~~'],
    html: [`<script>\n${body}\n`, '</script>'],
    setext: [`${body}\n`, '==='],
  }
  const make = () =>
    new ChunkedMarkdownParser(full, base, { chunkSize: 256, giantBlock: 4096 })
  const end = (text) => ({
    from: Math.max(0, text.length - 2000),
    to: text.length,
  })
  const blocks = (tree) => {
    const out = []
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling)
      out.push(`${node.name}:${node.from}-${node.to}`)
    return out
  }
  for (const [kind, [open, closer]] of Object.entries(cases)) {
    let text = open + closer
    // A far jump to the end of the note parses the block's last window.
    let tree = finish(
      make().startChunkedParse(stringInput(text), [], end(text)),
    )
    for (const next of [open, open + closer, open]) {
      const shared = Math.min(text.length, next.length)
      const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [
        { fromA: shared, toA: text.length, fromB: shared, toB: next.length },
      ])
      text = next
      tree = finish(
        make().startChunkedParse(stringInput(text), fragments, end(text)),
      )
      const exact = full.parse(text)
      const label = `${kind} ${text.endsWith(closer) ? 'restored' : 'deleted'}`
      assert.deepEqual(blocks(tree), blocks(exact), label)
      for (const pos of [2, text.length - 1000, text.length - 2])
        assert.equal(chain(tree, pos), chain(exact, pos), `${label} at ${pos}`)
    }
  }
})

test('a giant fence in a quote in a list item continues in bounded steps', () => {
  const text = `- parent\n\n  > ~~~js\n${'  > const sample = 42\n'.repeat(50000)}  > ~~~\n\nend\n`
  const exact = full.parse(text)
  const make = (counts) =>
    new ChunkedMarkdownParser(full, base, { probe: counts })
  let tree = null
  for (const at of [0.5, 0.9, 0.2]) {
    const middle = Math.floor(text.length * at)
    const counts = probe()
    const result = steps(
      make(counts).startChunkedParse(
        stringInput(text),
        tree ? TreeFragment.addTree(tree) : [],
        { from: middle, to: middle + 6000 },
      ),
      counts,
    )
    tree = result.tree
    // Before container replay, one step read the whole 1.1 MiB block.
    assert.ok(result.largest <= 65536 + 4096, `${at}: ${result.largest}`)
    assert.ok(!uncovered(tree, middle, middle + 6000), `${at}`)
    assert.equal(chain(tree, middle + 3000), chain(exact, middle + 3000))
  }
})

test('a decision that read past an edit parses its chunk and the chunk before it again', () => {
  // `$$` opens display math only when a closing `$$` line follows within
  // 10,000 characters, as in the rich view, so the decision reads ahead.
  let input = null
  /** Where the display math opened at `start` ends, or null. */
  const closing = (start) => {
    const limit = Math.min(input.length, start + 10000)
    const close = /\n\$\$(?=\n|$)/.exec(input.read(start + 2, limit))
    readAhead(input, close ? start + 2 + close.index + 3 : limit)
    return close ? start + 2 + close.index + 3 : null
  }
  const math = parser.configure([
    GFM,
    {
      defineNodes: [{ name: 'BlockMath', block: true }],
      wrap: (inner, outer) => {
        input = outer
        return inner
      },
      parseBlock: [
        {
          name: 'BlockMath',
          before: 'FencedCode',
          // Display math interrupts a paragraph.
          endLeaf: (cx, line) =>
            line.text.slice(line.pos) === '$$' &&
            closing(cx.lineStart + line.pos) !== null,
          parse(cx, line) {
            if (line.text.slice(line.pos) !== '$$') return false
            const start = cx.lineStart + line.pos
            const end = closing(start)
            if (end === null) return false
            while (cx.lineStart + line.text.length < end && cx.nextLine()) {}
            cx.nextLine()
            cx.addElement(cx.elt('BlockMath', start, end))
            return true
          },
        },
      ],
    },
  ])
  const run = (text, fragments, options) =>
    finish(
      new ChunkedMarkdownParser(math, math, options).startChunkedParse(
        stringInput(text),
        fragments,
        { from: 0, to: 3000 },
      ),
    )
  const check = (before, at, insert, options, label) => {
    const old = run(before, [], options)
    const text = before.slice(0, at) + insert + before.slice(at)
    const tree = run(
      text,
      TreeFragment.applyChanges(TreeFragment.addTree(old), [
        { fromA: at, toA: at, fromB: at, toB: at + insert.length },
      ]),
      options,
    )
    same(nodes(tree), nodes(math.parse(text)), text, label)
  }
  // A closing line typed far below an opener makes it display math.
  const padded = `$$\nx\n\n${'padding\n\n'.repeat(600)}`
  check(padded, padded.length, '$$', {}, 'closed far below')
  // An opener that stops being math continues the paragraph before it, so
  // the chunk ending at its line is parsed again too.
  const interrupted = `${'intro words\n\n'.repeat(12)}para line\n$$\nx\n\n# heading\n\n$$\n\nend\n`
  check(
    interrupted,
    interrupted.lastIndexOf('$$') + 2,
    'z',
    { chunkSize: 4, groupSize: 3 },
    'opener reopened as text',
  )
  // After a stuck list, math opening outside it holds a heading line. The
  // search checks lines on stand-in text, where a read-ahead decision would
  // read other text, so it leaves the rest as written.
  const stuck = `${stuckBlock('-', 60)}$$\nx\n\n# inside math\n$$\n\nend\n`
  const at = stuck.indexOf('# inside math')
  const tree = finish(
    new ChunkedMarkdownParser(math, math, {
      chunkSize: 32,
      groupSize: 4,
      giantBlock: 512,
    }).startChunkedParse(stringInput(stuck), [], {
      from: at,
      to: stuck.length,
    }),
  )
  const shown = parsedChunks(tree).some((chunk) =>
    chunk.covered.some((range) => range.from <= at && at < range.to),
  )
  assert.ok(
    !shown || chain(tree, at + 2) === chain(math.parse(stuck), at + 2),
    chain(tree, at + 2),
  )
})

test('after a block that no replay can continue, formatting resumes at the next top-level block', () => {
  // A raw block known only by its fences, so a replay cannot reopen it.
  const raw = parser.configure([
    GFM,
    {
      defineNodes: [{ name: 'RawBlock', block: true }],
      parseBlock: [
        {
          name: 'RawBlock',
          before: 'FencedCode',
          parse(cx, line) {
            if (line.text.slice(line.pos) !== '%%%') return false
            const start = cx.lineStart + line.pos
            let end = cx.lineStart + line.text.length
            while (cx.nextLine()) {
              end = cx.lineStart + line.text.length
              if (line.text.slice(line.pos) === '%%%') {
                cx.nextLine()
                break
              }
            }
            cx.addElement(cx.elt('RawBlock', start, end))
            return true
          },
        },
      ],
    },
  ])
  const text = `- item\n\n  %%%\n${'  raw line\n\n'.repeat(2000)}  %%%\n\n# after\n\nend *x*\n`
  const at = text.indexOf('# after')
  const counts = probe()
  const { tree, largest } = steps(
    new ChunkedMarkdownParser(raw, raw, {
      chunkSize: 32,
      groupSize: 4,
      giantBlock: 512,
      probe: counts,
    }).startChunkedParse(stringInput(text), [], { from: at, to: text.length }),
    counts,
  )
  assert.ok(largest <= 4 * 512 + 4096, `${largest}`)
  assert.equal(chain(tree, at + 2), 'ATXHeading1>Document')
  assert.ok(!uncovered(tree, at, text.length))
  assert.deepEqual(
    nodes(tree, at, text.length),
    nodes(raw.parse(text), at, text.length),
  )
})

/** A list or quote whose paragraph no replay can reopen: its first line also opens a fence. */
const stuckBlock = (container, lines) => {
  const pad = container === '>' ? '> ' : ' '.repeat(container.length + 1)
  return `${container} > ~~~\n${pad}> code\n${pad}> ~~~\n${pad}>\n${`${pad}> quoted words *em*\n`.repeat(lines)}`
}

test('after a stuck block, formatting resumes only at a line that starts a top-level block in every reading', () => {
  // A one-space fence after the list holds the rest of the note.
  const text = `${stuckBlock('-', 5000)}\n ~~~\nraw code\n\n# inside\n\nstill code\n`
  const at = text.indexOf('# inside')
  const counts = probe()
  const { tree } = steps(
    new ChunkedMarkdownParser(full, base, { probe: counts }).startChunkedParse(
      stringInput(text),
      [],
      { from: at, to: text.length },
    ),
    counts,
  )
  assert.equal(chain(tree, at + 2), chain(full.parse(text), at + 2))
  // Lines after a stuck block show as written or as the whole note parses.
  const lines = [
    ...['', '', '', ' ~~~', '~~~', '  ~~~', '   ```', '```js', '  > ~~~'],
    ...['<!--', '-->', '<script>', '</script>', '<div>', '# inside', '---'],
    ...['text *em*', '  text', '   text', '    code', '\ttab', '==='],
    ...['> quote', '  > quote', '> > q', '- item', '  - item', '+ plus'],
    ...['1. one', '2. two', '2) two', '* star'],
  ]
  // Blank lines in crlf text hold a carriage return, which html blocks do not end at.
  for (const [container, eol] of ['-', '1.', '>'].flatMap((container) => [
    [container, '\n'],
    [container, '\r\n'],
  ])) {
    let resumed = 0
    for (let seed = 1; seed <= 300; seed++) {
      const r = random(seed)
      const prefix = stuckBlock(container, 60).replaceAll('\n', eol)
      const text = `${prefix}${Array.from({ length: 24 }, () => lines[Math.floor(r() * lines.length)]).join(eol)}${eol}`
      const exact = full.parse(text)
      const counts = probe()
      const { tree } = steps(
        tiny({
          chunkSize: 32,
          groupSize: 4,
          giantBlock: 512,
          probe: counts,
        }).startChunkedParse(stringInput(text), [], {
          from: prefix.length,
          to: text.length,
        }),
        counts,
      )
      const covered = parsedChunks(tree).flatMap((chunk) => chunk.covered)
      let shown = false
      for (
        let pos = prefix.length;
        pos < text.length;
        pos = text.indexOf('\n', pos) + 1
      ) {
        if (!covered.some((range) => range.from <= pos && pos < range.to))
          continue
        shown = true
        assert.equal(
          chain(tree, pos),
          chain(exact, pos),
          `${JSON.stringify(container + eol)} seed ${seed} at ${pos}: ${JSON.stringify(text.slice(prefix.length))}`,
        )
      }
      if (shown) resumed++
    }
    // Most notes still format the text after the stuck block.
    assert.ok(resumed > 150, `${JSON.stringify(container + eol)}: ${resumed}`)
  }
})

test('the search after a stuck block reads a long line once, in bounded steps, and counts its reads', () => {
  const text = `${stuckBlock('-', 60)}  > ${'x'.repeat(65536)}\n\n# after\n`
  const at = text.indexOf('# after')
  let reads = 0
  const input = {
    ...stringInput(text),
    read: (from, to) => {
      reads += to - from
      return text.slice(from, to)
    },
  }
  const counts = probe()
  const parse = tiny({
    chunkSize: 32,
    groupSize: 4,
    giantBlock: 512,
    probe: counts,
  }).startChunkedParse(input, [], { from: at, to: text.length })
  let tree = null,
    advances = 0,
    largest = 0
  // Before, a window ending inside the line moved the search one unit a step.
  for (; !tree && advances < 1000; advances++) {
    const before = reads
    tree = parse.advance()
    largest = Math.max(largest, reads - before)
  }
  assert.ok(tree, `unfinished after ${advances} steps`)
  assert.ok(reads < 2 * text.length, `${reads}`)
  assert.ok(largest <= 16 * 512, `${largest}`)
  // The work counters include the search's reads.
  assert.ok(counts.scannedUnits >= 65536, `${counts.scannedUnits}`)
  assert.equal(chain(tree, at + 2), 'ATXHeading1>Document')
})

test('a giant window evicted by a far viewport keeps the read-ahead reach of its decisions', () => {
  // Tables here form only when the note says ENABLE at its end, so every
  // table decision reads the whole note.
  let input = null
  const original = Table.parseBlock[0]
  const enabled = () => {
    readAhead(input, input.length)
    return input.read(0, input.length).includes('ENABLE')
  }
  const conditional = parser.configure({
    ...Table,
    wrap(inner, outer) {
      input = outer
      return inner
    },
    parseBlock: [
      {
        ...original,
        name: 'ConditionalTable',
        leaf: (cx, leaf) =>
          leaf.content.includes('|') && enabled()
            ? original.leaf(cx, leaf)
            : null,
        endLeaf: (cx, line, leaf) =>
          line.text.includes('|') &&
          enabled() &&
          original.endLeaf(cx, line, leaf),
      },
    ],
  })
  const run = (text, fragments, demand) => {
    const parse = new ChunkedMarkdownParser(conditional, conditional, {
      chunkSize: 64,
      giantBlock: 512,
      groupSize: 4,
      opaque: new Set(['Table']),
    }).startChunkedParse(stringInput(text), fragments, demand)
    for (;;) {
      const tree = parse.advance()
      if (tree) return tree
    }
  }
  // Top-level blocks starting in the viewport near the table.
  const top = (tree) => {
    const out = []
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling)
      if (node.from < 2000) out.push(`${node.name}:${node.from}-${node.to}`)
    return out
  }
  const text = `${'intro text '.repeat(40)}\n| a | b |\n| - | - |\n${Array.from({ length: 500 }, (_, i) => `| ${i} | cell |`).join('\n')}\n\n${'padding\n\n'.repeat(1000)}ENABLE\n`
  const first = run(text, [], { from: 0, to: text.length })
  // Scroll to the end, edit there, and scroll back to the table.
  const away = run(text, TreeFragment.addTree(first), {
    from: text.length - 200,
    to: text.length,
  })
  const at = text.indexOf('ENABLE')
  const edited = `${text.slice(0, at)}DISABLE${text.slice(at + 6)}`
  const changed = run(
    edited,
    TreeFragment.applyChanges(TreeFragment.addTree(away), [
      { fromA: at, toA: at + 6, fromB: at, toB: at + 7 },
    ]),
    { from: edited.length - 200, to: edited.length },
  )
  const back = run(edited, TreeFragment.addTree(changed), { from: 0, to: 2000 })
  // Before, the evicted window lost its reach and kept the stale table.
  assert.deepEqual(top(back), top(conditional.parse(edited)))
})

test('parsed chunks found by position are the parsed chunks touching that range', () => {
  const text = Array.from({ length: 3000 }, (_, i) =>
    i % 7 ? `paragraph ${i} with *style*` : `- item ${i}\n- next`,
  ).join('\n\n')
  const parse = tiny({ chunkSize: 64, groupSize: 4 }).startChunkedParse(
    stringInput(text),
    [],
    null,
  )
  let tree = null
  while (!tree) tree = parse.advance()
  const all = parsedChunks(tree)
  // A lookup reads the chunks near its range, not every group and chunk:
  // the formatted view does one for each selection move.
  const proto = Object.getPrototypeOf(tree)
  const prop = proto.prop
  let reads = 0
  proto.prop = function (...args) {
    reads++
    return prop.apply(this, args)
  }
  try {
    parsedChunks(tree, { from: text.length >> 1, to: (text.length >> 1) + 10 })
  } finally {
    proto.prop = prop
  }
  assert.ok(all.length > 500 && reads < 40, `${all.length} ${reads}`)
  const r = random(7)
  for (let i = 0; i < 200; i++) {
    const from = Math.floor(r() * text.length),
      to = Math.min(text.length, from + Math.floor(r() * 400))
    const expected = all
      .filter(({ from: at, chunk }) => at <= to && at + chunk.length >= from)
      .map(({ from: at }) => at)
    assert.deepEqual(
      parsedChunks(tree, { from, to }).map(({ from: at }) => at),
      expected,
      `${from}-${to}`,
    )
  }
})
