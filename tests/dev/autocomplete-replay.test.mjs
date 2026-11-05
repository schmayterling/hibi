import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  assertNextWordQuality,
  evaluateCorpus,
  fixtureComplete,
  replay,
  replayRepository,
  repositoryCorpus,
  repositoryProse,
  textItems,
} from '../../scripts/autocomplete-replay.mjs'
import { createPersonalModel } from '../../src/addons/autocomplete/model.ts'

let reportPromise
let repositoryModel
const replayReport = () =>
  (reportPromise ??= replay({
    fixturesOnly: true,
    createModel: (options) => {
      repositoryModel = createPersonalModel(options)
      return repositoryModel
    },
  }))

test('excluded code leaves boundaries without synthetic tokens or joined context', () => {
  const text = repositoryProse(
    'before `hidden` after\n# `hidden` tail\nword\n```js\nhidden\n```\nlast',
  )
  const items = textItems(text)
  assert.deepEqual(
    items.map((item) => item.word),
    ['before', 'after', 'tail', 'word', 'last'],
  )
  for (const item of items) assert.deepEqual(item.context, [])
  assert.equal(textItems(repositoryProse('`hidden`')).length, 0)
})

test('repository corpus keeps frozen prose, file split and training-only vocabulary', () => {
  const corpus = repositoryCorpus()
  const hash = (text) => createHash('sha256').update(text).digest('hex')
  assert.equal(
    hash(corpus.training),
    '83298ca2e1dabfb78b9e4d606e4478d80fe5592181098d7e75440ad244ef313e',
  )
  assert.equal(
    hash(corpus.heldOut),
    'bbe476d220bc543d4f0ba8ceced3402facdeb5026d968b66db05f1325d9a4d60',
  )
  assert.equal(corpus.trainingFiles.length, 100)
  assert.equal(corpus.heldOutFiles.length, 50)
  assert.equal(corpus.trainingDocuments.length, corpus.trainingFiles.length)
  assert.equal(corpus.heldOutDocuments.length, corpus.heldOutFiles.length)
  assert.equal(
    new Set([...corpus.trainingFiles, ...corpus.heldOutFiles]).size,
    150,
  )
  assert.deepEqual(corpus.dictionary.en, [
    ...new Set(
      corpus.trainingDocuments
        .flatMap(textItems)
        .map(({ word }) => word.normalize('NFC').toLowerCase()),
    ),
  ])
})

test('repository replay fails if next-word prediction is removed', async () => {
  const report = await replayReport()
  let queries = 0
  await assert.rejects(
    replayRepository(
      () => assert.fail('next-word control must not look up prefixes'),
      () => ({
        ...repositoryModel,
        // Reuse frozen training; the control changes only predictions.
        observe: () => {},
        suggest: (request) => {
          assert.equal(request.prefix, '')
          queries++
          return []
        },
      }),
      { nextWordOnly: true },
    ),
    /must produce nonzero predictions/,
  )
  assert.equal(queries, report.repository.queries.nextWord.personal.samples)
})

test('quality gates reject excessive firing and poor precision independently', () => {
  const report = (fireRate, precision) => ({
    queries: { nextWord: { personal: { fired: 10, fireRate, precision } } },
  })
  assert.throws(
    () => assertNextWordQuality(report(0.051, 0.5)),
    /must not exceed 5%/,
  )
  assert.throws(
    () => assertNextWordQuality(report(0.04, 0.39)),
    /must reach 40%/,
  )
  assert.doesNotThrow(() => assertNextWordQuality(report(0.05, 0.4)))
})

const corpus = {
  scope: 'check',
  languages: ['en'],
  training: 'we carry coffee. we carry coffee.',
  heldOut: 'we carry novelty. we carry novelty.',
  dictionary: { en: [] },
}

test('held-out tokens cannot be the training list with different punctuation', async () => {
  await assert.rejects(
    evaluateCorpus(
      {
        ...corpus,
        heldOut: 'we carry coffee! we carry coffee!',
      },
      fixtureComplete,
    ),
    /held-out tokens must differ/,
  )
})

test('first-time keys exclude targets and count one occurrence; evaluation never learns', async () => {
  const { report } = await evaluateCorpus(corpus, fixtureComplete)
  assert.equal(report.modelFrozen, true)
  assert.equal(report.training.tokens, 6)
  assert.equal(report.heldOut.tokens, 6)
  assert.notEqual(report.training.sha256, report.heldOut.sha256)
  assert.deepEqual(report.queryCounts.prefix, {
    trainingUniqueKeys: 2,
    heldOutUniqueKeys: 2,
    unseenTrainingQueryOccurrences: 2,
    firstTimeQueries: 1,
  })
  assert.equal(report.queryCounts.nextWord.firstTimeQueries, 0)
  assert.equal(report.queryCounts.nextWord.unseenTrainingQueryOccurrences, 0)
  assert.equal(report.queries.prefix.firstTime.personal.samples, 1)
  assert.equal(report.queries.prefix.unseenTrainingTarget.personal.samples, 2)
  assert.equal(report.queries.prefix.unseenTrainingTarget.personal.topKHits, 0)
  assert.equal(
    report.queries.prefix.unseenTrainingTarget.personal.charactersSaved,
    0,
  )
  assert.equal(
    report.queries.nextWord.unseenTrainingTarget.personal.topKHits,
    0,
  )
})

