import assert from 'node:assert/strict'
import test from 'node:test'
import {
  exportOptions,
  validateExportOptions,
} from '../src/addons/documentation/options.ts'
import {
  loadExportOptions,
  publishingOptions,
} from '../src/addons/documentation/saved-options.ts'

const theme = exportOptions().theme

test('publishing preserves protection and rejects unknown preferences without writes', async () => {
  let writes = 0
  const store = (snapshot) => ({
    snapshot: () => snapshot,
    set: async () => {
      writes++
      throw new Error('must not write while building')
    },
  })
  for (const snapshot of [
    { status: 'version-mismatch', storedVersion: 2 },
    { status: 'unavailable', reason: 'corrupt' },
    { status: 'ready', value: { passwordProtected: false } },
  ])
    await assert.rejects(
      publishingOptions(store(snapshot), null, 'notes', theme),
      /Review and save/,
    )
  const missing = store({ status: 'missing' })
  await assert.rejects(
    publishingOptions(missing, '{"passwordProtected":true}', 'notes', theme),
    /Review and save/,
  )
  await assert.rejects(
    publishingOptions(missing, null, 'notes', theme, {
      passwordProtected: false,
    }),
    /Review and save/,
  )
  const ready = (value) => store({ status: 'ready', value })
  await assert.rejects(
    publishingOptions(
      ready(exportOptions({ passwordProtected: true })),
      null,
      'notes',
      theme,
    ),
    /Turn off password protection/,
  )
  const options = await publishingOptions(
    ready(exportOptions({ title: 'Garden', homePage: 'guide.md' })),
    null,
    'notes',
    theme,
    { footer: 'Written with care.' },
  )
  assert.equal(options.title, 'Garden')
  assert.equal(options.homePage, 'guide.md')
  assert.equal(options.footer, 'Written with care.')
  assert.equal(options.singleFile, false)
  assert.equal(writes, 0)
})

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

  const damagedHost = {
    snapshot: () => ({
      status: 'ready',
      revision: 1,
      value: { ...exportOptions({}, 'workspace', theme), title: 42 },
    }),
    set: async () => {
      writes++
      throw new Error('must not replace damaged host data')
    },
  }
  const damaged = await loadExportOptions(damagedHost, null, 'workspace', theme)
  assert.equal(damaged.canSave, false)
  assert.match(damaged.warning, /stored options will not be changed/)
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

test('site layout and addon options default for earlier saves and reject invalid addons', async () => {
  const earlier = exportOptions({}, 'workspace', theme)
  for (const key of [
    'homePage',
    'footer',
    'contentWidth',
    'outline',
    'pagination',
    'addons',
  ])
    delete earlier[key]
  const store = {
    snapshot: () => ({ status: 'ready', revision: 1, value: earlier }),
    set: async () => assert.fail('should not write'),
  }
  const { initial, canSave } = await loadExportOptions(
    store,
    null,
    'workspace',
    theme,
  )
  assert.equal(canSave, true)
  assert.deepEqual(
    [
      initial.homePage,
      initial.footer,
      initial.contentWidth,
      initial.outline,
      initial.pagination,
      initial.addons,
    ],
    ['', '', 'normal', true, true, {}],
  )
  assert.deepEqual(
    validateExportOptions({ addons: { mermaid: false, math: 1 } }).addons,
    { mermaid: false },
  )
  assert.throws(
    () => validateExportOptions({ addons: { '../x': true } }),
    /valid site addons/,
  )
})
