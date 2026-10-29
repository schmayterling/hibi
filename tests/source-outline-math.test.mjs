import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { SourceOutlineModel } from '../src/renderer/src/source-outline.ts'
import { createOutlineLabelRenderer } from '../src/renderer/src/source-outline-label.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const fixture = readFileSync(
  new URL('./fixtures/outline-math.md', import.meta.url),
  'utf8',
)

function outline(source) {
  const store = new SourceStore(source, { tabId: 'outline-math', revision: 0 })
  const model = new SourceOutlineModel(store.snapshot(), {
    gfm: true,
    frontmatter: true,
    alerts: true,
    math: true,
    renderLabel: createOutlineLabelRenderer(['markdown.github', 'math.latex']),
  })
  try {
    const work = model.read()
    for (let i = 0; i < 100_000; i++) {
      const step = work.next(null)
      if (step.done) return step.value
    }
    assert.fail('Outline work must converge.')
  } finally {
    model.dispose()
  }
}

test('source outline reads synthetic course math in paragraphs, headings and containers', () => {
  for (const source of [fixture, fixture.replaceAll('\n', '\r\n')]) {
    const result = outline(source)
    assert.deepEqual(
      result.headings.map(({ label, level }) => [label, level]),
      [
        ['Course x', 1],
        ['Formula f(x)', 2],
        ['Callout a', 3],
        ['List b', 3],
        ['Nested c', 4],
        ['Setext g(x)', 2],
        ['End', 2],
      ],
    )
    assert.deepEqual(result.headings[1].parts, ['Formula ', { latex: 'f(x)' }])
    for (let index = 0; index < result.headings.length; index++) {
      const at = result.position(index)
      assert.equal(result.at(at), result.headings[index])
      assert.match(source.slice(at), /^(?:#{1,4} |Setext )/)
    }
  }
})

test('source outline leaves incomplete and oversized math as ordinary Markdown', () => {
  for (const body of [
    'before $$ math',
    `$$${'x'.repeat(20_000)}`,
    `$$x$$${' '.repeat(20_000)}`,
  ]) {
    assert.deepEqual(
      outline(`${body}\n\n# real`).headings.map(({ label }) => label),
      ['real'],
    )
  }
  assert.deepEqual(
    outline('text $$x$$\n---\n\n# real').headings.map(({ label }) => label),
    ['text x', 'real'],
  )
})

test('source outline contains math at quote and list boundaries', () => {
  for (const source of [
    '> $$\n> # hidden\n> $$\n\n# real',
    '- $$\n  # hidden\n  $$\n\n# real',
    '1. $$\n   # hidden\n   $$\n\n# real',
    '> - $$\n>   # hidden\n>   $$\n\n# real',
    '- > $$\n  > # hidden\n  > $$\n\n# real',
  ])
    assert.deepEqual(
      outline(source).headings.map(({ label }) => label),
      ['real'],
    )
  // A closing delimiter outside the container cannot swallow its next heading.
  assert.deepEqual(
    outline('> $$\n# visible\n$$\n\n# real').headings.map(({ label }) => label),
    ['visible', 'real'],
  )
})
