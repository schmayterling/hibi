import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPersonalModel } from '../src/addons/autocomplete/model.ts'
import { rankWords } from '../src/addons/autocomplete/suggestions.ts'

const DAY = 86_400_000
const session = { scope: 'notes', languages: ['en'] }
const baseline = rankWords('cra', [
  { lang: 'en', words: ['crack', 'crazy', 'crayon', 'crayfish'] },
])
const query = { ...session, prefix: 'cra', baseline }
const words = (model, request = query) =>
  model.suggest(request).map((item) => item.word)
function learn(model, word, count = 1, extra = {}) {
  for (let i = 0; i < count; i++)
    model.observe({ ...session, kind: 'typed', word, ...extra })
}
function clock() {
  let time = 1_000_000
  return {
    now: () => time,
    advance: (ms) => {
      time += ms
    },
  }
}

test('cold start preserves actual dictionary order, phrases, languages and case', () => {
  const model = createPersonalModel()
  const ranked = rankWords('hap', [
    {
      lang: 'en',
      words: ['happy hour', 'Hapsburg', 'happiness', 'happy', 'haply'],
    },
    { lang: 'fr', words: ['hapax', 'happy'] },
  ])
  assert.deepEqual(
    words(model, {
      ...session,
      languages: ['en', 'fr'],
      prefix: 'hap',
      baseline: ranked,
    }),
    ranked.map((item) => item.word),
  )
  assert.deepEqual(
    words(model),
    baseline.map((item) => item.word),
  )
  assert.deepEqual(model.snapshot(), { version: 1, entries: [] })
})

test('cold start keeps accent-folded pack matches in their baseline order', () => {
  const model = createPersonalModel()
  const baseline = rankWords('cafe', [
    { lang: 'fr', words: ['café'] },
    { lang: 'en', words: ['cafeteria'] },
  ])
  assert.deepEqual(
    words(model, {
      ...session,
      languages: ['fr', 'en'],
      prefix: 'cafe',
      baseline,
    }),
    ['cafeteria', 'café'],
  )
})

test('personal prefix lookup matches equivalent Unicode spellings without changing stored words', () => {
  const model = createPersonalModel()
  for (let i = 0; i < 20; i++)
    model.observe({
      scope: 'notes',
      languages: ['fr'],
      word: 'école',
      kind: 'typed',
    })
  assert.deepEqual(
    words(model, { scope: 'notes', languages: ['fr'], prefix: 'e\u0301co' }),
    ['école'],
  )
  assert.equal(model.snapshot().entries[0].word, 'école')
})

test('custom vocabulary outranks ordinary baseline, strong history outranks custom', () => {
  const model = createPersonalModel()
  const request = {
    ...query,
    baseline: [...baseline, { word: 'craycray', lang: 'en', custom: true }],
  }
  assert.equal(words(model, request)[0], 'craycray')
  learn(model, 'crayzee', 80)
  assert.equal(words(model, request)[0], 'crayzee')
  assert.equal(words(model, { ...request, enabled: false })[0], 'craycray')
})

test('custom priority is retained when an offline pack contains the same word', () => {
  const model = createPersonalModel()
  const request = {
    ...query,
    baseline: [...baseline, { word: 'crayfish', lang: 'en', custom: true }],
  }
  assert.equal(words(model, request)[0], 'crayfish')
  assert.equal(words(model, { ...request, enabled: false })[0], 'crayfish')
  assert.equal(
    words(model, request).filter((word) => word === 'crayfish').length,
    1,
  )
})

test('repetition promotes personal vocabulary and existing dictionary words', () => {
  const model = createPersonalModel()
  learn(model, 'craycray', 40)
  assert.equal(words(model)[0], 'craycray')
  const other = createPersonalModel()
  learn(other, 'crayfish', 30)
  assert.equal(words(other)[0], 'crayfish')
})

