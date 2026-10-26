import assert from 'node:assert/strict'
import test from 'node:test'
import { SourceOutlineModel } from '../src/renderer/src/source-outline.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const snapshots = new WeakMap()
const finish = (work) => {
  let yields = 0
  for (;;) {
    const step = work.next()
    if (step.done) {
      if (!step.value?.headings) return { value: step.value, yields }
      let value = snapshots.get(step.value)
      if (!value) {
        value = Object.freeze(
          step.value.headings.map((heading, index) => {
            const from = step.value.position(index)
            assert.equal(step.value.at(from), heading)
            return { ...heading, id: `source:${from}`, from }
          }),
        )
        snapshots.set(step.value, value)
      }
      return { value, yields, snapshot: step.value }
    }
    assert.ok(++yields < 100_000, 'Outline work must converge.')
  }
}
const setup = (source, options = {}) => {
  const store = new SourceStore(source, { tabId: 'outline', revision: 0 })
  const model = new SourceOutlineModel(store.snapshot(), {
    gfm: true,
    frontmatter: true,
    ...options,
  })
  return { store, model }
}
const edit = (store, model, changes) => {
  const before = store.snapshot()
  const prepared = store.prepare({
    document: before.document,
    operationId: crypto.randomUUID(),
    baseVersion: before.version,
    contentVersion: before.version + 1,
    origin: 'source',
    historyGroup: 'test',
    changes,
  })
  store.commit(prepared)
  model.apply(prepared)
  return prepared
}

test('source outline hides confirmed math after frontmatter with exact CRLF source offsets', () => {
  const source =
      '---\r\nname: sample\r\n---\r\n\r\n$$\r\n# inside math\r\n$$\r\n\r\n# real\r\n',
    { store, model } = setup(source, { math: true })
  assert.deepEqual(
    finish(model.read()).value.map(({ from, label }) => ({ from, label })),
    [{ from: source.indexOf('# real'), label: 'real' }],
  )
  const from = source.indexOf('inside math')
  edit(store, model, [{ from, to: from + 11, insert: 'still hidden' }])
  assert.deepEqual(
    finish(model.read()).value.map(({ label }) => label),
    ['real'],
  )
  assert.equal(store.counters().materializations, 0)
  model.dispose()
})

test('source outline refuses ambiguous setext math instead of publishing unproven headings', () => {
  const { model } = setup('text $$x$$\n---\n\n# real', { math: true })
  assert.throws(() => finish(model.read()), /source outline is unavailable/i)
  model.dispose()
})

test('source outline covers headings beyond the viewport without materializing source', () => {
  const source = Array.from(
    { length: 1200 },
    (_, index) => `## heading ${index}\r\n\r\nbody ${index}\r\n\r\n`,
  ).join('')
  const { store, model } = setup(source)
  const { value: headings, yields } = finish(model.read())
  assert.equal(headings.length, 1200)
  assert.ok(yields > 20)
  assert.equal(headings[1199].label, 'heading 1199')
  for (let index = 0; index < headings.length; index++) {
    const from = source.indexOf(`## heading ${index}\r\n`)
    assert.equal(headings[index].from, from)
    assert.equal(headings[index].id, `source:${from}`)
  }
  assert.equal(store.counters().materializations, 0)
  assert.equal(finish(model.read()).value, headings)
  assert.ok(Object.isFrozen(headings))
  model.dispose()
})

test('source outline reuses parser fragments after a local edit', () => {
  const source = Array.from(
    { length: 1600 },
    (_, index) => `## heading ${index}\n\nbody ${index}\n\n`,
  ).join('')
  const { store, model } = setup(source)
  const original = finish(model.read()).value
  const cold = model.counters(true)
  const from = source.indexOf('heading 800')
  edit(store, model, [
    { from, to: from + 'heading 800'.length, insert: 'changed' },
  ])
  const changed = finish(model.read()).value
  const warm = model.counters()
  assert.equal(changed.length, original.length)
  assert.equal(changed[800].label, 'changed')
  assert.equal(original[800].label, 'heading 800')
  assert.ok(warm.fragmentVisits > 0)
  assert.ok(warm.readUnits < cold.readUnits / 2, JSON.stringify({ cold, warm }))
  assert.equal(store.counters().materializations, 0)
  model.dispose()
})

