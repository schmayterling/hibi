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

test('renderer prepares the next page during staging with at most two pages retained', {
  timeout: 5000,
}, async (t) => {
  let release, secondRendered
  const held = new Promise((resolve) => {
    release = resolve
  })
  t.after(() => release())
  const ready = new Promise((resolve) => {
    secondRendered = resolve
  })
  let rendered = 0,
    staged = 0,
    peak = 0
  const running = preparePages(
    pages.slice(0, 4),
    async () => {
      rendered++
      peak = Math.max(peak, rendered - staged)
      if (rendered === 2) secondRendered()
      return { html: '<h1>page</h1>', css: '' }
    },
    async () => {
      if (!staged) await held
      staged++
    },
  )
  try {
    await Promise.race([ready, running.then(() => assert.fail('no overlap'))])
    assert.equal(rendered, 2)
    assert.equal(staged, 0)
  } finally {
    release()
    await running
  }
  assert.equal(staged, 4)
  assert.equal(peak, 2)
})