test('one typed or accepted observation cannot overwhelm strongest cold baseline', () => {
  for (const kind of ['typed', 'accepted']) {
    const model = createPersonalModel({ now: () => 1_000_000 })
    learn(model, 'craycray', 1, { kind, context: ['that', 'was'] })
    assert.equal(
      words(model, { ...query, context: ['that', 'was'] })[0],
      baseline[0].word,
    )
    assert.ok(words(model).includes('craycray'))
    const existing = createPersonalModel({ now: () => 1_000_000 })
    learn(existing, baseline[1].word, 1, { kind, context: ['that', 'was'] })
    assert.equal(
      words(existing, { ...query, context: ['that', 'was'] })[0],
      baseline[0].word,
    )
  }
})

test('bigram and trigram patterns predict next word after a space', () => {
  const model = createPersonalModel()
  learn(model, 'crazy', 70)
  learn(model, 'wild', 25, { context: ['bro', 'that', 'was'] })
  learn(model, 'weird', 25, { context: ['it', 'was'] })
  assert.equal(
    words(model, { ...session, prefix: '', context: ['that', 'was'] })[0],
    'wild',
  )
  assert.equal(
    words(model, { ...session, prefix: '', context: ['it', 'was'] })[0],
    'weird',
  )
  assert.ok(model.snapshot().entries.some((row) => row.context.length === 1))
  assert.ok(model.snapshot().entries.every((row) => row.context.length <= 2))
})

test('next-word prediction needs matching repeated context, never context-free vocabulary', () => {
  const model = createPersonalModel({ now: () => 1_000_000 })
  for (let repeat = 0; repeat < 5; repeat++) {
    const phrase = ['bro', 'that', 'was', 'wild']
    for (const [i, word] of phrase.entries())
      learn(model, word, 1, { context: phrase.slice(0, i) })
  }
  const request = { ...session, prefix: '' }
  assert.deepEqual(words(model, { ...request, context: ['that', 'was'] }), [
    'wild',
  ])
  assert.deepEqual(words(model, { ...request, context: ['was'] }), ['wild'])
  for (const context of [[], ['purple', 'zebra'], ['done.']])
    assert.deepEqual(words(model, { ...request, context }), [])
  assert.deepEqual(
    words(model, { ...request, baseline: [{ word: 'wild', lang: 'en' }] }),
    [],
  )
  assert.deepEqual(
    words(model, { ...request, context: ['that', 'was'], enabled: false }),
    [],
  )
  assert.deepEqual(
    words(model, { ...request, context: ['that', 'was'], limit: 0 }),
    [],
  )
})

test('next-word prediction suppresses one-hit, tied and near-tied contexts', () => {
  const request = { ...session, prefix: '', context: ['that', 'was'] }
  for (const kind of ['typed', 'accepted']) {
    const model = createPersonalModel({ now: () => 1_000_000 })
    learn(model, 'wild', 1, { kind, context: request.context })
    assert.deepEqual(words(model, request), [])
  }
  for (const [first, second] of [
    [3, 3],
    [20, 19],
  ]) {
    const model = createPersonalModel({ now: () => 1_000_000 })
    learn(model, 'wild', first, { context: request.context })
    learn(model, 'weird', second, { context: request.context })
    assert.deepEqual(words(model, request), [])
  }
  const model = createPersonalModel({ now: () => 1_000_000 })
  learn(model, 'wild', 5, { context: request.context })
  learn(model, 'weird', 1, { context: request.context })
  assert.deepEqual(words(model, request), ['wild'])
  // Strong one-word evidence must not override an ambiguous longer context.
  learn(model, 'weird', 100, { context: ['it', 'was'] })
  assert.deepEqual(words(model, request), ['wild'])
  learn(model, 'weird', 2, { context: request.context })
  assert.deepEqual(words(model, request), [])
})

