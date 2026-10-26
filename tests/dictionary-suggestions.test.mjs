import assert from 'node:assert/strict'
import test from 'node:test'
import { createPersonalModel } from '../src/addons/autocomplete/model.ts'
import {
  autocompleteCompletions,
  prefixAt,
  rankWords,
} from '../src/addons/autocomplete/suggestions.ts'
import { CompletionBroker } from '../src/renderer/src/completion-broker.ts'

const settings = {
  suggest: true,
  tabAccepts: true,
  languages: ['en', 'fr'],
  learning: true,
  excludedDocuments: [],
  excludedWorkspaces: [],
}
const session = { scope: null, documentId: 'document', personal: true }
function dictionaryCompletions(
  complete,
  preferences,
  languageName,
  customCompletions,
) {
  const model = createPersonalModel()
  return autocompleteCompletions(
    {
      version: 1,
      complete: (prefix, langs, limit, signal) =>
        complete(langs, prefix, signal, limit),
      suggestionLanguages: () => ['en', 'fr', 'de', 'tl'],
      customWords: () => [],
      customCompletions,
    },
    preferences,
    { suggest: model.suggest, epoch: () => 0 },
    () => session,
    languageName,
  )
}
const request = (before, after = '') => ({
  view: {
    documentId: 'document',
    documentGeneration: 1,
    viewId: 'view',
    viewGeneration: 1,
  },
  contentVersion: 1,
  editor: 'source',
  documentLength: before.length + after.length,
  selection: { anchor: before.length, head: before.length },
  before,
  after,
  prose: { before, after },
  trigger: { kind: 'input', character: before.at(-1) },
})
const signal = () => new AbortController().signal
/** Collects broker updates and resolves when the final one arrives. */
const collect = () => {
  const updates = []
  let finish
  const done = new Promise((resolve) => {
    finish = resolve
  })
  return {
    updates,
    done,
    push(update) {
      updates.push(update)
      if (update.done) finish(update)
    },
  }
}

/** One fake native request per keystroke over in-memory packs. */
function packs(words, calls = []) {
  return async (langs, prefix, signal, limit) => {
    calls.push({ langs, prefix, limit })
    signal.throwIfAborted()
    return langs.flatMap((lang) => {
      const found = (words[lang] ?? []).filter((word) =>
        word.toLowerCase().startsWith(prefix.toLowerCase()),
      )
      return found.length ? [{ lang, words: found }] : []
    })
  }
}

test('suggestions take the Latin word being typed at the caret', () => {
  assert.equal(prefixAt('I am hap', ''), 'hap')
  assert.equal(prefixAt('I am hap', ' today'), 'hap')
  assert.equal(prefixAt('(l’éco', ''), 'l’éco')
  assert.equal(prefixAt('I am ha', ''), null)
  assert.equal(prefixAt('I am hap', 'py'), null)
  assert.equal(prefixAt('猫が好きで', ''), null)
  assert.equal(prefixAt('"*hap', ''), 'hap')
  assert.equal(prefixAt('see [hap', ''), 'hap')
})

test('suggestions skip commands, code, links, and urls', () => {
  for (const before of [
    '/tab',
    'text\n/tab',
    '#tag',
    '@sam',
    ':smi',
    '\\hap',
    '&amp',
    '[[wik',
    '[link](exa',
    'see https://exa',
    'www.exa',
    'path/to/fil',
    'run `npm ins',
    '```\nconst val',
    '~~~js\nfoo\nbar baz',
  ])
    assert.equal(prefixAt(before, ''), null, before)
  assert.equal(prefixAt('```\ncode\n```\nhap', ''), 'hap')
  assert.equal(prefixAt('`code` and hap', ''), 'hap')
  // Closed inline code at the start of a line is not a fence opener.
  assert.equal(prefixAt('```code``` and hap', ''), 'hap')
  assert.equal(prefixAt('```code```\nhap', ''), 'hap')
  assert.equal(prefixAt('~~~ ``` x\nhap', ''), null)
  assert.equal(prefixAt('``a`b`` and hap', ''), 'hap')
  assert.equal(prefixAt('use \\` for hap', ''), 'hap')
  assert.equal(prefixAt('``a`b and hap', ''), null)
})

test('suggestions rank match quality, then language order, then length', () => {
  const ranked = rankWords('hap', [
    {
      lang: 'en',
      words: ['hap', 'happy hour', 'Hapsburg', 'happiness', 'happy', 'haply'],
    },
    { lang: 'fr', words: ['hapax', 'happy'] },
  ])
  assert.deepEqual(
    ranked.map(({ word, lang }) => `${lang}:${word}`),
    [
      'en:haply',
      'en:happy',
      'en:happiness',
      'fr:hapax',
      'en:Hapsburg',
      'en:happy hour',
    ],
  )
  // A prefix typed exactly beats an accent-folded match in an earlier language.
  assert.deepEqual(
    rankWords('cafe', [
      { lang: 'fr', words: ['café'] },
      { lang: 'en', words: ['cafeteria'] },
    ]).map(({ word }) => word),
    ['cafeteria', 'café'],
  )
  // German nouns are capitalized, so case does not demote them.
  assert.equal(
    rankWords('haus', [
      { lang: 'de', words: ['Hausaufgabe'] },
      { lang: 'en', words: ['hausfrau'] },
    ])[0].word,
    'Hausaufgabe',
  )
  // The same word from two languages appears once, with its better match.
  assert.deepEqual(
    rankWords('pai', [
      { lang: 'en', words: ['Pain'] },
      { lang: 'fr', words: ['pain'] },
    ]),
    [{ word: 'pain', lang: 'fr' }],
  )
  assert.equal(
    rankWords('Hap', [{ lang: 'en', words: ['Hapsburg', 'happiness'] }])[0]
      .word,
    'Hapsburg',
  )
  assert.equal(
    rankWords('a', [
      { lang: 'en', words: Array.from({ length: 40 }, (_, i) => `a${i}`) },
    ]).length,
    8,
  )
})

