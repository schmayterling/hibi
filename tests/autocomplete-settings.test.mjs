import assert from 'node:assert/strict'
import test from 'node:test'

let serial = 0
const preferences = async (data) => {
  const values = new Map(
    Object.entries(data).map(([key, value]) => [key, JSON.stringify(value)]),
  )
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
  return import(`../src/addons/autocomplete/settings.ts?test=${serial++}`)
}
test('autocomplete inherits existing language and Tab preferences and respects its own updates', async () => {
  const settings = await preferences({
    'hibi:dictionary': { latin: 'fr' },
    'hibi:dictionary:typing': {
      suggest: false,
      tabAccepts: false,
      languages: ['tl', 'ja', 'fr', 'tl', 'en', 7],
    },
  })
  await settings.migrateDictionaryTyping(async () => {
    assert.fail('disabled suggestions must not enable autocomplete')
  })
  const initial = settings.readPreferences()
  assert.equal(initial.suggest, false)
  assert.equal(initial.tabAccepts, false)
  assert.deepEqual(initial.languages, ['tl', 'fr', 'en'])
  assert.equal(localStorage.getItem('hibi:dictionary:typing'), null)
  assert.deepEqual(
    JSON.parse(localStorage.getItem('hibi:autocomplete')),
    initial,
  )
  let changes = 0
  const stop = settings.onPreferencesChange(() => changes++)
  const next = {
    ...initial,
    suggest: true,
    learning: false,
    excludedDocuments: ['document'],
    excludedWorkspaces: ['workspace'],
  }
  settings.writePreferences(next)
  assert.equal(settings.readPreferences(), next)
  assert.equal(changes, 1)
  stop()
  settings.writePreferences(next)
  assert.equal(changes, 1)
})
test('privacy preferences reload across windows and after resubscribing', async (t) => {
  const settings = await preferences({})
  const events = new EventTarget()
  globalThis.window = events
  t.after(() => {
    delete globalThis.window
  })
  const initial = settings.readPreferences()
  let changes = 0
  const stop = settings.onPreferencesChange(() => changes++)
  const next = { ...initial, learning: false, excludedWorkspaces: ['private'] }
  localStorage.setItem('hibi:autocomplete', JSON.stringify(next))
  const notify = (key, storageArea = localStorage) =>
    events.dispatchEvent(
      Object.assign(new Event('storage'), { key, storageArea }),
    )
  notify('unrelated')
  notify('hibi:autocomplete', {})
  assert.equal(changes, 0)
  notify('hibi:autocomplete')
  assert.equal(changes, 1)
  assert.deepEqual(settings.readPreferences(), next)
  stop()
  localStorage.setItem(
    'hibi:autocomplete',
    JSON.stringify({ ...next, suggest: false }),
  )
  notify('hibi:autocomplete')
  assert.equal(changes, 1)
  const again = settings.onPreferencesChange(() => changes++)
  assert.equal(settings.readPreferences().suggest, false)
  notify(null)
  assert.equal(changes, 2)
  again()
})

test('all 600 document and workspace exclusions survive reload, additions and removals', async () => {
  const documents = Array.from({ length: 600 }, (_, i) => `document-${i}`)
  const workspaces = Array.from({ length: 600 }, (_, i) => `workspace-${i}`)
  const settings = await preferences({})
  settings.writePreferences({
    ...settings.readPreferences(),
    excludedDocuments: [...documents, documents[0], documents.at(-1)],
    excludedWorkspaces: [...workspaces, workspaces[0], workspaces.at(-1)],
  })
  const reloaded = await import(
    `../src/addons/autocomplete/settings.ts?test=${serial++}`
  )
  assert.equal(reloaded.readPreferences().excludedDocuments.length, 600)
  assert.equal(reloaded.readPreferences().excludedWorkspaces.length, 600)
  assert.deepEqual(reloaded.readPreferences().excludedDocuments, documents)
  assert.deepEqual(reloaded.readPreferences().excludedWorkspaces, workspaces)
  const next = {
    ...reloaded.readPreferences(),
    excludedDocuments: [...documents.slice(1), 'new-document'],
    excludedWorkspaces: [...workspaces.slice(1), 'new-workspace'],
  }
  reloaded.writePreferences(next)
  const updated = await import(
    `../src/addons/autocomplete/settings.ts?test=${serial++}`
  )
  assert.deepEqual(updated.readPreferences(), next)
})