test('next-word gate requires five observations and seventy percent of all evidence', () => {
  const request = { ...session, prefix: '', context: ['that', 'was'] }
  for (const [winner, runner, tail, expected] of [
    [4, 0, 0, []],
    [5, 0, 0, ['wild']],
    [7, 3, 0, ['wild']],
    [7, 3, 1, []],
    [6, 3, 0, []],
    [75, 0, 33, []],
  ]) {
    const model = createPersonalModel({ now: () => 1_000_000 })
    learn(model, 'wild', winner, { context: request.context })
    learn(model, 'weird', runner, { context: request.context })
    for (let i = 0; i < tail; i++)
      learn(
        model,
        `other${String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26))}`,
        1,
        {
          context: request.context,
        },
      )
    assert.deepEqual(words(model, request), expected)
  }
})

test('unknown, weak or fully corrected contexts block shorter-context fallback', () => {
  const request = { ...session, prefix: '', context: ['that', 'was'] }
  for (const corrected of [false, true]) {
    const model = createPersonalModel({ now: () => 1_000_000 })
    learn(model, 'usual', 100, { context: ['it', 'was'] })
    assert.deepEqual(words(model, request), [])
    learn(model, 'wild', 1, {
      context: request.context,
      kind: corrected ? 'accepted' : 'typed',
    })
    if (corrected)
      learn(model, 'wild', 1, { context: request.context, kind: 'undo' })
    assert.deepEqual(words(model, request), [])
    assert.deepEqual(words(model, { ...request, context: ['was'] }), ['usual'])
  }
})

test('next-word evidence does not count multilingual rows twice', () => {
  const model = createPersonalModel({ now: () => 1_000_000 })
  const request = {
    ...session,
    languages: ['en', 'fr'],
    prefix: '',
    context: ['that', 'was'],
  }
  learn(model, 'wild', 7, { context: request.context })
  learn(model, 'weird', 3, {
    context: request.context,
    languages: request.languages,
  })
  assert.deepEqual(words(model, request), ['wild'])
})

test('slang, spelling, capitalization and multilingual scripts remain exact', () => {
  const model = createPersonalModel()
  for (const word of [
    'NaMe',
    'name',
    'NAME',
    'l’éco',
    'broooo',
    `bro${'o'.repeat(40)}`,
    'antidisestablishmentarianism',
    'kumustaaa',
    '你好',
    'こんにちは',
    'café',
    'co-operate',
  ])
    learn(model, word, 5, { languages: ['en', 'tl', 'zh', 'ja', 'fr'] })
  learn(model, 'NaMe', 20, { languages: ['en', 'tl', 'zh', 'ja', 'fr'] })
  const request = {
    ...session,
    languages: ['en', 'tl', 'zh', 'ja', 'fr'],
    prefix: 'na',
  }
  assert.equal(words(model, request)[0], 'NaMe')
  assert.deepEqual(words(model, request), ['NaMe'])
  assert.equal(words(model, { ...request, prefix: '你' })[0], '你好')
  assert.equal(words(model, { ...request, prefix: 'こん' })[0], 'こんにちは')
  assert.equal(words(model, { ...request, prefix: 'kum' })[0], 'kumustaaa')
  assert.equal(words(model, { ...request, prefix: 'l’é' })[0], 'l’éco')
  assert.ok(
    words(model, { ...request, prefix: 'bro' }).includes(
      `bro${'o'.repeat(40)}`,
    ),
  )
  assert.equal(
    words(model, { ...request, prefix: 'anti' })[0],
    'antidisestablishmentarianism',
  )
})

test('learned casing shares evidence and prefers mid-sentence spelling across saves', () => {
  const model = createPersonalModel({ now: () => 1_000_000 })
  learn(model, 'Something', 20)
  assert.deepEqual(words(model, { ...session, prefix: 'som' }), ['something'])
  learn(model, 'something', 1, { context: ['say'] })
  learn(model, 'Something', 20)
  const saved = model.snapshot()
  const row = saved.entries.find((entry) => !entry.context.length)
  assert.equal(row.word, 'something')
  assert.equal(row.count, 41)
  assert.equal(row.midSentence, true)
  const copy = createPersonalModel({ snapshot: saved, now: () => 1_000_000 })
  for (const prefix of ['som', 'Som', 'SOM'])
    assert.deepEqual(words(copy, { ...session, prefix }), ['something'])
  learn(model, 'Berlin', 1, { context: ['visit'] })
  learn(model, 'berlin', 20)
  assert.deepEqual(words(model, { ...session, prefix: 'ber' }), ['Berlin'])
  assert.deepEqual(
    words(
      createPersonalModel({ snapshot: model.snapshot(), now: () => 1_000_000 }),
      { ...session, prefix: 'ber' },
    ),
    ['Berlin'],
  )
})

