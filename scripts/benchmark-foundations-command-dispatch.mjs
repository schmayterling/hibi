import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { clickMenu } from '../tests/keyboard.mjs'
import {
  launchBenchmarkApp,
  openBenchmarkDocument,
  selectBenchmarkFile,
} from './benchmark-flows.mjs'

// Build first, then run alone with Node 24: node scripts/benchmark-foundations-command-dispatch.mjs
const runs = Number(
  process.argv.find((arg) => arg.startsWith('--runs='))?.slice(7) ?? 50,
)
const warmup = Number(
  process.argv.find((arg) => arg.startsWith('--warmup='))?.slice(9) ?? 10,
)
if (!Number.isSafeInteger(runs) || runs < 5 || runs > 200)
  throw new Error('Use --runs=5..200.')
if (!Number.isSafeInteger(warmup) || warmup < 0 || warmup > 100)
  throw new Error('Use --warmup=0..100.')

const percentile = (sorted, fraction) =>
  sorted[Math.ceil(sorted.length * fraction) - 1]
const distribution = (samples) => {
  const sorted = [...samples].sort((left, right) => left - right)
  return {
    rawMs: samples,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  }
}

const profile = await mkdtemp(join(tmpdir(), 'hibi-foundations-command-'))
let app
try {
  const addon = join(profile, 'installed-addons', 'foundations-command-bench')
  const file = join(profile, 'command-benchmark.md')
  await mkdir(addon, { recursive: true })
  await writeFile(
    file,
    '# Command benchmark\n\nA note for command target capture.\n',
  )
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'foundations-command-bench',
      name: 'Foundations command benchmark',
      description: 'Command dispatch benchmark fixture.',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Benchmark' }],
      entry: 'index.js',
      capabilities: [],
      activation: 'command',
      commands: [{ id: 'run', label: 'Benchmark addon command' }],
    }),
  )
  await writeFile(
    join(addon, 'index.js'),
    `window.foundationCommandEvaluations = (window.foundationCommandEvaluations ?? 0) + 1;
export default () => ({ start(context) {
  window.foundationCommandStarts = (window.foundationCommandStarts ?? 0) + 1;
  context.commands.register({
    id: 'run', label: 'Benchmark addon command',
    run(invocation) {
      const end = performance.now();
      const probe = window.foundationCommandBench;
      const start = probe.clicks.shift();
      probe.callbacks.push({
        milliseconds: start === undefined ? null : end - start,
        source: invocation.source,
        documentId: invocation.document?.documentId ?? null,
      });
    },
  });
} });`,
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'foundations-command-bench': true }),
  )

  app = await launchBenchmarkApp(profile)
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.locator('.titlebar').waitFor()
  await selectBenchmarkFile(app, file)
  await openBenchmarkDocument(app, page, 'Command benchmark')
  await page.evaluate(() => {
    window.foundationCommandBench = { clicks: [], captured: 0, callbacks: [] }
    document.addEventListener(
      'click',
      (event) => {
        if (
          event.isTrusted &&
          event.target instanceof Element &&
          event.target.closest('[role="option"]')?.id ===
            'command-foundations-command-bench.run'
        ) {
          const start = performance.now()
          window.foundationCommandBench.captured++
          window.foundationCommandBench.clicks.push(start)
        }
      },
      true,
    )
  })
  assert.equal(
    await page.evaluate(() => window.foundationCommandEvaluations),
    undefined,
    'command addon evaluated before its first invocation',
  )

  const option = page.locator(
    '[role="option"][id="command-foundations-command-bench.run"]',
  )
  for (let index = 0; index < 1 + warmup + runs; index++) {
    await clickMenu(app, 'Command palette')
    await page
      .getByRole('combobox', { name: /search commands/i })
      .fill('Benchmark addon command')
    await option.click()
    await page.waitForFunction(
      (count) => window.foundationCommandBench.callbacks.length === count,
      index + 1,
    )
  }

  const probe = await page.evaluate(() => ({
    ...window.foundationCommandBench,
    evaluations: window.foundationCommandEvaluations,
    starts: window.foundationCommandStarts,
  }))
  const electronVersion = await app.evaluate(() => process.versions.electron)
  assert.equal(probe.captured, 1 + warmup + runs)
  assert.equal(probe.clicks.length, 0)
  assert.equal(probe.callbacks.length, probe.captured)
  assert.equal(probe.evaluations, 1)
  assert.equal(probe.starts, 1)
  const documentId = probe.callbacks[0].documentId
  assert.ok(documentId, 'command did not retain document target')
  for (const sample of probe.callbacks) {
    assert.equal(sample.source, 'palette')
    assert.equal(sample.documentId, documentId)
    assert.ok(Number.isFinite(sample.milliseconds))
    assert.ok(sample.milliseconds >= 0)
  }

  const measured = probe.callbacks
    .slice(1 + warmup)
    .map(({ milliseconds }) => milliseconds)
  console.log(
    JSON.stringify(
      {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        node: process.version,
        electron: electronVersion,
        platform: platform(),
        arch: arch(),
        scope:
          'renderer performance.now() from trusted command-palette option click capture to installed-addon command callback entry; includes palette close, next-task scheduling, context capture, and command routing',
        conditions:
          'built development app, one open note, reduced-motion palette, Playwright-synthesized clicks, one lazy command addon',
        exclusions:
          'not pure registry dispatch, physical input latency, paint, packaged-app startup, or a baseline comparison',
        coldFirstUseMs: probe.callbacks[0].milliseconds,
        coldFirstUseIncludesActivation: true,
        warmup,
        runs,
        warm: distribution(measured),
        correctness: {
          capturedClicks: probe.captured,
          callbacks: probe.callbacks.length,
          addonEvaluations: probe.evaluations,
          addonStarts: probe.starts,
          source: 'palette',
          sameDocumentTarget: true,
        },
      },
      null,
      2,
    ),
  )
} finally {
  try {
    if (app) await app.close()
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
}
