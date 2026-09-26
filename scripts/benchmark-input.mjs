import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  benchmarkDocuments,
  launchBenchmarkApp,
  openBenchmarkDocument,
  selectBenchmarkFile,
  typeCharacter,
  waitForEditor,
} from './benchmark-flows.mjs'

const runs = Number(process.env.HIBI_INPUT_RUNS ?? 5)
if (!Number.isInteger(runs) || runs < 1 || runs > 50)
  throw new Error('Use 1–50 runs.')
const foreground = process.env.HIBI_BENCH_FOREGROUND === '1'
const analysisLoad = process.env.HIBI_INPUT_ANALYSIS === '1'
const directory = await mkdtemp(join(tmpdir(), 'hibi-input-bench-'))
const allFixtures = [
  { name: 'blank.md', title: '', source: '' },
  ...benchmarkDocuments,
]
const fixtures = process.env.HIBI_INPUT_FIXTURE
  ? allFixtures.filter(({ name }) => name === process.env.HIBI_INPUT_FIXTURE)
  : allFixtures
if (!fixtures.length) throw new Error('Unknown input benchmark fixture.')
const samples = []
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[
    Math.max(0, Math.ceil(values.length * p) - 1)
  ] ?? null
try {
  for (const fixture of fixtures) {
    const file = join(directory, fixture.name)
    await writeFile(file, fixture.source)
    for (let run = 0; run < runs; run++) {
      const profile = join(directory, `${fixture.name}-${run}`)
      await mkdir(profile)
      if (analysisLoad) {
        const addon = join(profile, 'installed-addons', 'analysis-load')
        await mkdir(addon, { recursive: true })
        await writeFile(
          join(profile, 'addons.json'),
          JSON.stringify({ 'analysis-load': true }),
        )
        await writeFile(
          join(addon, 'hibi-addon.json'),
          JSON.stringify({
            id: 'analysis-load',
            name: 'Analysis benchmark',
            description: 'Benchmark-only analysis load',
            kind: 'extension',
            apiVersion: 2,
            version: '1.0.0',
            authors: [{ displayName: 'Hibi benchmark' }],
            capabilities: [],
            entry: 'index.js',
            analysis: { entry: 'analysis.js' },
          }),
        )
        await writeFile(
          join(addon, '.hibi-install.json'),
          JSON.stringify({
            hash: 'a'.repeat(64),
            files: ['index.js', 'analysis.js', 'hibi-addon.json'],
            source: 'local',
          }),
        )
        await writeFile(
          join(addon, 'index.js'),
          'export default () => ({start(context) { window.__hibiAnalysisBenchmark = context; }})',
        )
        await writeFile(
          join(addon, 'analysis.js'),
          'export function analyze() { const end = performance.now() + 2000; while (performance.now() < end) {} return null; }',
        )
      }
      const app = await launchBenchmarkApp(profile)
      try {
        const page = await app.firstWindow()
        if (foreground)
          await app.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0]
            window.setFocusable(true)
            window.show()
            window.focus()
          })
        await waitForEditor(page)
        if (foreground)
          await page.waitForFunction(() => document.hasFocus(), undefined, {
            timeout: 5000,
          })
        if (fixture.title) {
          await selectBenchmarkFile(app, file)
          await openBenchmarkDocument(app, page, fixture.title)
        }
        // Test-only instrumentation: none of these wrappers ship in Hibi.
        if (analysisLoad) {
          await page.waitForFunction(() => window.__hibiAnalysisBenchmark)
          await page.evaluate(() => {
            const context = window.__hibiAnalysisBenchmark
            window.__hibiAnalysisRun = context.analysis.run(
              context.editor.getTextProjection(),
            )
          })
          // A ready host has sent the job to the isolated worker before typing begins.
          for (let attempt = 0; attempt < 100; attempt++) {
            const ready = await app.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows().some(
                (window) =>
                  window.webContents.getURL().startsWith('hibi-analysis:') &&
                  !window.webContents.isLoading(),
              ),
            )
            if (ready) break
            if (attempt === 99)
              throw new Error('Analysis benchmark did not start.')
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
        }
        await page.evaluate(() => {
          const element = document.querySelector('.tiptap')
          const editor = element.editor
          const measurements = {
            transactions: [],
            can: 0,
            serializations: 0,
            lastInput: null,
          }
          window.__hibiInputMeasurements = measurements
          const can = editor.can.bind(editor),
            serialize = editor.getMarkdown.bind(editor)
          editor.can = (...args) => {
            measurements.can++
            return can(...args)
          }
          editor.getMarkdown = (...args) => {
            measurements.serializations++
            return serialize(...args)
          }
          element.addEventListener(
            'beforeinput',
            () => {
              measurements.lastInput = performance.now()
            },
            true,
          )
          const dispatch = editor.view.props.dispatchTransaction
          editor.view.setProps({
            dispatchTransaction(transaction) {
              const start = performance.now(),
                can = measurements.can,
                serializations = measurements.serializations
              try {
                dispatch.call(this, transaction)
              } finally {
                if (
                  transaction.docChanged &&
                  measurements.transactions.length < 256
                ) {
                  measurements.transactions.push({
                    cpuMs: performance.now() - start,
                    inputToModelMs:
                      measurements.lastInput === null
                        ? null
                        : performance.now() - measurements.lastInput,
                    canChecks: measurements.can - can,
                    serializations:
                      measurements.serializations - serializations,
                  })
                  measurements.lastInput = null
                }
              }
            },
          })
        })
        const input = page.getByRole('textbox', {
          name: 'Document editor',
          exact: true,
        })
        const driver = []
        for (let key = 0; key < 20; key++) {
          const previous = await input.textContent()
          const start = performance.now()
          await typeCharacter(page, previous, key ? 'a' : 'x')
          driver.push(performance.now() - start)
        }
        const measured = await page.evaluate(
          () => window.__hibiInputMeasurements,
        )
        samples.push({ fixture: fixture.name, run, driver, ...measured })
        if (analysisLoad) {
          const result = await page.evaluate(() => window.__hibiAnalysisRun)
          if (!['stale', 'complete'].includes(result.status))
            throw new Error(`Analysis benchmark failed: ${result.message}`)
        }
      } finally {
        await app.close()
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        runtime: process.version,
        platform: process.platform,
        arch: process.arch,
        foreground,
        analysisLoad,
        endpoints: {
          driver:
            process.env.HIBI_BENCH_INSERT_TEXT === '1'
              ? 'editor.focus plus keyboard.insertText through changed editor DOM text; identical endpoint for first and subsequent inserts'
              : 'locator.press through changed editor DOM text; identical endpoint for first and subsequent keys',
          cpu: 'ProseMirror dispatchTransaction, including synchronous host/addon listeners and instrumentation overhead',
          inputToModel:
            'beforeinput capture through completed document-changing dispatch; not physical presentation',
        },
        summary: fixtures.map((fixture) => {
          const group = samples.filter(
            (sample) => sample.fixture === fixture.name,
          )
          const transactions = group.flatMap((sample) => sample.transactions)
          return {
            fixture: fixture.name,
            runs: group.length,
            cpuMedian: percentile(
              transactions.map((sample) => sample.cpuMs),
              0.5,
            ),
            cpuP95: percentile(
              transactions.map((sample) => sample.cpuMs),
              0.95,
            ),
            inputToModelP95: percentile(
              transactions.flatMap((sample) =>
                sample.inputToModelMs === null ? [] : [sample.inputToModelMs],
              ),
              0.95,
            ),
            firstDriverP95: percentile(
              group.map((sample) => sample.driver[0]),
              0.95,
            ),
            subsequentDriverP95: percentile(
              group.flatMap((sample) => sample.driver.slice(1)),
              0.95,
            ),
            canChecksPerTransaction:
              transactions.reduce((sum, sample) => sum + sample.canChecks, 0) /
              transactions.length,
            serializationsPerTransaction:
              transactions.reduce(
                (sum, sample) => sum + sample.serializations,
                0,
              ) / transactions.length,
          }
        }),
        samples,
      },
      null,
      2,
    ),
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