test('legacy casing variants coalesce without multiplying snapshot evidence', () => {
  const model = createPersonalModel({ now: () => 1_000_000 })
  learn(model, 'Something', 20)
  const row = model.snapshot().entries[0]
  const copy = createPersonalModel({
    now: () => 1_000_000,
    snapshot: {
      version: 1,
      entries: [
        { ...row, word: 'Something' },
        { ...row, word: 'something', count: 1, midSentence: true },
        { ...row, midSentence: 'invalid' },
      ],
    },
  })
  assert.deepEqual(words(copy, { ...session, prefix: 'som' }), ['something'])
  assert.equal(copy.snapshot().entries.length, 1)
  assert.equal(copy.snapshot().entries[0].count, 20)
  const legacy = createPersonalModel({
    now: () => 1_000_000,
    snapshot: {
      version: 1,
      entries: [
        { ...row, word: 'Berlin' },
        { ...row, word: 'Berlin', context: ['visit'], count: 1 },
      ],
    },
  })
  assert.deepEqual(words(legacy, { ...session, prefix: 'ber' }), ['Berlin'])
})

test('case-insensitive context and vocabulary do not split next-word confidence', () => {
  const model = createPersonalModel({ now: () => 1_000_000 })
  learn(model, 'Wild', 1, { context: ['That', 'was'] })
  learn(model, 'wild', 4, { context: ['that', 'was'] })
  assert.deepEqual(
    words(model, { ...session, prefix: '', context: ['THAT', 'WAS'] }),
    ['wild'],
  )
  learn(model, 'WILD', 1, { context: ['that', 'was'], kind: 'accepted' })
  learn(model, 'wild', 1, { context: ['That', 'was'], kind: 'undo' })
  assert.equal(
    model.snapshot().entries.find((row) => row.context.length === 2).count,
    5,
  )
  const ranked = model.suggest({
    ...session,
    prefix: 'wil',
    baseline: [
      { word: 'Wild', lang: 'en' },
      { word: 'wild', lang: 'tl' },
    ],
  })
  assert.equal(ranked.length, 1)
})

test('session language sets filter membership without guessing word language', () => {
  const model = createPersonalModel()
  learn(model, 'kumusta', 20, { languages: ['tl', 'en'] })
  learn(model, '你好', 20, { languages: ['en'] })
  assert.equal(
    words(model, { ...session, languages: ['tl'], prefix: 'kum' })[0],
    'kumusta',
  )
  assert.deepEqual(
    words(model, { ...session, languages: ['fr'], prefix: 'kum' }),
    [],
  )
  assert.deepEqual(
    words(model, { ...session, languages: ['zh'], prefix: '你' }),
    [],
  )
  assert.equal(words(model, { ...session, prefix: '你' })[0], '你好')
  const snapshot = model.snapshot()
  assert.deepEqual(
    snapshot.entries.find((row) => row.word === 'kumusta').languages,
    ['en', 'tl'],
  )
})

test('overlapping session language sets do not double-count confidence', () => {
  const model = createPersonalModel({ now: () => 1_000_000 })
  learn(model, 'craycray', 3, { languages: ['en', 'tl'] })
  const one = model
    .suggest(query)
    .find((item) => item.word === 'craycray').score
  const mixed = model
    .suggest({ ...query, languages: ['en', 'tl'] })
    .find((item) => item.word === 'craycray').score
  assert.equal(one, mixed)
  learn(model, 'craycray', 3, { languages: ['en'] })
  assert.equal(
    model.suggest(query).find((item) => item.word === 'craycray').score,
    one,
  )
})