test('prefix save counts subtract typed prefix and acceptance; baseline case matches insertion', async () => {
  const { report } = await evaluateCorpus(
    {
      ...corpus,
      training: 'we enjoy coffee.',
      heldOut: 'They enjoy coffee. Coffee today.',
      dictionary: { en: ['they', 'enjoy', 'coffee', 'today'] },
    },
    fixtureComplete,
  )
  assert.equal(report.queries.prefix.baseline.samples, 5)
  assert.equal(report.queries.prefix.baseline.topOneHits, 5)
  assert.equal(report.queries.prefix.baseline.topKHits, 5)
  assert.equal(report.queries.prefix.baseline.charactersSaved, 6)
  assert.equal(report.queries.nextWord.baseline.topOneHits, 0)
  assert.equal(report.queries.nextWord.baseline.charactersSaved, 0)
})

test('repeated prefix queries reuse candidates while retaining every baseline sample', async () => {
  const lookups = []
  const { report } = await evaluateCorpus(
    {
      ...corpus,
      training: 'we enjoy coffee.',
      heldOut: 'we carry coffee. we carry coffee.',
      dictionary: { en: ['carry', 'coffee'] },
    },
    (prefix, corpus) => {
      lookups.push(prefix)
      return fixtureComplete(prefix, corpus)
    },
  )
  assert.deepEqual(lookups, ['car', 'cof'])
  assert.equal(report.queries.prefix.baseline.samples, 4)
  assert.equal(report.queries.prefix.baseline.topOneHits, 4)
  assert.equal(report.queries.prefix.baseline.charactersSaved, 6)
})

test('personal scoring follows real insertion casing and preserves internal capitals', async () => {
  const { report } = await evaluateCorpus(
    {
      ...corpus,
      training:
        'Something works. Something stays. we saw something nearby. we saw something again. we carry iPhone. we carry iPhone.',
      heldOut: 'later something happened. Something changed. iPhone arrived.',
    },
    fixtureComplete,
  )
  assert.equal(report.queries.prefix.personal.topOneHits, 3)
  assert.equal(report.queries.prefix.personal.charactersSaved, 12)
})

test('replay reports separate modes, sources, novel targets and internally consistent counts', async (t) => {
  const report = await replayReport()
  assert.equal(report.corpora.length, 3)
  const repository = report.repository
  assert.ok(repository.heldOut.tokens >= 10_000)
  assert.ok(repository.training.tokens > 0)
  assert.equal(repository.modelFrozen, true)
  assert.equal(
    new Set([...repository.training.files, ...repository.heldOut.files]).size,
    repository.training.files.length + repository.heldOut.files.length,
  )
  assertNextWordQuality(repository)
  const nextWord = repository.queries.nextWord.personal
  assert.equal(nextWord.samples, 15544)
  assert.equal(nextWord.fired, 413)
  assert.equal(nextWord.topOneHits, 194)
  t.diagnostic(
    JSON.stringify({
      nextWord: {
        samples: nextWord.samples,
        fired: nextWord.fired,
        hits: nextWord.topOneHits,
        precision: nextWord.precision,
        fireRate: nextWord.fireRate,
      },
      prefixBaseline: repository.queries.prefix.baseline,
    }),
  )
  for (const kind of ['prefix', 'nextWord']) {
    const metric = repository.queries[kind].personal
    assert.equal(metric.fireRate, metric.fired / metric.samples)
    assert.equal(metric.precision, metric.topOneHits / metric.fired)
  }
  assert.equal(report.dictionary.installedLanguages.length, 0)
  assert.ok(
    report.dictionary.sources.every(
      (source) => source.kind === 'fixture-fallback',
    ),
  )
  assert.ok(report.definitions.firstTime.includes('target excluded'))
  assert.ok(report.method.includes('rankWords'))
  assert.equal(
    report.samples,
    report.queries.prefix.personal.samples +
      report.queries.nextWord.personal.samples,
  )
  assert.equal(report.baseline, undefined)
  assert.equal(report.personal, undefined)
  for (const kind of ['prefix', 'nextWord']) {
    for (const mode of ['baseline', 'personal']) {
      const metric = report.queries[kind][mode]
      assert.equal(metric.samples, metric.latency.samples)
      assert.equal(
        metric.samples,
        report.corpora.reduce(
          (sum, corpus) => sum + corpus.queries[kind][mode].samples,
          0,
        ),
      )
      for (const count of [
        'fired',
        'topOneHits',
        'topKHits',
        'charactersSaved',
      ])
        assert.equal(
          metric[count],
          report.corpora.reduce(
            (sum, corpus) => sum + corpus.queries[kind][mode][count],
            0,
          ),
        )
      assert.ok(metric.topOneHits <= metric.topKHits)
      assert.ok(metric.topKHits <= metric.samples)
      assert.equal(
        report.queries[kind].firstTime[mode].samples,
        report.corpora.reduce(
          (sum, corpus) => sum + corpus.queryCounts[kind].firstTimeQueries,
          0,
        ),
      )
    }
  }
  for (const corpus of report.corpora) {
    assert.equal(corpus.modelFrozen, true)
    assert.notEqual(corpus.training.sha256, corpus.heldOut.sha256)
    assert.ok(corpus.heldOut.unseenTrainingTargetTokens > 0)
    assert.ok(corpus.queryCounts.prefix.firstTimeQueries > 0)
  }
})
