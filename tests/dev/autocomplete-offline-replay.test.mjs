import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

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
      { cwd: new URL('../..', import.meta.url), encoding: 'utf8' },
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