test('acceptance boosts evidence; ignored suggestions produce no signal', () => {
  const model = createPersonalModel({ now: () => 1_000_000 })
  learn(model, 'craycray')
  const typed = model
    .suggest(query)
    .find((item) => item.word === 'craycray').score
  learn(model, 'craycray', 1, { kind: 'accepted' })
  const boosted = model
    .suggest(query)
    .find((item) => item.word === 'craycray').score
  assert.ok(boosted > typed)
  const before = model.snapshot()
  learn(model, 'craycray', 50, { kind: 'ignored' })
  assert.equal(model.snapshot().entries[0].count, before.entries[0].count)
})

test('immediate undo and overwrite roll back accept boost and penalize repeated mistakes', () => {
  for (const kind of ['undo', 'overwrite']) {
    const timer = clock()
    const model = createPersonalModel({ now: timer.now })
    learn(model, 'crayfish', 30)
    assert.equal(words(model)[0], 'crayfish')
    for (let i = 0; i < 8; i++) {
      learn(model, 'crayfish', 1, { kind: 'accepted' })
      timer.advance(100)
      learn(model, 'crayfish', 1, { kind })
    }
    assert.equal(words(model)[0], baseline[0].word)
    const row = model.snapshot().entries[0]
    assert.ok(Math.abs(row.count - 30) < 0.001)
    assert.ok(row.corrections > 7.99)
    const saved = model.snapshot()
    learn(model, 'crayfish', 1, { kind })
    assert.deepEqual(model.snapshot(), saved)
  }
})

test('corrections affect comparable context; late and unrelated edits have no penalty', () => {
  const timer = clock()
  const model = createPersonalModel({ now: timer.now })
  learn(model, 'wild', 20, { context: ['that', 'was'] })
  learn(model, 'wild', 20, { context: ['work', 'is'] })
  const unrelated = { ...session, prefix: '', context: ['work', 'is'] }
  const score = model.suggest(unrelated)[0].score
  learn(model, 'wild', 1, { kind: 'accepted', context: ['that', 'was'] })
  learn(model, 'wild', 1, { kind: 'undo', context: ['that', 'was'] })
  assert.equal(model.suggest(unrelated)[0].score, score)
  assert.equal(
    model.snapshot().entries.find((row) => row.context.join(' ') === 'that was')
      .corrections,
    1,
  )
  learn(model, 'wild', 1, { kind: 'accepted' })
  timer.advance(10_001)
  learn(model, 'wild', 1, { kind: 'overwrite' })
  assert.equal(
    model.snapshot().entries.find((row) => !row.context.length).corrections,
    0,
  )
})

test('decay allows recent habits to replace older preferences and prunes stale data', () => {
  const timer = clock()
  const model = createPersonalModel({ now: timer.now })
  learn(model, 'craycray', 80)
  assert.equal(words(model)[0], 'craycray')
  timer.advance(300 * DAY)
  assert.equal(words(model)[0], baseline[0].word)
  learn(model, 'crazee', 40)
  assert.equal(words(model)[0], 'crazee')
  timer.advance(1000 * DAY)
  assert.deepEqual(model.snapshot().entries, [])
})

test('workspace, outside-workspace global scope and separate profile instances never pool', () => {
  const model = createPersonalModel()
  learn(model, 'craycray', 40)
  learn(model, 'crazee', 40, { scope: null })
  assert.equal(words(model)[0], 'craycray')
  assert.equal(words(model, { ...query, scope: null })[0], 'crazee')
  assert.deepEqual(
    words(model, { ...query, scope: 'other' }),
    baseline.map((item) => item.word),
  )
  assert.deepEqual(
    words(createPersonalModel()),
    baseline.map((item) => item.word),
  )
})

test('sensitive fields and disabled learning store nothing; disabled ranking uses baseline', () => {
  const model = createPersonalModel()
  learn(model, 'craycray', 20, { sensitive: true })
  learn(model, 'craycray', 20, { enabled: false })
  assert.deepEqual(model.snapshot().entries, [])
  learn(model, 'craycray', 40)
  assert.deepEqual(
    words(model, { ...query, enabled: false }),
    baseline.map((item) => item.word),
  )
  assert.deepEqual(words(model, { ...query, sensitive: true }), [])
  assert.ok(model.snapshot().entries.length > 0)
})

