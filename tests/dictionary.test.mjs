import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  detectLangs,
  matchCase,
  plainText,
  wordAt,
} from '../src/addons/dictionary/lookup.ts'
import {
  datamuseProvider,
  parseWiktionary,
  parseWords,
  wiktionaryProvider,
} from '../src/addons/dictionary/online.ts'
import {
  createRegistry,
  DictionaryError,
  gather,
  LANGS,
} from '../src/addons/dictionary/providers.ts'
import {
  languageNames,
  readPreferences,
  writePreferences,
} from '../src/addons/dictionary/settings.ts'

const fixture = (name) =>
  readFile(new URL(`./fixtures/dictionary/${name}`, import.meta.url), 'utf8')
const preferences = { han: 'zh', latin: 'en' }
const signal = new AbortController().signal

test('dictionary parses captured Wiktionary and Datamuse responses', async () => {
  const happy = parseWiktionary(
    await fixture('wiktionary-happy.json'),
    'happy',
    'en',
  )
  assert.deepEqual(
    happy.map((entry) => entry.partOfSpeech),
    ['adjective', 'noun', 'verb'],
  )
  assert.equal(
    happy[0].senses[0].gloss,
    'Having a feeling arising from a consciousness of well-being or of enjoyment; enjoying good of any kind, such as comfort, peace, or tranquillity; blissful, contented, joyous.',
  )
  assert.equal(happy[0].senses[0].example, 'Music makes me feel happy.')
  assert.equal(happy[0].source.license, 'CC BY-SA 4.0')
  assert.equal(happy[0].source.url, 'https://en.wiktionary.org/wiki/happy')
  const german = parseWiktionary(
    await fixture('wiktionary-happy.json'),
    'happy',
    'de',
  )
  assert.equal(german[0].lang, 'de')
  assert.equal(german[0].partOfSpeech, 'adjective')
  assert.equal(german[0].senses[0].gloss, 'glad; satisfied; momentarily happy')
  assert.equal(german[0].source.url, happy[0].source.url)

  const chat = await fixture('wiktionary-chat.json')
  assert.equal(parseWiktionary(chat, 'chat', 'fr')[0].lang, 'fr')
  assert.equal(parseWiktionary(chat, 'chat', 'tl')[0].partOfSpeech, 'noun')
  assert.equal(
    parseWiktionary(
      await fixture('wiktionary-maganda.json'),
      'maganda',
      'tl',
    )[0].partOfSpeech,
    'adjective',
  )
  assert.equal(
    parseWiktionary(await fixture('wiktionary-nihao.json'), '你好', 'zh')[0]
      .senses[0].gloss,
    'hello; hi',
  )
  const neko = parseWiktionary(
    await fixture('wiktionary-neko.json'),
    '猫',
    'ja',
  )
  assert.equal(neko[0].lang, 'ja')
  assert.deepEqual(
    parseWiktionary(await fixture('wiktionary-neko.json'), '猫', 'zh'),
    [],
  )
  // Cantonese senses live in Wiktionary's Chinese section.
  const sikfaan = parseWiktionary(
    await fixture('wiktionary-sikfaan.json'),
    '食飯',
    'yue',
  )
  assert.equal(sikfaan[0].lang, 'zh')
  assert.equal(sikfaan[0].senses[0].gloss, 'to eat')
  assert.throws(() => parseWiktionary('[]', 'x', 'en'))

  const synonyms = parseWords(
    await fixture('datamuse-synonyms-happy.json'),
    'happy',
  )
  assert.deepEqual(synonyms.slice(0, 3), ['halcyon', 'content', 'bright'])
  assert.deepEqual(
    parseWords(await fixture('datamuse-antonyms-happy.json'), 'happy'),
    ['sad', 'distressed', 'unhappy', 'dysphoric'],
  )
  assert.deepEqual(
    parseWords('[{"word":"Happy"},{"word":" "},{"word":"glad"}]', 'happy'),
    ['glad'],
  )
  assert.deepEqual(parseWords('[]', 'happy'), [])
  // Malformed members fail the whole answer so it is retried, not cached.
  for (const text of ['[null]', '[{"word":42}]', '["glad"]', '[[]]'])
    assert.throws(() => parseWords(text, 'happy'), SyntaxError)
  assert.equal(
    plainText('<a href="/wiki/x">fish</a> &amp; <i>chips</i>&#33; &#x2014;'),
    'fish & chips! —',
  )
  assert.equal(plainText('a<br>b &eacute;'), 'a b é')
  assert.equal(plainText('<a title="x > y">word</a>s'), 'words')
  assert.equal(plainText("<p>one</p><p data-x='>'>two</p>"), 'one two')
  assert.equal(plainText('&lt;b&gt;<!-- <i> -->x'), '<b>x')
  assert.equal(plainText('a < b <!-- x <i>y</i>'), 'a < b')
  assert.equal(plainText('x<!--hidden'), 'x')
  assert.equal(plainText('x<![CDATA[hidden'), 'x')
  assert.equal(plainText('x<![CDATA[hidden]]> y'), 'x y')
  assert.equal(plainText('<!doctype html>x'), 'x')
  assert.equal(plainText('<a "x> <b>y</b>'), '<a "x> y')
})

