import assert from 'node:assert/strict'
import test from 'node:test'
import { preparePages } from '../src/addons/documentation/prepare.ts'

const pages = Array.from({ length: 100 }, (_, i) => ({
  path: `${i}.md`,
  markdown: `# Page ${i}`,
}))

test('dismissing export stops preparation before the next page', async () => {
  const controller = new AbortController()
  let renders = 0,
    staged = 0
  await assert.rejects(
    preparePages(
      pages,
      async () => {
        renders++
        controller.abort()
        return { html: '<h1>page</h1>', css: '' }
      },
      async () => {
        staged++
      },
      controller.signal,
    ),
    { name: 'AbortError' },
  )
  assert.equal(renders, 1)
  assert.equal(staged, 0)
})

test('warm export promises yield real task turns between pages', async () => {
  let turns = 0,
    rendered = 0
  const tick = () => {
    turns++
    if (rendered < pages.length) setImmediate(tick)
  }
  setImmediate(tick)
  const css = await preparePages(
    pages,
    async () => {
      rendered++
      return { html: '<h1>page</h1>', css: 'h1{}' }
    },
    async () => {},
  )
  assert.ok(turns >= pages.length - 1, `${turns} turns for ${rendered} pages`)
  assert.equal(css, 'h1{}')
})
