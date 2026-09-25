import assert from 'node:assert/strict'
import test from 'node:test'
import { exportOptions } from '../src/addons/documentation/options.ts'
import { loadExportOptions } from '../src/addons/documentation/saved-options.ts'

const theme = exportOptions().theme

test('valid legacy export options wait for durable migration and retain source text', async () => {
  const legacy = JSON.stringify(
    exportOptions({ title: 'old title' }, 'workspace', theme),
  )
  let acknowledge
  let written
  const store = {
    snapshot: () => ({ status: 'missing', revision: 0 }),
    set: (value) => {
      written = value
      return new Promise((resolve) => {
        acknowledge = () => resolve({ status: 'saved', revision: 1, value })
      })
    },
  }
  const pending = loadExportOptions(store, legacy, 'workspace', theme)
  let completed = false
  void pending.then(() => {
    completed = true
  })
  await Promise.resolve()
  assert.equal(completed, false)
  assert.equal(written.title, 'old title')
  acknowledge()
  const loaded = await pending
  assert.equal(loaded.initial.title, 'old title')
  assert.equal(loaded.warning, null)
  assert.equal(loaded.canSave, true)
  assert.equal(JSON.parse(legacy).title, 'old title')
})

test('corrupt legacy and newer stored options remain recoverable', async () => {
  let writes = 0
  const missing = {
    snapshot: () => ({ status: 'missing', revision: 0 }),
    set: async () => {
      writes++
      throw new Error('must not migrate corrupt input')
    },
  }
  const corrupt = await loadExportOptions(missing, '{bad', 'workspace', theme)
  assert.equal(corrupt.initial.title, 'workspace')
  assert.match(corrupt.warning, /original copy remains untouched/)
  assert.equal(corrupt.canSave, true)
  const invalidShape = await loadExportOptions(
    missing,
    'null',
    'workspace',
    theme,
  )
  assert.match(invalidShape.warning, /original copy remains untouched/)
  assert.equal(writes, 0)

  const newer = {
    snapshot: () => ({
      status: 'version-mismatch',
      revision: 2,
      storedVersion: 2,
      value: { title: 'newer' },
    }),
    set: async () => {
      writes++
      throw new Error('must not overwrite newer schema')
    },
  }
  const safe = await loadExportOptions(newer, null, 'workspace', theme)
  assert.equal(safe.initial.title, 'workspace')
  assert.equal(safe.canSave, false)
  assert.match(safe.warning, /different version/)
  assert.equal(writes, 0)
})

test('host value wins over legacy text and concurrent migration conflict', async () => {
  const saved = exportOptions({ title: 'host title' }, 'workspace', theme)
  let writes = 0
  const ready = {
    snapshot: () => ({ status: 'ready', revision: 3, value: saved }),
    set: async () => {
      writes++
      throw new Error('must not migrate over host')
    },
  }
  const initial = await loadExportOptions(ready, '{bad', 'workspace', theme)
  assert.equal(initial.initial.title, 'host title')
  assert.equal(initial.warning, null)
  const conflict = {
    snapshot: () => ({ status: 'missing', revision: 0 }),
    set: async () => ({
      status: 'conflict',
      current: { status: 'ready', revision: 1, value: saved },
    }),
  }
  const migrated = await loadExportOptions(
    conflict,
    JSON.stringify(saved),
    'workspace',
    theme,
  )
  assert.equal(migrated.initial.title, 'host title')
  assert.equal(writes, 0)
})