test('50 MiB body edits reuse unchanged heading labels and bounded index work', (t) => {
  const block = `## heading\n\n${`${'plain text body '.repeat(15)}\n`.repeat(16)}\n\n`
  const source = block
    .repeat(Math.ceil((50 * 1024 * 1024) / block.length))
    .slice(0, 50 * 1024 * 1024)
  let labels = 0
  const { store, model } = setup(source, {
    frontmatter: false,
    renderLabel: () => {
      labels++
      return 'heading'
    },
  })
  try {
    let { value: headings, snapshot } = finish(model.read())
    assert.equal(headings.length, 13548)
    model.counters(true)
    for (const insert of ['B', 'body', 'X']) {
      labels = 0
      const from = source.indexOf('body', Math.floor(source.length / 2))
      edit(store, model, [{ from, to: from + 1, insert }])
      const { value, yields, snapshot: next } = finish(model.read())
      const work = model.counters(true)
      assert.equal(labels, 0, 'body edits must not relabel unchanged headings')
      assert.ok(work.indexVisits < 100, JSON.stringify(work))
      assert.ok(yields < 200, `body edit yielded ${yields} times`)
      assert.equal(value.length, headings.length)
      assert.equal(work.published, 0)
      t.diagnostic(JSON.stringify({ insert, yields, ...work }))
      assert.equal(next.headings, snapshot.headings)
      assert.equal(value[0].from, headings[0].from)
      assert.equal(value.at(-1).from - headings.at(-1).from, insert.length - 1)
      headings = value
      snapshot = next
    }
    assert.equal(store.counters().materializations, 0)
  } finally {
    model.dispose()
  }
})

test('paragraph boundary and nested edits shift positions without replacing labels', () => {
  for (const prefix of ['', '> ', '- '])
    for (const eol of ['\n', '\r\n'])
      for (const atEnd of [false, true]) {
        const source = ['# top', '', prefix + 'body 🌿', '', '## tail'].join(
          eol,
        )
        const { store, model } = setup(source, { math: true })
        const before = finish(model.read()).snapshot
        model.counters(true)
        const from = source.indexOf('body') + (atEnd ? 'body 🌿'.length : 0)
        edit(store, model, [{ from, to: from, insert: 'more ' }])
        const after = finish(model.read()).snapshot
        const work = model.counters()
        assert.equal(
          after.headings,
          before.headings,
          JSON.stringify({ prefix, eol, atEnd, work }),
        )
        assert.equal(after.position(1), before.position(1) + 5)
        assert.equal(before.position(1), source.indexOf('## tail'))
        assert.equal(work.labelsRead, 0)
        assert.equal(work.published, 0)
        assert.ok(work.indexVisits < 30, JSON.stringify(work))
        model.dispose()
      }
})

test('source outline preserves nested heading levels and exact CRLF raw offsets', () => {
  const source = [
    '# top **bold** and *soft*',
    '',
    '> ## quoted [link](https://example.test) ![image](image.png)',
    '',
    '- ### list `code &amp;`',
    '',
    '> setext &amp; &#65;',
    '> ---',
    '',
    '1. ordered',
    '   ===',
    '',
    '#',
    '',
    '```md',
    '# fenced',
    '```',
    '',
    '    # indented',
    '',
  ].join('\r\n')
  const { model } = setup(source)
  assert.deepEqual(
    finish(model.read()).value,
    [
      ['# top', 'top bold and soft', 1],
      ['## quoted', 'quoted link image', 2],
      ['### list', 'list code &amp;', 3],
      ['setext', 'setext & A', 2],
      ['ordered', 'ordered', 1],
      ['#\r\n', 'Untitled heading', 1],
    ].map(([needle, label, level]) => {
      const from = source.indexOf(needle)
      return { id: `source:${from}`, from, label, level }
    }),
  )
  model.dispose()
})

test('body edits do not resolve unchanged heading references', (t) => {
  const source =
    Array.from(
      { length: 1000 },
      (_, i) => `## [heading ${i}][ref${i}]\n\nbody ${i}\n\n`,
    ).join('') +
    Array.from({ length: 1000 }, (_, i) => `[ref${i}]: /target/${i}\n`).join('')
  const { store, model } = setup(source, { frontmatter: false })
  const drain = () => {
    const work = model.read()
    let value,
      steps = 0,
      references = 0
    for (;;) {
      const step = work.next(value)
      steps++
      if (step.done) return { outline: step.value, steps, references }
      references += Number(!!step.value)
      value = step.value
        ? { href: `/target/${step.value.reference}` }
        : undefined
    }
  }
  try {
    const before = drain()
    assert.equal(before.outline.headings.length, 1000)
    assert.equal(before.references, 1000)
    model.counters(true)
    const from = source.indexOf('body 500')
    for (const insert of ['B', 'body', 'X']) {
      edit(store, model, [{ from, to: from + 1, insert }])
      const after = drain()
      const work = model.counters(true)
      assert.equal(after.outline.headings, before.outline.headings)
      assert.equal(
        after.references,
        0,
        'unchanged references need no worker requests',
      )
      assert.ok(after.steps < 100, JSON.stringify(after))
      assert.equal(work.labelsRead, 0)
      assert.equal(work.published, 0)
      assert.ok(work.indexVisits < 100, JSON.stringify(work))
      t.diagnostic(
        JSON.stringify({
          steps: after.steps,
          references: after.references,
          ...work,
        }),
      )
    }
  } finally {
    model.dispose()
  }
})