test('secret-like words and excluded context tokens never persist', () => {
  const model = createPersonalModel()
  const excluded = [
    'sk-privatevalue',
    'ghp_example',
    '123456',
    '1234-5678-9012-3456',
    'a@b.example',
    'https://secret.example',
    'deadbeefdeadbeef',
    'eyJhbGciOiJIUzIoneJhbGciOiJIUzI',
    'word/sensitive',
    'x'.repeat(65),
    'two words',
    'line\nbreak',
    'api_key=value',
  ]
  for (const word of excluded) learn(model, word, 3)
  assert.deepEqual(model.snapshot().entries, [])
  learn(model, 'okay', 3, { context: ['secret@example.test', 'safe'] })
  assert.ok(
    model.snapshot().entries.some((row) => row.context.join(' ') === 'safe'),
  )
  const json = JSON.stringify(model.snapshot())
  for (const secret of excluded) assert.ok(!json.includes(secret))
  assert.ok(!json.includes('secret@example.test'))
  assert.deepEqual(words(model, { ...session, prefix: 'sk-' }), [])
})

test('clearing one scope, global scope or all scopes removes vocabulary and correction state', () => {
  const model = createPersonalModel()
  learn(model, 'craycray', 10)
  learn(model, 'crazee', 40, { scope: null })
  learn(model, 'crabro', 10, { scope: 'inactive' })
  model.clear('notes')
  learn(model, 'craycray', 1, { kind: 'undo' })
  assert.deepEqual(
    words(model),
    baseline.map((item) => item.word),
  )
  assert.equal(words(model, { ...query, scope: null })[0], 'crazee')
  model.clear(null)
  assert.deepEqual(
    words(model, { ...query, scope: null }),
    baseline.map((item) => item.word),
  )
  assert.ok(model.snapshot().entries.some((row) => row.scope === 'inactive'))
  model.clear()
  assert.deepEqual(model.snapshot(), { version: 1, entries: [] })
})

test('snapshots round-trip exact bounded aggregate data without sharing mutable references', () => {
  const timer = clock()
  const model = createPersonalModel({ now: timer.now })
  learn(model, 'CrayBro', 20, {
    context: ['bro', 'that', 'was'],
    languages: ['tl', 'en'],
  })
  learn(model, 'craycray', 1, { kind: 'accepted' })
  learn(model, 'craycray', 1, { kind: 'undo' })
  timer.advance(DAY)
  const saved = model.snapshot()
  const copy = createPersonalModel({
    now: timer.now,
    snapshot: JSON.parse(JSON.stringify(saved)),
  })
  assert.deepEqual(copy.snapshot(), saved)
  assert.deepEqual(copy.suggest(query), model.suggest(query))
  saved.entries[0].word = 'mutated'
  saved.entries[0].languages.length = 0
  saved.entries[0].context.push('leak')
  assert.ok(!JSON.stringify(model.snapshot()).includes('mutated'))
  assert.ok(!JSON.stringify(model.snapshot()).includes('leak'))
})

test('invalid, excessive and newer-version snapshots are ignored without throwing', () => {
  const timer = clock()
  const model = createPersonalModel({ now: timer.now })
  learn(model, 'crazy')
  const good = model.snapshot().entries[0]
  for (const snapshot of [
    null,
    [],
    {},
    { version: 2, entries: [good] },
    { version: 1, entries: 'invalid' },
    { version: 1, entries: Array(8193).fill(good) },
  ])
    assert.deepEqual(
      createPersonalModel({ snapshot, now: timer.now }).snapshot().entries,
      [],
    )
  const corrupt = [
    { word: 'sk_abc' },
    { scope: '' },
    { scope: 1 },
    { languages: ['xx'] },
    { languages: ['en', 'en'] },
    { languages: [] },
    { context: ['one', 'two', 'three'] },
    { context: ['secret@example.test'] },
    { count: NaN },
    { count: Infinity },
    { count: -1 },
    { count: 1_000_001 },
    { corrections: '1' },
    { corrections: -1 },
    { updatedAt: timer.now() + 1 },
    { lastUsed: timer.now() + 1 },
    { updatedAt: -1 },
  ].map((bad) => ({ ...good, ...bad }))
  const copy = createPersonalModel({
    now: timer.now,
    snapshot: {
      version: 1,
      entries: [null, ...corrupt, { ...good, extra: 'private sentence' }, good],
    },
  })
  assert.deepEqual(copy.snapshot().entries, [good])
})

