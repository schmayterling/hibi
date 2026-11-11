import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import { countText } from '../src/addons/word-count/count.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { SourceOutlineModel } from '../src/renderer/src/source-outline.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import { RenderedTextIndex } from '../src/shared/rendered-text.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { SourceSearchIndex } from '../src/shared/source-search-index.ts'
import { renderedConfig } from './rendered-config.mjs'

for (const marker of ['1.', '2)', '123.'])
  for (const checked of ['x', 'X', ' '])
    for (const gap of [' ', '   ', '\t'])
      test(`ordered task ${JSON.stringify([marker, checked, gap])} projects checkbox as no text`, () => {
        const source = `${marker} [${checked}]${gap}done`
        const html = new Marked().parse(source)
        assert.match(html, /type="checkbox"/)
        assert.equal(countText(richText(source, defaultNoteSyntax)).words, 1)
        assert.ok(!richText(source, defaultNoteSyntax).includes(`[${checked}]`))
        const store = new SourceStore(source, {
          tabId: 'ordered-task',
          revision: 0,
        })
        const index = new RenderedTextIndex(store.snapshot(), 0, renderedConfig)
        for (const _ of index.build()) {
        }
        const rendered = [...index.range(0, source.length)]
          .map((run) => run.text ?? index.text(run.from, run.to))
          .join('')
        assert.equal(rendered, 'done')
        for (const [query, expected] of [
          ['done', 1],
          [`[${checked}]`, 0],
        ]) {
          const find = new SourceSearchIndex(store.snapshot(), query, {}, index)
          for (const _ of find.build()) {
          }
          assert.equal(find.state().total, expected)
        }
      })

test('ordered task headings stay in outline without becoming marker text', () => {
  const source = '1. [x] done\n\n   # inside\n\n# outside'
  const store = new SourceStore(source, { tabId: 'task-outline', revision: 0 })
  const model = new SourceOutlineModel(store.snapshot(), { gfm: true })
  const work = model.read()
  let step
  do step = work.next(null)
  while (!step.done)
  assert.deepEqual(
    step.value.headings.map((heading) => heading.label),
    ['inside', 'outside'],
  )
})

test('ordered task projections preserve nested blocks and disabled task markers', () => {
  const source = '1. [x] done\n\n   next\n\n   - nested\n2. [ ] todo'
  assert.equal(countText(richText(source, defaultNoteSyntax)).words, 4)
  for (const syntax of [
    { ...defaultNoteSyntax, gfm: false },
    { ...defaultNoteSyntax, disabledFeatures: ['markdown.tasks'] },
  ])
    assert.ok(richText('1. [x] done', syntax).includes('[x]'))
})