test('dictionary strips malformed markup in linear time', (t) => {
  const cases = [
    `<${'a'.repeat(64000)}`,
    '<a '.repeat(21000),
    `<a ${'"x" <'.repeat(12000)}`,
  ].map((html) => [html, html.replace(/\s+/g, ' ').trim()])
  for (const html of ['<!--'.repeat(16000), '<!'.repeat(32000)])
    cases.push([`x${html}`, 'x'])
  for (const [html, expected] of cases) {
    assert.equal(plainText(html), expected)
    const timings = []
    for (let run = 0; run < 7; run++) {
      const started = performance.now()
      const result = plainText(html)
      timings.push(performance.now() - started)
      assert.equal(result, expected)
    }
    const median = timings.sort((a, b) => a - b)[3]
    const label = `${html.slice(0, 8)}… median ${median.toFixed(2)} ms`
    t.diagnostic(label)
    assert.ok(median < 250, label)
  }
})

test('dictionary finds the caret word with the right segmenter and language', () => {
  const text = 'A “don’t” day, well-being.'
  assert.deepEqual(wordAt(text, 5, 5, preferences), {
    from: 3,
    to: 8,
    word: 'don’t',
  })
  assert.deepEqual(wordAt(text, 13, 13, preferences).word, 'day')
  assert.equal(wordAt(text, 10, 15, preferences).word, 'day,')
  assert.equal(wordAt('   ', 1, 1, preferences), null)
  assert.equal(wordAt('a\nb', 0, 3, preferences), null)
  const chinese = '我今天很高興，去學校。'
  assert.equal(wordAt(chinese, 9, 9, preferences).word, '學校')
  assert.equal(wordAt(chinese, 5, 5, preferences).word, '高興')
  assert.equal(wordAt(chinese, 4, 4, preferences).word, '很')
  assert.equal(wordAt('猫が好きです', 1, 1, preferences).word, '猫')

  assert.deepEqual(detectLangs('ねこ', preferences), ['ja'])
  assert.deepEqual(detectLangs('猫', preferences), ['zh', 'yue', 'ja'])
  assert.deepEqual(detectLangs('猫', { han: 'ja', latin: 'en' }), [
    'ja',
    'zh',
    'yue',
  ])
  assert.deepEqual(detectLangs('chat', { han: 'zh', latin: 'fr' }), [
    'fr',
    'en',
    'tl',
    'de',
  ])
  assert.deepEqual(detectLangs('Straße', { han: 'zh', latin: 'de' }), [
    'de',
    'en',
    'tl',
    'fr',
  ])
  assert.deepEqual(detectLangs('schön', preferences), ['en', 'tl', 'fr', 'de'])
  assert.equal(
    wordAt('die Straße', 6, 6, { han: 'zh', latin: 'de' }).word,
    'Straße',
  )
  assert.deepEqual(detectLangs('사랑', preferences), [])
})

test('dictionary keeps German preferences and recent pack language', (t) => {
  const saved = new Map()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
    },
  })
  t.after(() => {
    if (descriptor)
      Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  })
  assert.ok(LANGS.includes('de'))
  assert.equal(languageNames.de, 'German')
  writePreferences({ han: 'zh', latin: 'de' })
  assert.deepEqual(readPreferences(), { han: 'zh', latin: 'de' })
  saved.set('hibi:dictionary', '{"latin":"unsupported"}')
  assert.deepEqual(readPreferences(), preferences)
})