test('source outline treats valid frontmatter as opaque even when YAML contains fences', () => {
  const header = [
    '---',
    'title: document',
    '# metadata heading',
    'body: |',
    '  ```md',
    '  # hidden',
    '  ```',
    '  ---',
    '---',
    '',
  ].join('\r\n')
  const { store, model } = setup(`${header}# visible\r\n`)
  assert.deepEqual(finish(model.read()).value, [
    {
      id: `source:${header.length}`,
      from: header.length,
      label: 'visible',
      level: 1,
    },
  ])
  edit(store, model, [
    { from: header.length + 2, to: header.length + 9, insert: 'updated' },
  ])
  assert.equal(finish(model.read()).value[0].label, 'updated')
  // Removing the closing fence makes the prefix ordinary Markdown again.
  const closing = header.lastIndexOf('---')
  edit(store, model, [
    { from: closing, to: closing + 3, insert: 'no closing fence' },
  ])
  const exposed = finish(model.read()).value
  assert.ok(exposed.some((heading) => heading.label === 'updated'))
  assert.ok(exposed.some((heading) => heading.label === 'metadata heading'))
  model.dispose()
})

test('source outline cancels stale parser, traversal, and frontmatter work', () => {
  for (const source of [
    '# heading\n\nbody\n\n'.repeat(1500),
    `---\nbody: |\n${'  body\n'.repeat(1500)}---\n\n# heading\n`,
  ]) {
    const { store, model } = setup(source)
    const stale = model.read()
    assert.equal(stale.next().done, false)
    edit(store, model, [
      { from: source.length, to: source.length, insert: '\n# latest\n' },
    ])
    assert.throws(() => stale.next(), /stale/)
    const canceled = model.read()
    assert.equal(canceled.next().done, false)
    canceled.return()
    assert.equal(finish(model.read()).value.at(-1).label, 'latest')
    model.dispose()
    assert.throws(() => model.read().next(), /disposed/)
  }

  const { store, model } = setup('# heading\n\n'.repeat(300))
  const traversal = model.read()
  // A completed parse yields before entering traversal.
  while (!model.counters().fragments) traversal.next()
  assert.equal(traversal.next().done, false)
  edit(store, model, [{ from: 2, to: 9, insert: 'new' }])
  assert.throws(() => traversal.next(), /stale/)
  assert.equal(finish(model.read()).value[0].label, 'new')
  model.dispose()
})

test('source outline retains completed results across trusted storage compaction', () => {
  const { store, model } = setup('# first\r\n\r\n## second\r\n')
  const headings = finish(model.read()).value
  const change = finish(store.prepareCompaction()).value
  assert.ok(change)
  assert.throws(() => model.adoptStorage(change), /untrusted/)
  store.commitCompaction(change)
  model.adoptStorage(change)
  assert.deepEqual(finish(model.read()).value, headings)
  edit(store, model, [{ from: 2, to: 7, insert: 'edited' }])
  assert.equal(finish(model.read()).value[0].label, 'edited')
  model.dispose()
})

test('source outline respects disabled heading levels and container syntax', () => {
  const source =
    '# top\n\n## second\n\n> # quote\n\n- # bullet\n\n1. # ordered\n'
  const { model } = setup(source, {
    disabled: [
      'core.heading-2',
      'core.quotes',
      'core.bullet-lists',
      'core.numbered-lists',
    ],
  })
  assert.deepEqual(
    finish(model.read()).value.map((heading) => heading.label),
    ['top'],
  )
  model.dispose()
})

test('source outline bounds label lexing for huge headings and skips HTML markup', () => {
  const { model } = setup(
    `# ${'a'.repeat(20_000)}\n\n## text <em>inside</em>\n`,
  )
  const headings = finish(model.read()).value
  assert.ok(headings[0].label.length <= 512)
  assert.equal(headings[1].label, 'text inside')
  model.dispose()
})
