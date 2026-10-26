import assert from 'node:assert/strict'
import test from 'node:test'
import { settingsIndex } from '../src/ui/settings-index.ts'

const settled = () => new Promise((resolve) => setImmediate(resolve))

test('settings rows publish one index snapshot per mount batch', async () => {
  const panel = { id: 'settings-editor' }
  const row = (index) => ({ closest: () => panel, textContent: `row ${index}` })
  let notices = 0
  const stop = settingsIndex.subscribe(() => notices++)
  const removals = Array.from({ length: 2000 }, (_, index) =>
    settingsIndex.register(row(index), `row-${index}`, `Row ${index}`),
  )
  // Synchronous lookups see every row before the batched notice.
  const rows = settingsIndex.snapshot()
  assert.equal(rows.length, 2000)
  assert.deepEqual(rows[1999], {
    id: 'row-1999',
    label: 'Row 1999',
    category: 'editor',
    keywords: 'row 1999',
  })
  assert.equal(settingsIndex.snapshot(), rows)
  assert.equal(notices, 0)
  await settled()
  assert.equal(notices, 1)
  assert.equal(settingsIndex.snapshot(), rows)

  for (const remove of removals.slice(1)) remove()
  await settled()
  assert.equal(notices, 2)
  assert.deepEqual(
    settingsIndex.snapshot().map((setting) => setting.id),
    ['row-0'],
  )
  removals[0]()
  await settled()
  assert.equal(notices, 3)
  assert.deepEqual(settingsIndex.snapshot(), [])
  stop()
})