test('entry and scope caps prune while keeping strong evidence', () => {
  const timer = clock()
  const model = createPersonalModel({ now: timer.now, maxEntries: 48 })
  learn(model, 'craycray', 80)
  for (let i = 0; i < 100; i++) {
    timer.advance(1)
    learn(
      model,
      'word' +
        String.fromCharCode(65 + (i % 26)) +
        String.fromCharCode(65 + Math.floor(i / 26)),
      1,
      { context: ['that', 'was'] },
    )
  }
  assert.ok(model.snapshot().entries.length <= 48)
  assert.equal(words(model)[0], 'craycray')
  const many = createPersonalModel({ now: timer.now })
  for (let i = 0; i < 25; i++) {
    timer.advance(1)
    learn(many, 'term', 1, { scope: `workspace-${i}` })
  }
  assert.equal(
    new Set(many.snapshot().entries.map((row) => row.scope)).size,
    16,
  )
})

test('repeated undo removal keeps common-prefix overflow candidates indexed', () => {
  const model = createPersonalModel({ now: () => 1_000_000 })
  for (let i = 0; i < 50; i++)
    learn(
      model,
      `prefix${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`,
    )
  const request = { ...session, prefix: 'pre' }
  const before = words(model, request)
  assert.equal(before.length, 8)
  for (let i = 0; i < 40; i++) {
    learn(model, 'prefixghost', 1, {
      context: ['that', 'was'],
      kind: 'accepted',
    })
    learn(model, 'prefixghost', 1, { context: ['that', 'was'], kind: 'undo' })
    assert.deepEqual(words(model, request), before)
  }
  assert.equal(model.snapshot().entries.length, 51)
})

test('trimmed indexes match a fresh load and continuous typing evicts old scopes before saving', () => {
  const timer = clock()
  const model = createPersonalModel({ now: timer.now, maxEntries: 48 })
  for (let i = 0; i < 100; i++) {
    timer.advance(1)
    learn(
      model,
      `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`,
      1,
      { context: ['that', 'was'] },
    )
  }
  const copy = createPersonalModel({
    snapshot: model.snapshot(),
    now: timer.now,
  })
  for (const prefix of ['wor', 'worda', 'wordz'])
    for (const context of [[], ['was'], ['that', 'was']])
      assert.deepEqual(
        model.suggest({ ...session, prefix, context }),
        copy.suggest({ ...session, prefix, context }),
      )
  const scopes = createPersonalModel({ now: timer.now })
  for (let i = 0; i < 25; i++) {
    timer.advance(1)
    learn(scopes, 'vocabulary', 1, { scope: `workspace-${i}` })
  }
  assert.deepEqual(
    words(scopes, { ...session, scope: 'workspace-0', prefix: 'voc' }),
    [],
  )
  assert.deepEqual(
    words(scopes, { ...session, scope: 'workspace-24', prefix: 'voc' }),
    ['vocabulary'],
  )
})

test('rapid requests are synchronous, independent and cannot publish stale results', () => {
  const model = createPersonalModel()
  learn(model, 'craycray', 40)
  const first = model.suggest(query)
  const second = model.suggest({ ...query, prefix: 'crayc', baseline: [] })
  assert.ok(!(first instanceof Promise))
  assert.deepEqual(
    second.map((item) => item.word),
    ['craycray'],
  )
  first[0].word = 'changed'
  assert.equal(words(model)[0], 'craycray')
  assert.deepEqual(words(model, { ...query, prefix: 'absent' }), [])
  assert.deepEqual(words(model, { ...query, limit: 0 }), [])
})

