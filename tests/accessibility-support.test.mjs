import assert from 'node:assert/strict'
import test from 'node:test'
import { followAccessibilitySupport } from '../src/main/accessibility-support.ts'

test('a shown window publishes screen reader changes Electron does not report, once, and stops reading while hidden', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let enabled = false
  let shown = true
  let reads = 0
  const published = []
  const follow = followAccessibilitySupport(
    () => {
      reads++
      return enabled
    },
    () => shown,
    (value) => published.push(value),
  )

  // The renderer's snapshot sets the baseline and starts reading again.
  assert.equal(follow(), false)
  t.mock.timers.tick(2000 * 5)
  assert.equal(reads, 6)
  assert.deepEqual(published, [])

  // A screen reader starts with no event.
  enabled = true
  t.mock.timers.tick(2000)
  t.mock.timers.tick(2000 * 5)
  assert.deepEqual(published, [true])

  // An event or focus without a change publishes nothing.
  assert.equal(follow(), true)
  assert.deepEqual(published, [true])

  // Hidden, the next read stops the interval.
  shown = false
  t.mock.timers.tick(2000)
  const hidden = reads
  enabled = false
  t.mock.timers.tick(2000 * 50)
  assert.equal(reads, hidden)
  assert.deepEqual(published, [true])

  // Showing it reads the change at once and follows again.
  shown = true
  assert.equal(follow(), false)
  assert.deepEqual(published, [true, false])
  enabled = true
  t.mock.timers.tick(2000)
  assert.deepEqual(published, [true, false, true])

  // Repeated wakes keep one interval.
  follow()
  follow()
  const before = reads
  t.mock.timers.tick(2000)
  assert.equal(reads, before + 1)
})