test('suggestions ask every language in one request, keep case, and never go online', async () => {
  const calls = []
  const provider = dictionaryCompletions(
    packs({ en: ['happy', 'happen'], fr: ['hapax'] }, calls),
    () => settings,
    (lang) => lang,
  )
  const items = await provider(request('Hap'), signal())
  assert.deepEqual(
    items.map(({ label, insertText, from, to, detail }) => [
      label,
      insertText,
      from,
      to,
      detail,
    ]),
    [
      ['happy', 'Happy', 0, 3, 'en'],
      ['happen', 'Happen', 0, 3, 'en'],
      ['hapax', 'Hapax', 0, 3, 'fr'],
    ],
  )
  assert.deepEqual(calls, [{ langs: ['en', 'fr'], prefix: 'Hap', limit: 24 }])
  assert.ok(items.every((item) => item.acceptOnTab === undefined))
  // One language: no language tags, and Tab can be left to the editor.
  const englishSettings = { ...settings, languages: ['en'], tabAccepts: false }
  const english = dictionaryCompletions(
    packs({ en: ['happy'], fr: ['hapax'] }),
    () => englishSettings,
    (lang) => lang,
  )
  const [only, ...rest] = await english(request('hap'), signal())
  assert.equal(only.acceptOnTab, false)
  assert.equal(only.detail, undefined)
  assert.deepEqual(rest, [])
  assert.deepEqual(await provider(request('ha'), signal()), [])
  assert.deepEqual(
    await provider(
      { ...request('hap'), selection: { anchor: 0, head: 3 } },
      signal(),
    ),
    [],
  )
})

test('custom suggestions use the indexed provider instead of scanning all saved words', async () => {
  const calls = []
  const word = `hap${'x'.repeat(128)}`
  const provider = dictionaryCompletions(
    packs({}),
    () => settings,
    (lang) => lang,
    async (prefix, langs, limit) => {
      calls.push({ prefix, langs, limit })
      return [{ word, lang: 'en' }]
    },
  )
  const items = await provider(request('hap'), signal())
  assert.deepEqual(
    items.map(({ label, detail }) => [label, detail]),
    [[word, 'Your word']],
  )
  assert.deepEqual(calls, [{ prefix: 'hap', langs: ['en', 'fr'], limit: 64 }])
})

test('a failed completion request yields no suggestions; only cancellation rejects', async () => {
  const failing = dictionaryCompletions(
    async () => {
      throw new Error('worker gone')
    },
    () => settings,
    (lang) => lang,
  )
  assert.deepEqual(await failing(request('hap'), signal()), [])
})

test('suggestions stop when a newer keystroke cancels the request', async () => {
  const calls = []
  const provider = dictionaryCompletions(
    packs({ en: ['happy'], fr: ['hapax'] }, calls),
    () => settings,
    (lang) => lang,
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(provider(request('hap'), controller.signal), {
    name: 'AbortError',
  })
  assert.deepEqual(calls, [])

  const broker = new CompletionBroker()
  broker.register({ addonId: 'dictionary', activationGeneration: 1 }, provider)
  const first = collect()
  let current = request('hap')
  broker.request(
    () => current,
    () => current,
    (update) => first.push(update),
  )
  current = request('happ')
  const second = collect()
  broker.request(
    () => current,
    () => current,
    (update) => second.push(update),
  )
  assert.deepEqual(first.updates, [])
  assert.deepEqual(
    (await second.done).items.map((item) => item.label),
    ['happy'],
  )
  broker.dispose()
})

test('the completion broker keeps a provider’s Tab preference per item', async () => {
  const broker = new CompletionBroker()
  broker.register({ addonId: 'one', activationGeneration: 1 }, () => [
    { label: 'a', insertText: 'a', from: 0, to: 3, acceptOnTab: false },
    { label: 'b', insertText: 'b', from: 0, to: 3 },
    { label: 'c', insertText: 'c', from: 0, to: 3, acceptOnTab: 'no' },
  ])
  const current = request('hap')
  const updates = collect()
  broker.request(
    () => current,
    () => current,
    (update) => updates.push(update),
  )
  assert.deepEqual(
    (await updates.done).items.map((item) => [item.label, item.acceptOnTab]),
    [
      ['a', false],
      ['b', undefined],
    ],
  )
  broker.dispose()
})

test('ranking a full set of pack matches stays well under the typing budget', () => {
  const words = Array.from(
    { length: 32 },
    (_, i) => `prefix${'x'.repeat(i % 7)}${i}`,
  )
  const found = ['en', 'tl', 'fr'].map((lang) => ({ lang, words }))
  const start = performance.now()
  for (let i = 0; i < 200; i++) rankWords('pre', found)
  assert.ok((performance.now() - start) / 200 < 1)
})