test('bounded common-prefix ranking stays below 5ms at maximum snapshot size', (t) => {
  const timer = clock()
  const entry = (i) => ({
    scope: 'notes',
    languages: ['en', 'tl', 'fr', 'ja', 'zh', 'yue'],
    context: [[], ['that'], ['bro', 'that']][i % 3],
    word:
      'prefix' +
      String.fromCharCode(65 + (i % 26)) +
      String.fromCharCode(65 + (Math.floor(i / 26) % 26)) +
      String.fromCharCode(65 + Math.floor(i / 676)),
    count: 1 + (i % 50),
    corrections: 0,
    updatedAt: timer.now(),
    lastUsed: timer.now(),
  })
  const model = createPersonalModel({
    now: timer.now,
    maxEntries: 8192,
    snapshot: {
      version: 1,
      entries: Array.from({ length: 8192 }, (_, i) => entry(i)),
    },
  })
  assert.equal(model.snapshot().entries.length, 8192)
  const request = {
    ...session,
    languages: ['en', 'tl', 'fr', 'ja', 'zh', 'yue'],
    prefix: 'pre',
    context: ['bro', 'that'],
  }
  for (let i = 0; i < 100; i++) model.suggest(request)
  const timings = []
  for (let i = 0; i < 500; i++) {
    const start = performance.now()
    model.suggest(request)
    timings.push(performance.now() - start)
  }
  timings.sort((a, b) => a - b)
  t.diagnostic(
    JSON.stringify({
      samples: timings.length,
      p95Ms: timings[Math.floor(timings.length * 0.95)],
      meanMs: timings.reduce((a, b) => a + b) / timings.length,
      maxMs: timings.at(-1),
    }),
  )
  assert.ok(
    timings[Math.floor(timings.length * 0.95)] < 5,
    'p95 ranking must be below 5ms',
  )
  assert.ok(
    timings.reduce((a, b) => a + b) / timings.length < 5,
    'mean ranking must be below 5ms',
  )
})

test('offline replay reports real sample sizes, baseline ranking and measured metrics', async (t) => {
  // One installed pack goes through the production reader; other languages use fixtures.
  const root = await mkdtemp(join(tmpdir(), 'hibi-replay-packs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pack = join(root, 'en')
  const entry = `${JSON.stringify({ word: 'prefix', keys: [], meanings: [], synonyms: [], antonyms: [] })}\n`
  await mkdir(pack)
  await writeFile(join(pack, 'data.jsonl'), entry)
  await writeFile(
    join(pack, 'index.json'),
    JSON.stringify({
      version: 1,
      id: 'en',
      rows: [['prefix', [[0, entry.length]]]],
    }),
  )
  await writeFile(
    join(pack, 'manifest.json'),
    JSON.stringify({ id: 'en', format: 1 }),
  )
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      ['scripts/autocomplete-replay.mjs', `--pack-root=${root}`],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
    ),
  )
  assert.deepEqual(report.dictionary.installedLanguages, ['en'])
  assert.ok(report.samples > 50)
  assert.equal(report.corpora.length, 3)
  assert.ok(report.method.includes('rankWords'))
  assert.ok(report.limitations.length > 0)
  assert.equal(
    report.samples,
    report.queries.prefix.personal.samples +
      report.queries.nextWord.personal.samples,
  )
  for (const kind of ['prefix', 'nextWord']) {
    const { baseline, personal, firstTime } = report.queries[kind]
    assert.equal(personal.latency.samples, personal.samples)
    assert.equal(baseline.samples, personal.samples)
    assert.ok(personal.topOneHits <= personal.topKHits)
    assert.ok(personal.topKHits <= personal.samples)
    assert.ok(firstTime.personal.samples <= personal.samples)
  }
})
