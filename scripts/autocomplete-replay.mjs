import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPersonalModel } from '../src/addons/autocomplete/model.ts'
import {
  insertionText,
  precedingWords,
  prefixAt,
  rankWords,
} from '../src/addons/autocomplete/suggestions.ts'

const fixtureDirectory = new URL(
  '../tests/fixtures/autocomplete/',
  import.meta.url,
)
const topK = 3
const digest = (text) => createHash('sha256').update(text).digest('hex')
const wordKey = (word) => word.normalize('NFC').toLowerCase()

export function textItems(text) {
  return [...text.matchAll(/[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu)].map(
    (match) => {
      const before = text.slice(0, match.index)
      return { word: match[0], before, context: precedingWords(before) }
    },
  )
}

function requests(item, nextWordOnly = false) {
  const result = []
  const prefix = item.word.slice(0, 3)
  if (
    !nextWordOnly &&
    item.word.length > 3 &&
    prefixAt(item.before + prefix, '') === prefix
  )
    result.push({ kind: 'prefix', prefix })
  if (/[ \t]$/.test(item.before) && item.context.length)
    result.push({ kind: 'nextWord', prefix: '' })
  return result
}

const queryKey = (item, prefix) => JSON.stringify([prefix, item.context])
function metrics() {
  return {
    fired: 0,
    topOneHits: 0,
    topKHits: 0,
    charactersSaved: 0,
    timings: [],
  }
}
function pair() {
  return { baseline: metrics(), personal: metrics() }
}
function modes() {
  return Object.fromEntries(
    ['prefix', 'nextWord'].map((kind) => [
      kind,
      {
        ...pair(),
        firstTime: pair(),
        unseenTrainingTarget: pair(),
      },
    ]),
  )
}
function record(result, target, prefix, elapsed, metric) {
  metric.timings.push(elapsed)
  if (result.length) metric.fired++
  if (result[0] === target) {
    metric.topOneHits++
    metric.charactersSaved += Math.max(0, target.length - prefix.length - 1)
  }
  if (result.slice(0, topK).includes(target)) metric.topKHits++
}
function summary(metric) {
  const timings = [...metric.timings].sort((a, b) => a - b)
  const samples = timings.length
  return {
    samples,
    fired: metric.fired,
    fireRate: samples ? metric.fired / samples : 0,
    precision: metric.fired ? metric.topOneHits / metric.fired : 0,
    topOneHits: metric.topOneHits,
    topOneRate: samples ? metric.topOneHits / samples : 0,
    topKHits: metric.topKHits,
    topKRate: samples ? metric.topKHits / samples : 0,
    charactersSaved: metric.charactersSaved,
    latency: {
      samples,
      meanMs: samples ? timings.reduce((a, b) => a + b) / samples : 0,
      p50Ms: timings[Math.floor(samples * 0.5)] ?? 0,
      p95Ms: timings[Math.floor(samples * 0.95)] ?? 0,
      maxMs: timings.at(-1) ?? 0,
    },
  }
}
function summarizePair(value) {
  return {
    baseline: summary(value.baseline),
    personal: summary(value.personal),
  }
}
function summarizeModes(value) {
  return Object.fromEntries(
    Object.entries(value).map(([kind, metric]) => [
      kind,
      {
        ...summarizePair(metric),
        firstTime: summarizePair(metric.firstTime),
        unseenTrainingTarget: summarizePair(metric.unseenTrainingTarget),
      },
    ]),
  )
}

/** One pass through training prose, then read-only queries from different prose. */
export async function evaluateCorpus(
  corpus,
  complete,
  createModel = createPersonalModel,
  { nextWordOnly = false } = {},
) {
  const training = (corpus.trainingDocuments ?? [corpus.training]).flatMap(
    textItems,
  )
  const heldOut = (corpus.heldOutDocuments ?? [corpus.heldOut]).flatMap(
    textItems,
  )
  assert.ok(
    training.length && heldOut.length,
    'both text segments must contain words',
  )
  assert.notDeepEqual(
    training.map((item) => item.word),
    heldOut.map((item) => item.word),
    'held-out tokens must differ from training tokens',
  )
  let time = 1_000_000
  const model = createModel({ now: () => time })
  const session = { scope: corpus.scope, languages: corpus.languages }
  const trainingKeys = { prefix: new Set(), nextWord: new Set() }
  for (const item of training) {
    time += 250
    model.observe({
      ...session,
      word: item.word,
      context: item.context,
      kind: 'typed',
    })
    for (const { kind, prefix } of requests(item, nextWordOnly))
      trainingKeys[kind].add(queryKey(item, prefix))
  }
  const frozen = model.snapshot()
  const trainedWords = new Set(training.map((item) => wordKey(item.word)))
  const seen = {
    prefix: new Set(trainingKeys.prefix),
    nextWord: new Set(trainingKeys.nextWord),
  }
  const queries = modes()
  const counts = {
    prefix: {
      trainingUniqueKeys: trainingKeys.prefix.size,
      heldOutUniqueKeys: new Set(),
      unseenTrainingQueryOccurrences: 0,
    },
    nextWord: {
      trainingUniqueKeys: trainingKeys.nextWord.size,
      heldOutUniqueKeys: new Set(),
      unseenTrainingQueryOccurrences: 0,
    },
  }
  const completions = new Map()
  // Time stays fixed, and no evaluation target is ever observed.
  for (const item of heldOut) {
    for (const { kind, prefix } of requests(item, nextWordOnly)) {
      const key = queryKey(item, prefix)
      const firstTime = !seen[kind].has(key)
      seen[kind].add(key)
      counts[kind].heldOutUniqueKeys.add(key)
      if (!trainingKeys[kind].has(key))
        counts[kind].unseenTrainingQueryOccurrences++
      const unseenTarget = !trainedWords.has(wordKey(item.word))
      if (prefix && !completions.has(prefix))
        completions.set(prefix, await complete(prefix, corpus))
      const found = completions.get(prefix) ?? []
      const start = performance.now()
      const ranked = prefix ? rankWords(prefix, found) : []
      const baselineElapsed = performance.now() - start
      const personalStart = performance.now()
      const suggested = model.suggest({
        ...session,
        context: item.context,
        prefix,
        baseline: ranked,
      })
      const personalElapsed = performance.now() - personalStart
      const baseline = ranked.map((item) =>
        insertionText(prefix, item.word, 'baseline'),
      )
      const personal = suggested.map((item) =>
        insertionText(prefix, item.word, item.source),
      )
      for (const group of [
        queries[kind],
        ...(firstTime ? [queries[kind].firstTime] : []),
        ...(unseenTarget ? [queries[kind].unseenTrainingTarget] : []),
      ]) {
        record(baseline, item.word, prefix, baselineElapsed, group.baseline)
        record(personal, item.word, prefix, personalElapsed, group.personal)
      }
    }
  }
  assert.deepEqual(
    model.snapshot(),
    frozen,
    'evaluation must not change the trained model',
  )
  return {
    metrics: queries,
    report: {
      name: corpus.name,
      description: corpus.description,
      source: corpus.source,
      scope: corpus.scope,
      languages: corpus.languages,
      training: {
        tokens: training.length,
        sha256: digest(corpus.training),
        snapshotEntries: frozen.entries.length,
      },
      heldOut: {
        tokens: heldOut.length,
        sha256: digest(corpus.heldOut),
        unseenTrainingTargetTokens: heldOut.filter(
          (item) => !trainedWords.has(wordKey(item.word)),
        ).length,
      },
      modelFrozen: true,
      queries: summarizeModes(queries),
      queryCounts: Object.fromEntries(
        Object.entries(counts).map(([kind, count]) => [
          kind,
          {
            ...count,
            heldOutUniqueKeys: count.heldOutUniqueKeys.size,
            firstTimeQueries: queries[kind].firstTime.personal.timings.length,
          },
        ]),
      ),
    },
  }
}

export function repositoryProse(text) {
  return text
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/`[^`]*`/g, '\n')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/^[#>|*-]+[ \t]*/gm, '')
}

export function repositoryCorpus() {
  const {
    source,
    trainingFiles,
    heldOutFiles,
    trainingDocuments,
    heldOutDocuments,
  } = JSON.parse(
    readFileSync(
      new URL(
        '../tests/fixtures/autocomplete-repository.json',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  return {
    name: 'repository documentation',
    scope: 'repository',
    languages: ['en'],
    source,
    training: trainingDocuments.join('\n\n'),
    heldOut: heldOutDocuments.join('\n\n'),
    trainingDocuments,
    heldOutDocuments,
    trainingFiles,
    heldOutFiles,
    dictionary: {
      en: [
        ...new Set(
          trainingDocuments
            .flatMap(textItems)
            .map((item) => wordKey(item.word)),
        ),
      ],
    },
  }
}

export function assertNextWordQuality(report) {
  const metric = report.queries.nextWord.personal
  assert.ok(
    metric.fired > 0,
    'next-word replay must produce nonzero predictions',
  )
  assert.ok(metric.fireRate <= 0.05, 'next-word fire rate must not exceed 5%')
  assert.ok(metric.precision >= 0.4, 'next-word precision must reach 40%')
}

export async function replayRepository(
  complete = fixtureComplete,
  createModel = createPersonalModel,
  options,
) {
  const corpus = repositoryCorpus()
  assert.equal(
    new Set([...corpus.trainingFiles, ...corpus.heldOutFiles]).size,
    corpus.trainingFiles.length + corpus.heldOutFiles.length,
    'training and held-out files must be disjoint',
  )
  const { report } = await evaluateCorpus(
    corpus,
    complete,
    createModel,
    options,
  )
  report.training.files = corpus.trainingFiles
  report.heldOut.files = corpus.heldOutFiles
  assert.ok(
    report.heldOut.tokens >= 10_000,
    'repository held-out corpus must contain at least 10000 tokens',
  )
  assertNextWordQuality(report)
  return report
}

export function fixtureComplete(prefix, corpus) {
  return corpus.languages.map((lang) => ({
    lang,
    // Match the pack's alphabetical, bounded candidate list, not target frequency.
    words: (corpus.dictionary[lang] ?? [])
      .filter((word) => wordKey(word).startsWith(wordKey(prefix)))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, 24),
  }))
}

async function dictionary(roots, fixturesOnly) {
  const sources = []
  const installed = new Map()
  if (!fixturesOnly) {
    for (const lang of ['en', 'tl', 'fr', 'de']) {
      const directory = roots
        .map((root) => join(root, lang))
        .find((path) => existsSync(join(path, 'manifest.json')))
      if (!directory) continue
      const manifest = JSON.parse(
        readFileSync(join(directory, 'manifest.json'), 'utf8'),
      )
      assert.equal(
        manifest.id,
        lang,
        'pack manifest language must match directory',
      )
      assert.equal(manifest.format, 1, 'unsupported installed pack format')
      installed.set(lang, directory)
      sources.push({
        lang,
        kind: 'installed-pack',
        directory,
        entries: manifest.entries,
        installedAt: manifest.installedAt,
        data: manifest.data,
        index: manifest.index,
        sources: manifest.sources,
      })
    }
  }
  let index
  if (installed.size) {
    // Reuse the production read-only pack reader without building Electron output.
    // One bundle carries its relative imports, which a data: module cannot resolve.
    const { build } = await import('esbuild')
    const { outputFiles } = await build({
      entryPoints: [
        fileURLToPath(
          new URL('../src/addons/dictionary/pack-index.ts', import.meta.url),
        ),
      ],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
    })
    const { PackIndex } = await import(
      `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`
    )
    index = new PackIndex()
    for (const [lang, directory] of installed)
      await index.preload(lang, directory)
  }
  for (const lang of ['en', 'tl', 'fr', 'de'])
    if (!installed.has(lang))
      sources.push({
        lang,
        kind: 'fixture-fallback',
        reason: fixturesOnly
          ? 'explicit --fixture-dictionaries'
          : 'no installed pack found in searched roots',
        path: 'tests/fixtures/autocomplete/*.json',
      })
  return {
    report: {
      searchedRoots: fixturesOnly ? [] : roots,
      sources,
      installedLanguages: [...installed.keys()],
      candidateLimitPerLanguage: 24,
    },
    async complete(prefix, corpus) {
      const found = []
      for (const lang of corpus.languages)
        found.push({
          lang,
          words: installed.has(lang)
            ? await index.complete(lang, installed.get(lang), prefix, 24)
            : fixtureComplete(prefix, { ...corpus, languages: [lang] })[0]
                .words,
        })
      return found
    },
    close: () => index?.unload(),
  }
}

export async function replay({
  roots = [
    join(homedir(), 'Library/Application Support/hibi/dictionary-packs'),
    join(homedir(), 'Library/Application Support/hibi-dev/dictionary-packs'),
  ],
  fixturesOnly = false,
  createModel = createPersonalModel,
} = {}) {
  const packs = await dictionary(roots, fixturesOnly)
  const aggregate = modes()
  const corpora = []
  let repository
  // Warm only throwaway data; evaluated models are independently trained.
  const warm = createPersonalModel({ now: () => 1_000_000 })
  const baseline = rankWords('pre', [
    { lang: 'en', words: ['prefix', 'prefer', 'present'] },
  ])
  warm.observe({
    scope: null,
    languages: ['en'],
    word: 'prefix',
    kind: 'typed',
  })
  for (let i = 0; i < 200; i++)
    warm.suggest({ scope: null, languages: ['en'], prefix: 'pre', baseline })
  try {
    repository = await replayRepository(packs.complete, createModel)
    for (const file of readdirSync(fixtureDirectory)
      .filter((name) => name.endsWith('.json'))
      .sort()) {
      const corpus = JSON.parse(
        readFileSync(new URL(file, fixtureDirectory), 'utf8'),
      )
      const result = await evaluateCorpus(corpus, packs.complete)
      corpora.push({
        fixture: `tests/fixtures/autocomplete/${file}`,
        ...result.report,
      })
      for (const kind of ['prefix', 'nextWord'])
        for (const group of ['', 'firstTime', 'unseenTrainingTarget'])
          for (const mode of ['baseline', 'personal']) {
            const from = group
              ? result.metrics[kind][group][mode]
              : result.metrics[kind][mode]
            const to = group
              ? aggregate[kind][group][mode]
              : aggregate[kind][mode]
            for (const key of [
              'fired',
              'topOneHits',
              'topKHits',
              'charactersSaved',
            ])
              to[key] += from[key]
            to.timings.push(...from.timings)
          }
    }
  } finally {
    await packs.close()
  }
  return {
    samples:
      aggregate.prefix.personal.timings.length +
      aggregate.nextWord.personal.timings.length,
    topK,
    method:
      'distinct synthetic training and held-out prose; one typed observation per training token; frozen time and model during evaluation; real rankWords baseline; exact-case insertion top1/top3; save counts subtract one acceptance key',
    definitions: {
      prefix:
        'one query after three Latin-script characters for each eligible held-out word longer than three characters',
      fireRate:
        'nonempty suggestion lists divided by eligible queries, separately per mode',
      precision:
        'exact-case top-one insertion hits divided by nonempty suggestion lists',
      repository:
        'separate file-held-out documentation evaluation; fixture prefix vocabulary is training-only; default production entry cap; no evaluation learning',
      nextWord:
        'one empty-prefix query before each held-out word after whitespace with contiguous preceding word context; dictionary baseline is empty',
      firstTime:
        'first held-out occurrence of a query key never present in training or earlier evaluation; key = scope, language order, mode, exact prefix, exact preceding up-to-two words; target excluded; scope and languages fixed per corpus',
      unseenTrainingTarget:
        'all query occurrences whose target, NFC-normalized and lowercased, never occurs in training',
      charactersSaved:
        'top1 exact insertion only: max(0, target UTF-16 length - prefix length - 1 acceptance key); top3 navigation and acceptance are not credited',
    },
    machine: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    dictionary: packs.report,
    queries: summarizeModes(aggregate),
    rankingBudgetMs: 5,
    meetsRankingBudget: Object.values(aggregate).every(
      (metric) => summary(metric.personal).latency.p95Ms < 5,
    ),
    corpora,
    repository,
    limitations: [
      'Small original synthetic passages plus a separate repository-documentation check; neither measures real-world acceptance.',
      'Frozen documentation files can share vocabulary and templates. Fixture prose and whole-file split are fixed; source paths are provenance only. Text hashes identify the snapshot.',
      'Repository prefix fallback uses training vocabulary, not a full dictionary; installed packs are used when available.',
      'Shared training and held-out vocabulary is deliberate; unseen query contexts and unseen target words are counted separately.',
      'Each target may have both a prefix and a next-word query; compare those modes separately, never sum their save counts as document savings.',
      'Top1/top3 exact insertion matches are proxies, not observed acceptance; no evaluation feedback or correction events are simulated.',
      'Personal latency is additional to rankWords latency; pack retrieval, UI, persistence, boundary observation and cold startup costs are excluded.',
      'Training words are treated as individually typed and committed; multilingual membership is configured per passage, not inferred.',
      'Installed pack metadata and checksums are reported from manifests; PackIndex validates loaded index structure, but this replay does not rehash pack data.',
    ],
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const roots = process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('--pack-root='))
    .map((arg) => arg.slice('--pack-root='.length))
  console.log(
    JSON.stringify(
      await replay({
        ...(roots.length ? { roots } : {}),
        fixturesOnly: process.argv.includes('--fixture-dictionaries'),
      }),
      null,
      2,
    ),
  )
}
