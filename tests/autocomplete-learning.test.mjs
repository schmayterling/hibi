import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLearning } from '../src/addons/autocomplete/learning.ts'
import { createPersonalModel } from '../src/addons/autocomplete/model.ts'
import { createTypingSignals } from '../src/addons/autocomplete/signals.ts'
import { createAddonStorage } from '../src/main/addon-storage.ts'
import { createAddonStorageScope } from '../src/renderer/src/addon-storage.ts'

const session = { scope: 'notes', documentId: 'document', personal: true }
const languages = ['en', 'tl']
const view = {
  documentId: 'document',
  documentGeneration: 1,
  viewId: 'source',
  viewGeneration: 1,
}
const observation = (word, extra = {}) => ({
  scope: 'notes',
  documentId: 'document',
  languages,
  word,
  kind: 'typed',
  ...extra,
})
const request = (before, extra = {}) => ({
  view,
  editor: 'source',
  contentVersion: 1,
  documentLength: before.length,
  selection: { anchor: before.length, head: before.length },
  before,
  after: '',
  prose: { before, after: '' },
  trigger: { kind: 'explicit' },
  ...extra,
})
let version = 0
const input = (before, extra = {}) => ({
  ...request(before),
  contentVersion: ++version,
  kind: 'input',
  change: { from: before.length - 1, to: before.length - 1, insertedLength: 1 },
  ...extra,
})
function typeWord(signals, prefix, word, extra = {}) {
  for (let i = 0; i < word.length; i++)
    signals.input(
      input(prefix + word.slice(0, i + 1), extra),
      session,
      languages,
    )
}
function compose(signals, before) {
  signals.input(
    input(before, {
      kind: 'composition',
      change: { from: 0, to: 0, insertedLength: before.length },
    }),
    session,
    languages,
  )
}
function acceptance(
  signals,
  word = 'wild',
  before = 'that was wil',
  extra = {},
) {
  const req = request(before, extra)
  const item = {
    label: word,
    insertText: word,
    from: before.length - 3,
    to: before.length,
  }
  signals.accept(req, item, session, languages)
  return { req, item, end: item.from + word.length }
}
function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function idleQueue() {
  const callbacks = new Map()
  let id = 0
  return {
    schedule(run) {
      const key = ++id
      callbacks.set(key, run)
      return () => callbacks.delete(key)
    },
    size: () => callbacks.size,
    run(deadline) {
      const batch = [...callbacks.values()]
      callbacks.clear()
      for (const run of batch) run(deadline)
    },
  }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-autocomplete-learning-'))
  const storage = createAddonStorage(
    directory,
    () => true,
    () => true,
  )
  const key = {
    owner: 'autocomplete',
    scope: { kind: 'global' },
    key: 'personal-model',
    version: 1,
  }
  let hook
  const scopes = []
  const gates = []
  const operations = new Set()
  const open = async (controlled = false) => {
    const scope = createAddonStorageScope('autocomplete', () => true, {
      readAddonStorage: (request) => storage.read(request, 0),
      writeAddonStorage(request) {
        const write = () => storage.write(request, 0)
        const operation = controlled && hook ? hook(request, write) : write()
        operations.add(operation)
        void operation.then(
          () => operations.delete(operation),
          () => operations.delete(operation),
        )
        return operation
      },
      onAddonStorageChanged: (callback) => storage.subscribe(callback),
    })
    scopes.push(scope)
    return scope.api.global('personal-model', 1)
  }
  const handle = await open(true)
  const idle = idleQueue()
  const learning = createLearning(handle, idle.schedule)
  idle.run()
  t.after(async () => {
    learning.dispose()
    for (const gate of gates) gate.resolve()
    await Promise.allSettled([...operations])
    for (const scope of scopes) scope.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    learning,
    idle,
    handle,
    open,
    intercept: (next) => {
      hook = next
    },
    gate() {
      const gate = deferred()
      gates.push(gate)
      return gate
    },
    async disk() {
      const document = JSON.parse(
        await readFile(join(directory, 'global', 'autocomplete.json'), 'utf8'),
      )
      return document.entries['personal-model'].value
    },
    async external(value) {
      const current = await storage.read(key, 0)
      assert.ok('revision' in current)
      const result = await storage.write(
        { ...key, baseRevision: current.revision, value },
        0,
      )
      assert.equal(result.status, 'saved')
    },
  }
}
const count = (snapshot, word, scope = 'notes', context = []) =>
  snapshot.entries.find(
    (row) =>
      row.word === word &&
      row.scope === scope &&
      JSON.stringify(row.context) === JSON.stringify(context),
  )?.count ?? 0

test('signals observe only committed boundaries, composition and enter/crlf', () => {
  const seen = []
  const signals = createTypingSignals((event) => seen.push(event))
  typeWord(signals, 'bro that was ', 'wild')
  assert.equal(seen.length, 0)
  signals.input(input('bro that was wild '), session, languages)
  assert.equal(seen[0].word, 'wild')
  assert.deepEqual(seen[0].context, ['that', 'was'])
  compose(signals, 'kumusta ')
  for (const separator of ['\n', '\r\n']) {
    typeWord(signals, 'that was ', 'wild')
    const before = `that was wild${separator}`
    signals.input(
      input(before, {
        change: { from: 13, to: 13, insertedLength: separator.length },
      }),
      session,
      languages,
    )
    assert.equal(seen.at(-1).word, 'wild')
    assert.deepEqual(seen.at(-1).context, ['that', 'was'])
  }
  assert.equal(seen.length, 4)
})

test('boundary alone never learns loaded, pasted or partly typed words', () => {
  const seen = []
  const signals = createTypingSignals((event) => seen.push(event))
  signals.input(input('loaded '), session, languages)
  signals.input(input('pasted '), session, languages)
  typeWord(signals, 'preex', 'isting')
  signals.input(input('preexisting '), session, languages)
  assert.deepEqual(seen, [])
  typeWord(signals, '', 'fresh')
  signals.input(input('fresh '), session, languages)
  assert.deepEqual(
    seen.map((event) => event.word),
    ['fresh'],
  )
})

test('version gaps, resets, unrelated edits and view changes invalidate typed provenance', () => {
  for (const reason of [
    'version',
    'view',
    'document generation',
    'view id',
    'editor',
    'replace',
    'undo',
    'reset',
    'unrelated',
  ]) {
    const seen = []
    const signals = createTypingSignals((event) => seen.push(event))
    typeWord(signals, '', 'wild')
    if (reason === 'reset') signals.reset()
    if (reason === 'replace' || reason === 'undo')
      signals.input(
        input('', {
          kind: reason,
          change: { from: 0, to: 4, insertedLength: 4 },
        }),
        session,
        languages,
      )
    if (reason === 'unrelated')
      signals.input(
        input('wild', { change: { from: 10, to: 10, insertedLength: 1 } }),
        session,
        languages,
      )
    const extra =
      {
        version: { contentVersion: version + 2 },
        view: { view: { ...view, viewGeneration: 2 } },
        'document generation': { view: { ...view, documentGeneration: 2 } },
        'view id': { view: { ...view, viewId: 'rich' } },
        editor: { editor: 'rich' },
      }[reason] ?? {}
    signals.input(input('wild ', extra), session, languages)
    assert.deepEqual(seen, [], reason)
  }
})

test('backspace within typed word retains provenance for corrected committed spelling', () => {
  const seen = []
  const signals = createTypingSignals((event) => seen.push(event))
  typeWord(signals, '', 'wilk')
  signals.input(
    input('wil', {
      kind: 'delete',
      change: { from: 3, to: 4, insertedLength: 0 },
    }),
    session,
    languages,
  )
  signals.input(input('wild'), session, languages)
  signals.input(input('wild '), session, languages)
  assert.deepEqual(
    seen.map((event) => event.word),
    ['wild'],
  )
})

test('rich enter uses old word end despite paragraph token offset gap', () => {
  const seen = []
  const signals = createTypingSignals((event) => seen.push(event))
  const prefix = 'that was '
  for (let i = 0; i < 4; i++) {
    const before = prefix + 'wild'.slice(0, i + 1)
    const from = prefix.length + i
    signals.input(
      input(before, {
        editor: 'rich',
        selection: { anchor: from + 1, head: from + 1 },
        change: { from, to: from, insertedLength: 1 },
      }),
      session,
      languages,
    )
  }
  signals.input(
    input('that was wild\n', {
      editor: 'rich',
      documentLength: 16,
      selection: { anchor: 15, head: 15 },
      change: { from: 13, to: 13, insertedLength: 2 },
    }),
    session,
    languages,
  )
  assert.deepEqual(
    seen.map((event) => [event.word, event.context]),
    [['wild', ['that', 'was']]],
  )
})

test('accepts learn phrase words with two-word context, boundary is not typed twice', () => {
  const seen = []
  const signals = createTypingSignals((event) => seen.push(event))
  const { end } = acceptance(signals, 'happy hour')
  assert.deepEqual(
    seen.map((event) => [event.word, event.kind, event.context]),
    [
      ['happy', 'accepted', ['that', 'was']],
      ['hour', 'accepted', ['was', 'happy']],
    ],
  )
  signals.input(
    input('that was happy hour ', {
      change: { from: end, to: end, insertedLength: 1 },
    }),
    session,
    languages,
  )
  assert.equal(seen.length, 2)
  typeWord(signals, 'that was happy hour ', 'yay')
  signals.input(input('that was happy hour yay '), session, languages)
  assert.equal(seen.at(-1).word, 'yay')
  assert.deepEqual(seen.at(-1).context, ['happy', 'hour'])
})

test('accepted boundary is deduplicated after long pause without treating late edits as corrections', () => {
  let time = 1000
  const seen = []
  const signals = createTypingSignals(
    (event) => seen.push(event),
    () => time,
  )
  const { end } = acceptance(signals)
  time += 20_000
  signals.input(
    input('that was wild ', {
      change: { from: end, to: end, insertedLength: 1 },
    }),
    session,
    languages,
  )
  assert.equal(seen.length, 1)
  signals.input(
    input('that was wise ', {
      kind: 'undo',
      change: { from: end - 4, to: end, insertedLength: 4 },
    }),
    session,
    languages,
  )
  assert.equal(seen.length, 1)
})

test('immediate undo/overwrite learn penalties once and preserve original accepted context', () => {
  for (const kind of ['undo', 'input']) {
    const model = createPersonalModel({ now: () => 1000 })
    const seen = []
    const signals = createTypingSignals(
      (event) => {
        seen.push(event)
        model.observe(event)
      },
      () => 1000,
    )
    const { end } = acceptance(signals)
    signals.input(
      input('that was wise', {
        kind,
        change: { from: end - 4, to: end, insertedLength: 4 },
      }),
      session,
      languages,
    )
    assert.equal(seen.length, 2)
    assert.equal(seen[1].kind, kind === 'undo' ? 'undo' : 'overwrite')
    assert.deepEqual(seen[1].context, ['that', 'was'])
    const saved = model.snapshot()
    assert.equal(count(saved, 'wild'), 0)
    assert.equal(
      saved.entries.find((row) => row.context.length === 2).corrections,
      1,
    )
    signals.input(
      input('that was wise', {
        kind: 'undo',
        change: { from: end - 4, to: end, insertedLength: 4 },
      }),
      session,
      languages,
    )
    assert.equal(seen.length, 2)
  }
})

test('insertions before accepted word shift receipt; unrelated document/view never gets penalty', () => {
  const seen = []
  const signals = createTypingSignals(
    (event) => seen.push(event),
    () => 1000,
  )
  const { end } = acceptance(signals)
  signals.input(
    input('x', { change: { from: 0, to: 0, insertedLength: 1 } }),
    session,
    languages,
  )
  signals.input(
    input('that was wise', {
      kind: 'undo',
      change: { from: end - 3, to: end + 1, insertedLength: 4 },
    }),
    session,
    languages,
  )
  assert.equal(seen.at(-1).kind, 'undo')
  const other = createTypingSignals(
    (event) => seen.push(event),
    () => 1000,
  )
  const next = acceptance(other)
  const before = seen.length
  other.input(
    input('that was wise', {
      view: { ...view, viewGeneration: 2 },
      kind: 'undo',
      change: { from: next.end - 4, to: next.end, insertedLength: 4 },
    }),
    session,
    languages,
  )
  assert.equal(seen.length, before)
})

test('whole secret-like tokens are not split into learned words or phrase context', () => {
  const model = createPersonalModel({ now: () => 1000 })
  const signals = createTypingSignals(model.observe, () => 1000)
  for (const secret of [
    'private@example.test',
    'sk_privatevalue',
    'ghp_abcdef',
    '1234private',
    'https://example.test/path',
    'sk-privatevalue',
  ])
    compose(signals, `${secret} `)
  assert.deepEqual(model.snapshot().entries, [])
  compose(signals, 'private@example.test okay ')
  assert.ok(
    model.snapshot().entries.every((row) => !row.context.includes('test')),
  )
  acceptance(signals, 'okay private@example.test fine')
  const snapshot = model.snapshot()
  assert.ok(snapshot.entries.every((row) => row.context.length <= 2))
  assert.ok(!JSON.stringify(snapshot).includes('private@example.test'))
  assert.ok(
    snapshot.entries.find((row) => row.word === 'fine' && !row.context.length),
  )
})

test('disabled session, missing safe prose and reset discard acceptance receipts', () => {
  const seen = []
  const signals = createTypingSignals(
    (event) => seen.push(event),
    () => 1000,
  )
  signals.input(input('private '), { ...session, personal: false }, languages)
  const req = request('wil', { prose: null })
  signals.accept(
    req,
    { label: 'wild', insertText: 'wild', from: 0, to: 3 },
    session,
    languages,
  )
  assert.deepEqual(seen, [])
  const { end } = acceptance(signals)
  signals.reset()
  signals.input(
    input('wise', {
      kind: 'undo',
      change: { from: end - 4, to: end, insertedLength: 4 },
    }),
    session,
    languages,
  )
  assert.equal(seen.length, 1)
})

test('startup prewarms saved model at idle and external reload stays lazy', (t) => {
  const trained = createPersonalModel()
  trained.observe(observation('remembered'))
  let saved = trained.snapshot()
  let reads = 0
  let changed
  const idle = idleQueue()
  const learning = createLearning(
    {
      snapshot: () => ({
        status: 'ready',
        revision: 0,
        get value() {
          reads++
          return saved
        },
      }),
      subscribe(listener) {
        changed = listener
        return () => {}
      },
    },
    idle.schedule,
  )
  t.after(() => learning.dispose())
  assert.equal(reads, 0)
  assert.equal(idle.size(), 1)
  idle.run()
  assert.equal(reads, 1)
  const request = { scope: 'notes', languages, prefix: 'rem' }
  assert.equal(learning.suggest(request)[0].word, 'remembered')
  assert.equal(reads, 1)
  learning.suggest(request)
  assert.equal(reads, 1)
  saved = { version: 1, entries: [] }
  changed()
  assert.equal(reads, 1)
  assert.deepEqual(learning.suggest(request), [])
  assert.equal(reads, 2)
})

test('preferences and disposal cancel cold prewarming without reading or writing storage', async () => {
  for (const action of ['persist', 'dispose']) {
    const idle = idleQueue()
    const learning = createLearning(
      {
        snapshot: () => assert.fail('cold settings must not load the model'),
        set: () => assert.fail('cold settings must not rewrite the snapshot'),
        subscribe: () => () => {},
      },
      idle.schedule,
    )
    learning.observe(observation('excluded'))
    if (action === 'persist')
      await learning.persist({
        learning: false,
        excludedDocuments: [],
        excludedWorkspaces: [],
      })
    else learning.dispose()
    assert.equal(idle.size(), 0)
    idle.run()
    learning.dispose()
  }
})

test('idle learning batches once, caps pending words and persists only aggregates', async (t) => {
  const f = await fixture(t)
  for (let i = 0; i < 140; i++)
    f.learning.observe(observation('bro', { context: ['that', 'was'] }))
  assert.equal(f.idle.size(), 1)
  assert.deepEqual(
    f.learning.suggest({ scope: 'notes', languages, prefix: 'br' }),
    [],
  )
  f.idle.run()
  assert.equal(
    f.learning.suggest({ scope: 'notes', languages, prefix: 'br' })[0].word,
    'bro',
  )
  await f.learning.persist()
  const disk = await f.disk()
  assert.ok(count(disk, 'bro') > 127.99 && count(disk, 'bro') <= 128)
  assert.ok(disk.entries.every((row) => row.context.length <= 2))
  assert.ok(
    disk.entries.every((row) => !('before' in row) && !('after' in row)),
  )
})

test('idle deadlines yield queued observations, timeout makes one step, persist drains remainder', async (t) => {
  const f = await fixture(t)
  const suggested = (prefix) =>
    f.learning
      .suggest({ scope: 'notes', languages, prefix })
      .map((item) => item.word)
  for (const word of ['fresh', 'other', 'final'])
    f.learning.observe(observation(word))
  f.idle.run({ didTimeout: false, timeRemaining: () => 0 })
  assert.deepEqual(suggested('fre'), [])
  assert.equal(f.idle.size(), 1)
  let checks = 0
  f.idle.run({
    didTimeout: false,
    timeRemaining: () => (++checks === 1 ? 5 : 0),
  })
  assert.deepEqual(suggested('fre'), ['fresh'])
  assert.deepEqual(suggested('oth'), [])
  assert.equal(f.idle.size(), 1)
  f.idle.run({ didTimeout: true, timeRemaining: () => 0 })
  assert.deepEqual(suggested('oth'), ['other'])
  assert.deepEqual(suggested('fin'), [])
  assert.equal(f.idle.size(), 1)
  await f.learning.persist()
  assert.equal(f.idle.size(), 0)
  const disk = await f.disk()
  for (const word of ['fresh', 'other', 'final'])
    assert.ok(count(disk, word) > 0.99)
})

test('discard after a partial idle flush cancels queued remainder', async (t) => {
  const f = await fixture(t)
  f.learning.observe(observation('committed'))
  f.learning.observe(observation('pending'))
  f.idle.run({ didTimeout: true, timeRemaining: () => 0 })
  f.learning.discard()
  assert.equal(f.idle.size(), 0)
  f.idle.run()
  await f.learning.persist()
  assert.deepEqual(
    (await f.disk()).entries.map((row) => row.word),
    ['committed'],
  )
})

test('privacy changes drop only excluded queues and keep document ids off disk', async (t) => {
  const f = await fixture(t)
  f.learning.observe(observation('learned'))
  await f.learning.persist()
  f.learning.observe(observation('private'))
  f.learning.observe(observation('allowed', { documentId: 'other-document' }))
  f.learning.observe(observation('workspace', { scope: 'excluded-workspace' }))
  f.learning.observe(
    observation('outside', { scope: null, documentId: 'outside-document' }),
  )
  await f.learning.persist({
    learning: true,
    excludedDocuments: ['document'],
    excludedWorkspaces: ['excluded-workspace'],
  })
  const disk = await f.disk()
  assert.deepEqual(
    new Set(disk.entries.map((row) => row.word)),
    new Set(['learned', 'allowed', 'outside']),
  )
  assert.ok(disk.entries.every((row) => !('documentId' in row)))
  assert.equal(f.idle.size(), 0)
  f.learning.observe(observation('paused', { documentId: 'other-document' }))
  await f.learning.persist({
    learning: false,
    excludedDocuments: [],
    excludedWorkspaces: [],
  })
  assert.deepEqual(
    new Set((await f.disk()).entries.map((row) => row.word)),
    new Set(['learned', 'allowed', 'outside']),
  )
})

test('saving prunes aging evidence without needing another typing observation', async (t) => {
  let time = 1_000_000
  t.mock.method(Date, 'now', () => time)
  const f = await fixture(t)
  f.learning.observe(observation('stale', { context: ['that', 'was'] }))
  await f.learning.persist()
  assert.equal((await f.disk()).entries.length, 3)
  time += 1000 * 86_400_000
  await f.learning.persist()
  assert.deepEqual((await f.disk()).entries, [])
  assert.deepEqual(
    f.learning.suggest({ scope: 'notes', languages, prefix: 'sta' }),
    [],
  )
})

test('accepted words survive own save receipt and remain correctable after persistence', async (t) => {
  const f = await fixture(t)
  const signals = createTypingSignals(f.learning.observe)
  const { end } = acceptance(signals)
  signals.input(
    input('that was wild ', {
      change: { from: end, to: end, insertedLength: 1 },
    }),
    session,
    languages,
  )
  const epoch = f.learning.epoch()
  await f.learning.persist()
  assert.ok(Math.abs(count(await f.disk(), 'wild') - 2) < 0.001)
  assert.equal(f.learning.epoch(), epoch)
  signals.input(
    input('that was wise', {
      kind: 'undo',
      change: { from: end - 4, to: end, insertedLength: 4 },
    }),
    session,
    languages,
  )
  await f.learning.persist()
  const disk = await f.disk()
  assert.ok(count(disk, 'wild') < 0.001)
  assert.ok(
    disk.entries.find((row) => row.context.length === 2).corrections > 0.999,
  )
})

test('discard cancels pending idle learning and queued persistence; disable and dispose do not learn', async (t) => {
  const f = await fixture(t)
  f.learning.observe(observation('disabled', { enabled: false }))
  assert.equal(f.idle.size(), 0)
  f.learning.observe(observation('private'))
  const epoch = f.learning.epoch()
  const queued = f.learning.persist()
  f.learning.discard()
  await queued
  assert.ok(f.learning.epoch() > epoch)
  assert.equal(f.idle.size(), 0)
  // Committed aggregate evidence is retained; discard cancels deferred work, not stored vocabulary.
  f.learning.observe(observation('pending'))
  f.learning.discard()
  f.idle.run()
  await f.learning.clear()
  assert.deepEqual((await f.disk()).entries, [])
  f.learning.dispose()
  f.learning.observe(observation('late'))
  assert.equal(f.idle.size(), 0)
})

test('scope clear and clear all reach disk before resolving, including inactive workspaces', async (t) => {
  const f = await fixture(t)
  for (const scope of ['notes', 'inactive', null])
    f.learning.observe(observation('vocabulary', { scope }))
  await f.learning.persist()
  await f.learning.clear('notes')
  assert.deepEqual(
    new Set((await f.disk()).entries.map((row) => row.scope)),
    new Set(['inactive', null]),
  )
  await f.learning.clear(null)
  assert.deepEqual(
    new Set((await f.disk()).entries.map((row) => row.scope)),
    new Set(['inactive']),
  )
  await f.learning.clear()
  assert.deepEqual((await f.disk()).entries, [])
})

test('clear waits for in-flight save then removes its disk data without later resurrection', async (t) => {
  const f = await fixture(t)
  const started = f.gate()
  const release = f.gate()
  let first = true
  f.intercept(async (_request, write) => {
    if (first) {
      first = false
      started.resolve()
      await release.promise
    }
    return write()
  })
  f.learning.observe(observation('private'))
  const saving = f.learning.persist()
  await started.promise
  const clearing = f.learning.clear()
  f.learning.observe(observation('duringclear'))
  release.resolve()
  await Promise.all([saving, clearing])
  assert.deepEqual((await f.disk()).entries, [])
  await f.learning.persist()
  assert.deepEqual((await f.disk()).entries, [])
})

test('external clear beats gated stale save and invalidates queued commits', async (t) => {
  const f = await fixture(t)
  f.learning.observe(observation('stored'))
  await f.learning.persist()
  const started = f.gate()
  const release = f.gate()
  f.intercept(async (_request, write) => {
    started.resolve()
    await release.promise
    return write()
  })
  f.learning.observe(observation('private'))
  const saving = f.learning.persist()
  await started.promise
  f.learning.observe(observation('pending'))
  await f.external({ version: 1, entries: [] })
  release.resolve()
  await saving
  f.intercept(undefined)
  await f.learning.persist()
  assert.deepEqual((await f.disk()).entries, [])
})

test('equal-value external clear cannot be mistaken for own save and resurrect fresh learning', async (t) => {
  const f = await fixture(t)
  await f.learning.persist()
  const started = f.gate()
  const release = f.gate()
  f.intercept(async (_request, write) => {
    started.resolve()
    await release.promise
    return write()
  })
  const saving = f.learning.persist()
  await started.promise
  f.learning.observe(observation('newprivate'))
  f.learning.flush()
  await f.external({ version: 1, entries: [] })
  release.resolve()
  await saving
  f.intercept(undefined)
  await f.learning.persist()
  assert.deepEqual((await f.disk()).entries, [])
})

test('scope clear retries conflict against current data and preserves other workspace updates', async (t) => {
  const f = await fixture(t)
  f.learning.observe(observation('private'))
  f.learning.observe(observation('otherword', { scope: 'other' }))
  await f.learning.persist()
  const started = f.gate()
  const release = f.gate()
  let first = true
  f.intercept(async (_request, write) => {
    if (first) {
      first = false
      started.resolve()
      await release.promise
    }
    return write()
  })
  const clearing = f.learning.clear('notes')
  await started.promise
  const external = createPersonalModel({ snapshot: await f.disk() })
  external.observe(observation('concurrent', { scope: 'other' }))
  external.observe(observation('moreprivate'))
  await f.external(external.snapshot())
  release.resolve()
  await clearing
  const disk = await f.disk()
  assert.ok(disk.entries.every((row) => row.scope === 'other'))
  assert.ok(disk.entries.some((row) => row.word === 'concurrent'))
})

test('concurrent clears keep observations blocked until every clear finishes', async (t) => {
  const f = await fixture(t)
  f.learning.observe(observation('first'))
  f.learning.observe(observation('second', { scope: 'inactive' }))
  await f.learning.persist()
  const firstStarted = f.gate()
  const firstRelease = f.gate()
  const secondStarted = f.gate()
  const secondRelease = f.gate()
  let calls = 0
  f.intercept(async (_request, write) => {
    calls++
    const started = calls === 1 ? firstStarted : secondStarted
    const release = calls === 1 ? firstRelease : secondRelease
    started.resolve()
    await release.promise
    return write()
  })
  const first = f.learning.clear('notes')
  const second = f.learning.clear('inactive')
  await firstStarted.promise
  firstRelease.resolve()
  await first
  await secondStarted.promise
  f.learning.observe(observation('shoulddrop', { scope: 'other' }))
  assert.equal(f.idle.size(), 0)
  secondRelease.resolve()
  await second
  f.intercept(undefined)
  await f.learning.persist()
  assert.deepEqual((await f.disk()).entries, [])
})

test('own in-flight save does not discard newer idle aggregates', async (t) => {
  const f = await fixture(t)
  const started = f.gate()
  const release = f.gate()
  let first = true
  f.intercept(async (_request, write) => {
    if (first) {
      first = false
      started.resolve()
      await release.promise
    }
    return write()
  })
  f.learning.observe(observation('first'))
  const saving = f.learning.persist()
  await started.promise
  f.learning.observe(observation('second'))
  f.learning.flush()
  release.resolve()
  await saving
  await f.learning.persist()
  assert.deepEqual(
    new Set((await f.disk()).entries.map((row) => row.word)),
    new Set(['first', 'second']),
  )
})