test('german online lookup preserves noun capitalization before lowercase fallback', async () => {
  const requests = []
  const wiktionary = wiktionaryProvider(async ({ url }) => {
    const title = decodeURIComponent(url.split('/').at(-1))
    requests.push(title)
    if (title === 'Schön')
      return { ok: false, code: 'http-status', status: 404 }
    return {
      ok: true,
      value: {
        text: JSON.stringify({
          de: [
            {
              partOfSpeech: title === 'Haus' ? 'Noun' : 'Verb',
              definitions: [
                {
                  definition:
                    title === 'Haus'
                      ? 'house'
                      : title === 'haus'
                        ? 'imperative of hausen'
                        : 'beautiful',
                },
              ],
            },
          ],
        }),
      },
    }
  })
  assert.equal(
    (await wiktionary.lookup('Haus', 'de', signal))[0].senses[0].gloss,
    'house',
  )
  assert.deepEqual(requests, ['Haus'])
  assert.equal(
    (await wiktionary.lookup('haus', 'de', signal))[0].senses[0].gloss,
    'imperative of hausen',
  )
  assert.equal(
    (await wiktionary.lookup('Schön', 'de', signal))[0].senses[0].gloss,
    'beautiful',
  )
  assert.deepEqual(requests, ['Haus', 'haus', 'Schön', 'schön'])
})

test('dictionary German and English share a fetched Wiktionary page', async () => {
  const requests = []
  const happy = await fixture('wiktionary-happy.json')
  const registry = createRegistry()
  registry.register(
    wiktionaryProvider(async (request) => {
      requests.push(request.url)
      return { ok: true, value: { text: happy } }
    }),
  )
  const result = await gather(
    registry,
    detectLangs('happy', { han: 'zh', latin: 'de' }),
    'lookup',
    (provider, lang, cachedOnly) =>
      provider.lookup('happy', lang, signal, cachedOnly),
  )
  assert.deepEqual(
    result.found.map(({ lang }) => lang),
    ['de', 'en'],
  )
  assert.deepEqual(requests, [
    'https://en.wiktionary.org/api/rest_v1/page/definition/happy',
  ])
})

test('dictionary replacements keep the first letter case', () => {
  assert.equal(matchCase('happy', 'glad'), 'glad')
  assert.equal(matchCase('Happy', 'glad'), 'Glad')
  assert.equal(matchCase('Élan', 'flair'), 'Flair')
  assert.equal(matchCase('happy', 'English'), 'English')
  assert.equal(matchCase('猫', 'ねこ'), 'ねこ')
})

test('dictionary providers map host failures, share pages, and cache answers', async () => {
  const requests = []
  const responses = []
  const getText = async (request) => {
    requests.push(request.url)
    return responses.shift()
  }
  const wiktionary = wiktionaryProvider(getText)
  responses.push({ ok: false, code: 'unavailable' })
  await assert.rejects(wiktionary.lookup('chat', 'en', signal), {
    reason: 'offline',
  })
  responses.push({
    ok: true,
    value: { text: await fixture('wiktionary-chat.json') },
  })
  assert.equal((await wiktionary.lookup('Chat', 'fr', signal))[0].lang, 'fr')
  assert.equal((await wiktionary.lookup('chat', 'en', signal))[0].lang, 'en')
  assert.deepEqual(requests, [
    'https://en.wiktionary.org/api/rest_v1/page/definition/chat',
    'https://en.wiktionary.org/api/rest_v1/page/definition/chat',
  ])
  responses.push({ ok: false, code: 'http-status', status: 404 })
  assert.deepEqual(await wiktionary.lookup('qwzx', 'en', signal), [])
  responses.push({ ok: false, code: 'http-status', status: 429 })
  await assert.rejects(wiktionary.lookup('glad', 'en', signal), {
    reason: 'rate-limited',
  })
  responses.push({ ok: false, code: 'permission-denied' })
  await assert.rejects(wiktionary.lookup('glad', 'en', signal), {
    reason: 'denied',
  })

  requests.length = 0
  const datamuse = datamuseProvider(getText)
  responses.push(
    {
      ok: true,
      value: { text: await fixture('datamuse-synonyms-happy.json') },
    },
    {
      ok: true,
      value: { text: await fixture('datamuse-antonyms-happy.json') },
    },
  )
  const related = await datamuse.related('happy', 'en', signal)
  assert.equal(related.antonyms[0], 'sad')
  assert.deepEqual(await datamuse.related('Happy', 'en', signal), related)
  assert.deepEqual(requests, [
    'https://api.datamuse.com/words?rel_syn=happy&max=24',
    'https://api.datamuse.com/words?rel_ant=happy&max=24',
  ])

  // A malformed list is retried; a valid empty list is kept.
  requests.length = 0
  const text = (text) => ({ ok: true, value: { text } })
  responses.push(text('[null]'))
  await assert.rejects(datamuse.related('odd', 'en', signal), {
    reason: 'unavailable',
  })
  responses.push(text('[]'), text('[]'))
  assert.equal(await datamuse.related('odd', 'en', signal), null)
  assert.equal(await datamuse.related('odd', 'en', signal), null)
  assert.deepEqual(requests, [
    'https://api.datamuse.com/words?rel_syn=odd&max=24',
    'https://api.datamuse.com/words?rel_syn=odd&max=24',
    'https://api.datamuse.com/words?rel_ant=odd&max=24',
  ])
})