test('failed storage writes keep exclusions active through resubscription and storage events, then retry', async (t) => {
  const settings = await preferences({
    'hibi:autocomplete': { learning: true },
  })
  const events = new EventTarget()
  globalThis.window = events
  t.after(() => {
    delete globalThis.window
  })
  const error = t.mock.method(console, 'error', () => {})
  assert.equal(settings.preferencesSaved(), true)
  const initial = settings.readPreferences()
  const stored = localStorage.getItem('hibi:autocomplete')
  const set = localStorage.setItem
  localStorage.setItem = () => {
    throw new DOMException('storage full', 'QuotaExceededError')
  }
  let changes = 0
  const stop = settings.onPreferencesChange(() => changes++)
  const next = {
    ...initial,
    excludedDocuments: Array.from({ length: 600 }, (_, i) => `document-${i}`),
    excludedWorkspaces: Array.from({ length: 600 }, (_, i) => `workspace-${i}`),
  }
  settings.writePreferences(next)
  assert.equal(settings.readPreferences(), next)
  assert.equal(changes, 1)
  assert.equal(error.mock.callCount(), 1)
  assert.equal(settings.preferencesSaved(), false)
  assert.equal(localStorage.getItem('hibi:autocomplete'), stored)
  stop()
  const again = settings.onPreferencesChange(() => changes++)
  t.after(again)
  assert.equal(settings.readPreferences(), next)
  for (const key of ['hibi:autocomplete', null]) {
    events.dispatchEvent(
      Object.assign(new Event('storage'), { key, storageArea: localStorage }),
    )
    assert.equal(settings.readPreferences(), next)
  }
  assert.equal(changes, 3)
  assert.equal(settings.preferencesSaved(), false)
  localStorage.setItem = set
  settings.writePreferences(next)
  assert.equal(changes, 4)
  assert.equal(settings.preferencesSaved(), true)
  const reloaded = await import(
    `../src/addons/autocomplete/settings.ts?test=${serial++}`
  )
  assert.deepEqual(reloaded.readPreferences(), next)
})

test('autocomplete validates stored languages and exclusions, and defaults safely', async () => {
  const settings = await preferences({
    'hibi:autocomplete': {
      languages: ['en', 'bad', 'en', 'tl'],
      excludedDocuments: [
        'note',
        'note',
        3,
        null,
        {},
        [],
        'x'.repeat(256),
        'x'.repeat(257),
      ],
      excludedWorkspaces: {},
    },
  })
  const value = settings.readPreferences()
  assert.deepEqual(value.languages, ['en', 'tl'])
  assert.deepEqual(value.excludedDocuments, ['note', 'x'.repeat(256)])
  assert.deepEqual(value.excludedWorkspaces, [])
  assert.equal(value.learning, true)
  assert.equal(value.suggest, true)
  assert.equal(value.tabAccepts, true)
})

test('migration keeps the old preferences if saving fails and retries', async () => {
  const previous = {
    suggest: true,
    tabAccepts: false,
    languages: ['de', 'en'],
  }
  const settings = await preferences({ 'hibi:dictionary:typing': previous })
  const set = localStorage.setItem
  localStorage.setItem = () => {
    throw new Error('quota')
  }
  let enabled = 0
  const enable = async () => {
    enabled++
  }
  await assert.rejects(settings.migrateDictionaryTyping(enable), /quota/)
  assert.equal(enabled, 1)
  assert.deepEqual(settings.readPreferences().languages, previous.languages)
  assert.equal(localStorage.getItem('hibi:autocomplete'), null)
  assert.deepEqual(
    JSON.parse(localStorage.getItem('hibi:dictionary:typing')),
    previous,
  )
  localStorage.setItem = set
  await settings.migrateDictionaryTyping(enable)
  assert.equal(enabled, 2)
  assert.equal(settings.readPreferences().suggest, true)
  assert.equal(localStorage.getItem('hibi:dictionary:typing'), null)
})

