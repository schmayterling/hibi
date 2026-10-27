import assert from 'node:assert/strict'
import test from 'node:test'
import { readFrontmatter } from '../src/shared/frontmatter.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import {
  readSourceFrontmatter,
  reuseFrontmatterRead,
} from '../src/shared/source-frontmatter.ts'

const scan = (source) => {
  const work = readSourceFrontmatter(source)
  let yields = 0
  for (;;) {
    const next = work.next()
    if (next.done) return { ...next.value, yields }
    yields++
  }
}
const expected = (text) => {
  const block = readFrontmatter(text)
  if (!block) return null
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(
    text.slice(block.opening.length),
  )
  return {
    yamlFrom: block.opening.length,
    yamlTo: block.opening.length + block.yaml.length,
    headerTo: block.opening.length + closing.index + closing[0].length,
    contentFrom: block.prefix.length,
    eol: block.eol,
  }
}
const compare = (text, chunkUnits = 7) => {
  const store = new SourceStore(
    text,
    { tabId: 'frontmatter', revision: 0 },
    0,
    { chunkUnits },
  )
  const result = scan(store.snapshot())
  assert.deepEqual(
    result.bounds,
    expected(text),
    JSON.stringify(text.slice(0, 200)),
  )
  return { store, result }
}

test('source frontmatter matches existing mapping, delimiter and spacing behavior across chunk seams', () => {
  for (const bom of ['', '\uFEFF'])
    for (const eol of ['\n', '\r\n'])
      for (const yaml of [
        'title: hello',
        '{}',
        'a: [broken',
        'scalar',
        '[one, two]',
        '',
        'a: 1\n---x\nb: 2',
      ])
        for (const close of ['---', '...', '--- \t', '----', '..'])
          for (const end of [
            '',
            '\n',
            '\r\n',
            '\rbody',
            '\u2028body',
            '\u2029body',
          ])
            compare(
              `${bom}--- \t${eol}${yaml}${eol}${close}${end}\n \t\n# body`,
            )
  for (const text of [
    '',
    '-',
    '--',
    '---',
    '---\r',
    '---\n',
    'text',
    '\uFEFF---\n{}\n---',
    '---\na: 1\r---\rbody',
    '---\na: 1\u2028---\nbody',
    '---\na: 1\n---\n\rbody',
  ])
    compare(text, 4)
})

test('prefix inspection does not read or materialize the whole body', () => {
  const text = '---\ntitle: one\n---\n\n# body\n' + 'paragraph\n'.repeat(100000)
  const { store, result } = compare(text, 4096)
  assert.equal(result.yields, 0)
  assert.equal(result.dependsOnEnd, false)
  assert.equal(result.inspectedTo, result.bounds.contentFrom + 1)
  assert.equal(store.counters().materializations, 0)
  assert.ok(store.counters().sourceUnitsRead < 4200)
  assert.equal(
    reuseFrontmatterRead(result, [
      { from: text.length, to: text.length, insert: 'tail' },
    ]),
    true,
  )
  assert.equal(
    reuseFrontmatterRead(result, [
      {
        from: result.bounds.contentFrom,
        to: result.bounds.contentFrom,
        insert: '\n',
      },
    ]),
    false,
  )
})

test('EOF-sensitive prefixes invalidate on append and closed decisions reuse after their read set', () => {
  for (const text of [
    '---',
    '---\na: 1',
    '---\na: 1\n---',
    '---\na: 1\n---\n  ',
  ]) {
    const { result } = compare(text)
    assert.equal(result.dependsOnEnd, true)
    assert.equal(
      reuseFrontmatterRead(result, [
        { from: text.length, to: text.length, insert: '\n' },
      ]),
      false,
    )
  }
  for (const text of [
    'x',
    '---x',
    '---\nscalar\n---\nbody',
    '---\na: 1\n---\nbody',
  ]) {
    const { result } = compare(text)
    assert.equal(
      reuseFrontmatterRead(result, [
        { from: result.inspectedTo, to: result.inspectedTo, insert: 'tail' },
      ]),
      true,
    )
    assert.equal(
      reuseFrontmatterRead(result, [
        {
          from: result.inspectedTo - 1,
          to: result.inspectedTo,
          insert: 'tail',
        },
      ]),
      false,
    )
  }
})

test('only a complete scan without a closing marker proves frontmatter unclosed', () => {
  for (const text of ['---\n', '---\nkey: value']) {
    const { result } = compare(text)
    assert.equal(result.unclosed, true)
    assert.equal(result.dependsOnEnd, true)
  }
  for (const text of ['---', '---\nscalar\n---', '---\nkey: value\n---']) {
    const { result } = compare(text)
    assert.equal(result.unclosed, false)
    assert.equal(result.dependsOnEnd, true)
  }
})

test('large candidate scans yield and can release unfinished input', () => {
  const { result } = compare('---\n' + 'a'.repeat(100000), 4096)
  assert.equal(result.bounds, null)
  assert.ok(result.yields >= 24)
  const { result: spacing } = compare(
    '---\na: 1\n---\n' + ' '.repeat(100000),
    4096,
  )
  assert.ok(spacing.yields >= 24)
  const store = new SourceStore('---\n' + 'x'.repeat(100000), {
    tabId: 'cancel',
    revision: 0,
  })
  const work = readSourceFrontmatter(store.snapshot())
  assert.equal(work.next().done, false)
  assert.equal(work.return().done, true)
  assert.equal(work.next().done, true)
})