test('dictionary registry prefers installed offline packs and falls back online', async () => {
  const registry = createRegistry()
  const entry = (name) => ({
    term: 'x',
    lang: 'ja',
    senses: [{ gloss: name }],
    source: { name, license: 'test' },
  })
  let installed = false
  registry.register({
    id: 'online',
    label: 'Online',
    kind: 'online',
    languages: ['ja', 'en'],
    lookup: async (_term, lang) => {
      if (lang === 'en') throw new DictionaryError('offline')
      return [entry('online')]
    },
  })
  const dispose = registry.register({
    id: 'pack',
    label: 'Pack',
    kind: 'offline',
    languages: ['ja', 'zh'],
    installed: () => installed,
    lookup: async () => [entry('pack')],
  })
  const ask = (provider, lang) => provider.lookup('x', lang, signal)
  let result = await gather(registry, ['ja'], 'lookup', ask)
  assert.equal(result.found[0].value[0].source.name, 'online')
  result = await gather(registry, ['zh'], 'lookup', ask)
  assert.deepEqual(result, { found: [], installable: ['zh'] })
  installed = true
  result = await gather(registry, ['ja'], 'lookup', ask)
  assert.equal(result.found[0].value[0].source.name, 'pack')
  result = await gather(registry, ['en'], 'lookup', ask)
  assert.equal(result.failure, 'offline')
  result = await gather(registry, ['en', 'ja'], 'lookup', ask)
  assert.equal(result.failure, undefined)
  assert.equal(result.found.length, 1)
  dispose()
  assert.equal((await registry.providers('ja', 'lookup')).length, 1)
  assert.equal((await registry.providers('ja', 'related')).length, 0)
})

test('dictionary sends nothing online when an installed offline pack answers', async () => {
  const registry = createRegistry()
  const calls = []
  const provider = (id, kind, languages, answers) => ({
    id,
    label: id,
    kind,
    languages,
    lookup: async (term, lang, _signal, cachedOnly) => {
      calls.push(`${id}:${lang}${cachedOnly ? ' cached' : ''}`)
      return answers.includes(lang)
        ? [
            {
              term,
              lang,
              senses: [{ gloss: id }],
              source: { name: id, license: 'test' },
            },
          ]
        : []
    },
  })
  registry.register(
    provider(
      'online',
      'online',
      ['zh', 'yue', 'ja', 'en', 'tl', 'fr'],
      ['zh', 'ja', 'en', 'fr'],
    ),
  )
  registry.register(provider('pack', 'offline', ['zh', 'en'], ['zh']))
  const ask = (item, lang, cachedOnly) =>
    item.lookup('x', lang, signal, cachedOnly)
  let result = await gather(registry, ['yue', 'zh', 'ja'], 'lookup', ask)
  assert.deepEqual(calls, ['pack:zh'])
  assert.deepEqual(
    result.found.map(({ lang }) => lang),
    ['zh'],
  )

  calls.length = 0
  result = await gather(registry, ['en', 'tl', 'fr'], 'lookup', ask)
  assert.deepEqual(calls, [
    'pack:en',
    'online:en',
    'online:tl cached',
    'online:fr cached',
  ])
  assert.deepEqual(
    result.found.map(({ lang }) => lang),
    ['en', 'fr'],
  )

  calls.length = 0
  result = await gather(registry, ['tl', 'fr', 'en'], 'lookup', ask)
  assert.deepEqual(calls, [
    'pack:en',
    'online:tl',
    'online:fr',
    'online:en cached',
  ])
  assert.deepEqual(
    result.found.map(({ lang }) => lang),
    ['fr', 'en'],
  )
})

