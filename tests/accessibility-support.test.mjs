import assert from 'node:assert/strict'
import test from 'node:test'
import { followAccessibilitySupport } from '../src/main/accessibility-support.ts'

test('a window publishes screen reader changes Electron does not report, once, until it closes', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let enabled = false
  let reads = 0
  const published = []
  const accessibility = followAccessibilitySupport(
    () => {
      reads++
      return enabled
    },
    (value) => published.push(value),
  )

  // The window starts reading; the renderer's snapshot sets the baseline.
  accessibility.start()
  assert.equal(accessibility.sample(), false)
  t.mock.timers.tick(2000 * 5)
  assert.equal(reads, 6)
  assert.deepEqual(published, [])

  // A screen reader starts with no event.
  enabled = true
  t.mock.timers.tick(2000)
  t.mock.timers.tick(2000 * 5)
  assert.deepEqual(published, [true])

  // An event, show or focus without a change publishes nothing.
  assert.equal(accessibility.sample(), true)
  assert.deepEqual(published, [true])

  // Repeated starts keep one interval.
  accessibility.start()
  accessibility.start()
  let before = reads
  t.mock.timers.tick(2000)
  assert.equal(reads, before + 1)

  // Closing the window stops reading.
  accessibility.stop()
  before = reads
  enabled = false
  t.mock.timers.tick(2000 * 50)
  assert.equal(reads, before)
  assert.deepEqual(published, [true])

  // A new window publishes the change it missed on its first read, and
  // follows again.
  accessibility.start()
  t.mock.timers.tick(2000)
  assert.deepEqual(published, [true, false])
  enabled = true
  t.mock.timers.tick(2000)
  assert.deepEqual(published, [true, false, true])
})
