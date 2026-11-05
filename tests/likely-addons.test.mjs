import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const bundled = await build({
  stdin: {
    contents: `export { createToastService } from './src/ui/toast-store.ts'
      export { LikelyAddonError, likelyAddonsNotices } from './src/renderer/src/likely-addons.ts'`,
    resolveDir: '.',
  },
  bundle: true,
  format: 'esm',
  write: false,
})
const { createToastService, LikelyAddonError, likelyAddonsNotices } =
  await import(
    `data:text/javascript,${encodeURIComponent(bundled.outputFiles[0].text)}`
  )

const named = (addon, reason = 'boom') =>
  new LikelyAddonError(addon, reason, new Error(reason))
const setup = (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // The store reads what a toast has left from this clock.
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const tick = (ms) => {
    now += ms
    t.mock.timers.tick(ms)
  }
  const service = createToastService()
  const items = () =>
    service
      .snapshot()
      .items.filter((item) => !item.closing)
      .map((item) => item.message)
  return { service, show: likelyAddonsNotices(service), items, tick }
}

test('one name reads as one likely addon, also where no toast lists it', (t) => {
  const { show, items } = setup(t)
  const error = named('a.x')
  assert.equal(error.message, 'Likely addon behind this error: a.x: boom')
  show(error)
  assert.deepEqual(items(), [error.message])
})

test('names of one error join one toast, across passes, and past the bound are counted', (t) => {
  const { show, items, tick } = setup(t)
  show(named('a.x'))
  tick(1000)
  show(named('b.x'))
  assert.deepEqual(items(), ['Likely addons behind this error: a.x, b.x: boom'])
  for (const addon of ['c.x', 'd.x', 'e.x', 'f.x', 'g.x']) show(named(addon))
  assert.deepEqual(items(), [
    'Likely addons behind this error: a.x, b.x, c.x, d.x, e.x and 2 more: boom',
  ])
})

test('another error is not called this one', (t) => {
  const { show, items } = setup(t)
  show(named('a.x'))
  show(named('b.x', 'other'))
  assert.deepEqual(items(), [
    'Likely addon behind this error: a.x: boom',
    'Likely addon behind this error: b.x: other',
  ])
})

test('a new name gets the full time, and one named again changes nothing, so repeats end', (t) => {
  const { service, show, items, tick } = setup(t)
  show(named('a.x'))
  tick(4000)
  show(named('b.x'))
  tick(4000)
  show(named('a.x'))
  show(named('b.x'))
  assert.equal(items().length, 1)
  tick(1000)
  assert.deepEqual(items(), [])
  assert.equal(service.snapshot().items.length, 1)
})

test('after its toast closes, a name starts a new list', (t) => {
  const { service, show, items, tick } = setup(t)
  show(named('a.x'))
  service.dismiss(service.snapshot().items[0].id)
  show(named('b.x'))
  assert.deepEqual(items(), ['Likely addon behind this error: b.x: boom'])
  tick(5000)
  show(named('a.x'))
  assert.deepEqual(items(), ['Likely addon behind this error: a.x: boom'])
})