test('dictionary sends no follow-up request after the lookup is closed', async () => {
  const requests = []
  let controller = new AbortController()
  const getText = async (request) => {
    requests.push(request.url)
    controller.abort()
    return { ok: false, code: 'http-status', status: 404 }
  }
  await assert.rejects(
    datamuseProvider(getText).related('happy', 'en', controller.signal),
    DictionaryError,
  )
  assert.deepEqual(requests, [
    'https://api.datamuse.com/words?rel_syn=happy&max=24',
  ])
  requests.length = 0
  controller = new AbortController()
  await assert.rejects(
    wiktionaryProvider(getText).lookup('Happy', 'en', controller.signal),
    DictionaryError,
  )
  assert.deepEqual(requests, [
    'https://en.wiktionary.org/api/rest_v1/page/definition/happy',
  ])
})

test('dictionary retries malformed answers instead of caching them', async () => {
  const requests = []
  const responses = [
    { ok: true, value: { text: '<html>busy</html>' } },
    { ok: true, value: { text: await fixture('wiktionary-happy.json') } },
    { ok: true, value: { text: '{"oops":1}' } },
    {
      ok: true,
      value: { text: await fixture('datamuse-synonyms-happy.json') },
    },
    { ok: true, value: { text: '[]' } },
  ]
  const getText = async (request) => {
    requests.push(request.url)
    return responses.shift()
  }
  const wiktionary = wiktionaryProvider(getText)
  await assert.rejects(wiktionary.lookup('happy', 'en', signal), {
    reason: 'unavailable',
  })
  assert.equal((await wiktionary.lookup('happy', 'en', signal)).length, 3)
  const datamuse = datamuseProvider(getText)
  await assert.rejects(datamuse.related('happy', 'en', signal), {
    reason: 'unavailable',
  })
  assert.equal(
    (await datamuse.related('happy', 'en', signal)).synonyms[0],
    'halcyon',
  )
  assert.equal(requests.length, 5)
})

test('dictionary caches empty Wiktionary pages but retries malformed sections', async () => {
  const requests = []
  const responses = [
    '{"en":"broken"}',
    '{"en":[{"definitions":[{"definition":7}]}]}',
    '{}',
  ]
  const wiktionary = wiktionaryProvider(async (request) => {
    requests.push(request.url)
    return { ok: true, value: { text: responses.shift() } }
  })
  for (const _ of [1, 2])
    await assert.rejects(wiktionary.lookup('happy', 'en', signal), {
      reason: 'unavailable',
    })
  assert.deepEqual(await wiktionary.lookup('happy', 'en', signal), [])
  assert.deepEqual(await wiktionary.lookup('happy', 'en', signal), [])
  assert.equal(requests.length, 3)
})

test('dictionary tries the capitalized page when the lowercase one lacks the language', async () => {
  const requests = []
  const responses = {
    'https://en.wiktionary.org/api/rest_v1/page/definition/paris':
      '{"en":[{"partOfSpeech":"Noun","definitions":[{"definition":"plaster"}]}]}',
    'https://en.wiktionary.org/api/rest_v1/page/definition/Paris':
      '{"fr":[{"partOfSpeech":"Proper noun","definitions":[{"definition":"Paris"}]}]}',
  }
  const wiktionary = wiktionaryProvider(async (request) => {
    requests.push(request.url)
    return { ok: true, value: { text: responses[request.url] } }
  })
  const [entry] = await wiktionary.lookup('Paris', 'fr', signal)
  assert.equal(entry.partOfSpeech, 'proper noun')
  assert.equal(requests.length, 2)
})

test('dictionary shows every language on a fetched Wiktionary page without new requests', async () => {
  const requests = []
  const chat = await fixture('wiktionary-chat.json')
  const registry = createRegistry()
  registry.register(
    wiktionaryProvider(async (request) => {
      requests.push(request.url)
      return request.url.endsWith('/chat')
        ? { ok: true, value: { text: chat } }
        : { ok: false, code: 'http-status', status: 404 }
    }),
  )
  const result = await gather(
    registry,
    ['fr', 'en', 'ja', 'tl'],
    'lookup',
    (provider, lang, cachedOnly) =>
      provider.lookup('Chat', lang, signal, cachedOnly),
  )
  assert.deepEqual(
    result.found.map(({ lang }) => lang),
    ['fr', 'en', 'tl'],
  )
  assert.deepEqual(requests, [
    'https://en.wiktionary.org/api/rest_v1/page/definition/chat',
  ])
})