test('saved autocomplete preferences win over stale dictionary settings', async () => {
  const settings = await preferences({
    'hibi:autocomplete': {
      languages: ['fr', 'de'],
      suggest: true,
      tabAccepts: true,
    },
    'hibi:dictionary:typing': {
      languages: ['en'],
      suggest: false,
      tabAccepts: false,
    },
  })
  await settings.migrateDictionaryTyping(async () => {
    assert.fail('saved autocomplete preferences must win')
  })
  const next = settings.readPreferences()
  assert.deepEqual(next.languages, ['fr', 'de'])
  assert.equal(next.suggest, true)
  assert.equal(next.tabAccepts, true)
  assert.equal(localStorage.getItem('hibi:dictionary:typing'), null)
})

test('startup migration enables existing suggestions before saving language and Tab preferences', async () => {
  const settings = await preferences({
    'hibi:dictionary:typing': {
      suggest: true,
      acceptOnTab: false,
      languages: ['fr', 'de'],
    },
  })
  let enabled = 0
  await settings.migrateDictionaryTyping(async () => {
    enabled++
    assert.equal(localStorage.getItem('hibi:autocomplete'), null)
    assert.ok(localStorage.getItem('hibi:dictionary:typing'))
  })
  assert.equal(enabled, 1)
  assert.deepEqual(settings.readPreferences().languages, ['fr', 'de'])
  assert.equal(settings.readPreferences().tabAccepts, false)
  assert.equal(localStorage.getItem('hibi:dictionary:typing'), null)
  await settings.migrateDictionaryTyping(async () => enabled++)
  assert.equal(enabled, 1)
})

test('failed activation retains legacy preferences and retries migration', async () => {
  const previous = { suggest: true, acceptOnTab: false, languages: ['tl'] }
  const settings = await preferences({ 'hibi:dictionary:typing': previous })
  await assert.rejects(
    settings.migrateDictionaryTyping(async () => {
      throw new Error('activation failed')
    }),
    /activation failed/,
  )
  assert.equal(settings.readPreferences().tabAccepts, false)
  assert.equal(localStorage.getItem('hibi:autocomplete'), null)
  assert.deepEqual(
    JSON.parse(localStorage.getItem('hibi:dictionary:typing')),
    previous,
  )
  let enabled = false
  await settings.migrateDictionaryTyping(async () => {
    enabled = true
  })
  assert.equal(enabled, true)
  assert.equal(settings.readPreferences().tabAccepts, false)
})

test('migration leaves fresh, disabled, and already migrated activation alone', async () => {
  for (const data of [
    {},
    { 'hibi:dictionary:typing': { suggest: false, languages: ['de'] } },
    { 'hibi:dictionary:typing': { languages: ['de'] } },
    {
      'hibi:dictionary:typing': { suggest: true, languages: ['de'] },
      'hibi:autocomplete': { suggest: false, languages: ['fr'] },
    },
  ]) {
    const settings = await preferences(data)
    await settings.migrateDictionaryTyping(async () => {
      assert.fail('must not enable autocomplete')
    })
    assert.equal(localStorage.getItem('hibi:dictionary:typing'), null)
    if (data['hibi:autocomplete']) {
      assert.equal(settings.readPreferences().suggest, false)
      assert.deepEqual(settings.readPreferences().languages, ['fr'])
    }
  }
})

test('empty or unsupported stored suggestion languages fall back to English', async () => {
  for (const languages of [[], ['ja', 'bad', null]]) {
    const settings = await preferences({ 'hibi:autocomplete': { languages } })
    assert.deepEqual(settings.readPreferences().languages, ['en'])
  }
})

test('language changes keep at least one supported suggestion language', async () => {
  const settings = await preferences({
    'hibi:autocomplete': { languages: ['fr', 'de'] },
  })
  let changes = 0
  const stop = settings.onPreferencesChange(() => changes++)
  const next = { ...settings.readPreferences(), languages: ['fr'] }
  settings.writePreferences(next)
  assert.deepEqual(settings.readPreferences().languages, ['fr'])
  for (const languages of [[], ['ja']]) {
    settings.writePreferences({ ...next, languages })
    assert.equal(settings.readPreferences(), next)
    assert.deepEqual(
      JSON.parse(localStorage.getItem('hibi:autocomplete')).languages,
      ['fr'],
    )
  }
  assert.equal(changes, 1)
  stop()
})

test('fresh autocomplete defaults to English without a second language filter', async () => {
  const settings = await preferences({})
  assert.deepEqual(settings.readPreferences().languages, ['en'])
})
