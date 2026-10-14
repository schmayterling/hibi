# performance audit: october 2026

## workspace index scheduling

on october 14, the reference-index parse loop gained a four-millisecond budget between pages while retaining its 64-page ceiling. after each yield, canceled work or a replaced snapshot is rejected before another page is parsed. the final atomic publication check remains in place.

this records the measured [index implementation](../../src/main/workspace-reference-index.ts) and its [regressions](../../tests/workspace-reference-index.test.mjs). native startup, first input, hidden-window memory and cpu remain outside these measurements.

### paired results

both implementations ran in one node.js v24.14.0 process with the same baseline parser, explicit syntax settings and fixture objects. each implementation received a small warmup. three pairs per fixture alternated baseline/candidate, candidate/baseline, then baseline/candidate.

all values below are median milliseconds across three runs.

| fixture | metric | baseline | candidate |
| --- | --- | ---: | ---: |
| 128 notes × 2,048 characters | first timer delay | 8.097 | 4.192 |
| 128 notes × 2,048 characters | longest uninterrupted slice | 7.859 | 4.098 |
| 128 notes × 2,048 characters | full completion | 17.491 | 16.530 |
| 63 notes × 300,000 characters | first timer delay | 410.969 | 14.106 |
| 63 notes × 300,000 characters | longest uninterrupted slice | 410.213 | 8.412 |
| 63 notes × 300,000 characters | full completion | 410.213 | 441.705 |

the large baseline never yielded; the candidate yielded after each page. its longest single-page parse was 11.312 ms. parser callbacks accounted for 97.24–99.60% of baseline completion time and 97.89–98.62% of candidate completion time. these are elapsed intervals, including scheduling effects.

the change improves opportunities for other work to run. large-fixture completion did not improve, and these results establish no total-cpu or memory reduction. a single page can exceed the budget. tag/property parsing and later resolution stages were not changed.

the large-fixture first-timer samples were 906.686, 337.583 and 410.969 ms for baseline; 20.112, 8.083 and 14.106 ms for candidate. an earlier separate cold pilot took 7,011.173 ms with no yield for 63 pages; it is not a matched before/after result. host contention and warmup materially affect absolute times. three samples do not establish a stable p95 or a user-interface latency guarantee.

### provenance and validation

the baseline checkout was commit `7a137cfe9d6c6bc0fbb78cb4169bd71ccd09ca0b`. the candidate was an uncommitted index file identified by its content hash below. the shared parser prevents unrelated candidate syntax changes from affecting this comparison.

| artifact | sha-256 |
| --- | --- |
| baseline `workspace-reference-index.ts` | `983826e372d7ce2f7978b795e433211a864641dfb24549dc18e051d980bf33f0` |
| candidate `workspace-reference-index.ts` | `5572e556cb52948715172c0d95fd67b5c765c985352d126e37c505e785fd2ebe` |
| shared baseline `note-syntax.ts` | `47b0d636eac1ea8c86e7cd0f418d20cca35d2bcf1345db49b435df16665531e6` |
| paired driver, embedded below | `0aeeb0dd3f4daf2f87e8eeb1aa18302149c838ce559bf343503d0b06588d89b7` |
| paired raw json | `0df76f22880c7f3ecb353db444817c90f1e67e4a44ec8c98c1205f5e0a2364b2` |
| initial pilot raw json | `7150d7e95c8353f7de1188b3db82ab2516f4e70eb818c54d49c3b065487d3283` |

the raw files were `/tmp/hibi-index-paired-20e900b9.json` and `/tmp/hibi-index-baseline-pilot-20e900b9.json`, also handed off with the audit. temporary paths are not permanent artifact storage; the embedded driver and recorded samples remain available here.

all 18 focused reference-index tests passed, including slow-page publication, cancellation and snapshot replacement. scoped formatting and whitespace checks passed. no electron launch, build, cpu profile or full application check ran for this measurement. the macos host was not isolated from other work; power and thermal conditions were not captured. see the [measurement conventions](development/performance.md) for broader validation.

### reproduce

restore the baseline commit and the candidate index content identified above in separate checkouts. save the following unchanged block as `/tmp/hibi-index-paired-2026-10.mjs`, then run:

```sh
node /tmp/hibi-index-paired-2026-10.mjs > /tmp/hibi-index-paired-2026-10.json
```

the original driver uses absolute checkout paths. adjust only its `baseline` and `candidate` constants for another machine, and record the resulting driver hash. verify both index hashes before comparing current checkouts. no app build is required.

```mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const baseline = '/Users/may/Workspaces/hibi'
const candidate = '/tmp/hibi-audit-20e900b9'
const load = (root, file) => import(pathToFileURL(`${root}/${file}`))
const classes = {
  baseline: (await load(baseline, 'src/main/workspace-reference-index.ts')).WorkspaceReferenceIndex,
  candidate: (await load(candidate, 'src/main/workspace-reference-index.ts')).WorkspaceReferenceIndex,
}
// Use one parser and syntax for both revisions: other in-flight fixes are not this experiment.
const { noteReferences } = await load(baseline, 'src/shared/note-links.ts')
const { defaultNoteSyntax } = await load(baseline, 'src/shared/note-syntax.ts')
const syntax = () => ({ settings: defaultNoteSyntax, key: 'paired', unsupported: false, complete: true })
const target = { workspaceId: 'paired', workspaceGeneration: 1 }
const fixture = (count, units) => Array.from({ length: count }, (_, i) => {
  const prefix = `# page ${i}\n\n[next](p${(i + 1) % count}.md)\n\n`
  return { id: String(i), path: `p${i}.md`, markdown: prefix + 'word '.repeat(Math.ceil(units / 5)).slice(0, units - prefix.length) }
})
async function measure(label, pages, round) {
  let parsed = 0, parseMs = 0, maximumParseMs = 0, started, resumed, yieldWaitMs = 0
  const yields = []
  const index = new classes[label]((source, settings) => {
    const before = performance.now()
    const result = noteReferences(source, settings)
    const elapsed = performance.now() - before
    parsed++
    parseMs += elapsed
    maximumParseMs = Math.max(maximumParseMs, elapsed)
    return result
  }, async () => {
    const before = performance.now()
    yields.push({ atMs: before - started, parsed, sliceMs: before - resumed })
    await new Promise((resolve) => setImmediate(resolve))
    resumed = performance.now()
    yieldWaitMs += resumed - before
  })
  started = resumed = performance.now()
  const timer = new Promise((resolve) => setTimeout(() => resolve(performance.now() - started), 0))
  const pending = index.applyCooperatively(target, pages, syntax)
  const synchronousEntryMs = performance.now() - started
  const result = await pending
  const totalMs = performance.now() - started
  const finalSliceMs = performance.now() - resumed
  const timerMs = await timer
  assert.deepEqual(result, { parsed: pages.length, resolved: pages.length })
  assert.deepEqual(index.links('p0.md', 0, 10).items, ['p1.md'])
  return { label, round, pages: pages.length, units: pages[0].markdown.length, synchronousEntryMs,
    totalMs, timerMs, parseMs, maximumParseMs, yieldWaitMs,
    maximumSliceMs: Math.max(finalSliceMs, ...yields.map((y) => y.sliceMs)), yields }
}
for (const label of Object.keys(classes)) await measure(label, fixture(2, 2048), -1)
const samples = []
for (const pages of [fixture(128, 2048), fixture(63, 300000)]) {
  for (let round = 0; round < 3; round++) {
    for (const label of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      samples.push(await measure(label, pages, round))
      process.stderr.write(`${label} ${pages.length} pages round ${round + 1} complete\n`)
    }
  }
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hashes = {}
for (const [label, root] of Object.entries({ baseline, candidate }))
  hashes[label] = sha(await readFile(`${root}/src/main/workspace-reference-index.ts`))
console.log(JSON.stringify({ node: process.version, hashes,
  parserSha256: sha(await readFile(`${baseline}/src/shared/note-syntax.ts`)),
  scriptSha256: sha(await readFile(new URL(import.meta.url))),
  scope: 'same-process Node index; shared baseline parser/syntax and fixtures; alternated pair order; no Electron, UI, CPU profile, build or RAM claim', samples }, null, 2))
```
