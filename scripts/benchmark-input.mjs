import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pressShortcut } from '../tests/keyboard.mjs'
import {
  benchmarkDocuments,
  launchBenchmarkApp,
  openBenchmarkDocument,
  selectBenchmarkFile,
  typeCharacter,
  waitForEditor,
  writeInputProfile,
} from './benchmark-flows.mjs'

const runs = Number(process.env.HIBI_INPUT_RUNS ?? 5)
if (!Number.isInteger(runs) || runs < 1 || runs > 50)
  throw new Error('Use 1–50 runs.')
const foreground = process.env.HIBI_BENCH_FOREGROUND === '1'
const analysisLoad = process.env.HIBI_INPUT_ANALYSIS === '1'
const emulateFocus = process.env.HIBI_BENCH_EMULATE_FOCUS === '1'
const findQuery = process.env.HIBI_INPUT_FIND ?? ''
const arrows = process.env.HIBI_INPUT_ARROWS === '1'
const enabledAddons = (process.env.HIBI_BENCH_ADDONS ?? '')
  .split(',')
  .filter(Boolean)
const mainThreadMetrics = [
  'TaskDuration',
  'ScriptDuration',
  'LayoutDuration',
  'RecalcStyleDuration',
]
const readMetrics = async (session) =>
  Object.fromEntries(
    (await session.send('Performance.getMetrics')).metrics
      .filter(({ name }) => mainThreadMetrics.includes(name))
      .map(({ name, value }) => [name, value]),
  )
const perKey = (before, after, keys) =>
  Object.fromEntries(
    mainThreadMetrics.map((name) => [
      name,
      ((after[name] - before[name]) * 1000) / keys,
    ]),
  )
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
      const requestedAddons = await writeInputProfile(
        profile,
        enabledAddons,
        analysisLoad,
      )
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
        const session = await page.context().newCDPSession(page)
        await session.send('Performance.enable')
        if (emulateFocus)
          await session.send('Emulation.setFocusEmulationEnabled', {
            enabled: true,
          })
        await waitForEditor(page)
        const effectiveAddons = (
          await page.evaluate(() => window.hibi.getAddonStates())
        )
          .filter(({ enabled, blockedBy }) => enabled && !blockedBy?.length)
          .map(({ id }) => id)
          .sort()
        for (const id of Object.keys(requestedAddons))
          assert.ok(
            effectiveAddons.includes(id),
            `Requested benchmark addon is not enabled: ${id}`,
          )
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
            formatCheckMs: 0,
            lastInput: null,
          }
          window.__hibiInputMeasurements = measurements
          const can = editor.can.bind(editor),
            isActive = editor.isActive.bind(editor),
            serialize = editor.getMarkdown.bind(editor)
          let depth = 0
          // Outermost formatting checks only, so nested isActive calls are not counted twice.
          const timed = (check) => {
            if (depth) return check()
            depth++
            const start = performance.now()
            try {
              return check()
            } finally {
              depth--
              measurements.formatCheckMs += performance.now() - start
            }
          }
          // Chained capability checks run when each command is called, after can() returns.
          const timedCommands = (commands) => {
            const proxy = new Proxy(commands, {
              get(target, property) {
                const value = target[property]
                if (typeof value !== 'function') return value
                return (...args) => {
                  const result = timed(() => value(...args))
                  return result === target
                    ? proxy
                    : property === 'chain'
                      ? timedCommands(result)
                      : result
                }
              },
            })
            return proxy
          }
          editor.can = (...args) => {
            measurements.can++
            return timedCommands(timed(() => can(...args)))
          }
          editor.isActive = (...args) => timed(() => isActive(...args))
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
        if (findQuery) {
          await pressShortcut(
            app,
            process.platform === 'darwin' ? 'Meta+f' : 'Control+f',
          )
          await page
            .getByRole('textbox', { name: 'Find in document', exact: true })
            .fill(findQuery)
          await page.waitForFunction(() =>
            /\/[1-9]/.test(
              document.querySelector('.find-count')?.textContent ?? '',
            ),
          )
        }
        if (process.env.HIBI_INPUT_AT === 'code')
          await page.evaluate(() => {
            const editor = document.querySelector('.tiptap').editor
            let position = null
            editor.state.doc.descendants((node, offset) => {
              if (position === null && node.type.name === 'codeBlock')
                position = offset + node.nodeSize - 1
              return position === null
            })
            editor.commands.focus(position)
          })
        const driver = []
        const typingStart = await readMetrics(session)
        const formatStart = await page.evaluate(() => ({
          ...window.__hibiInputMeasurements,
          transactions: undefined,
        }))
        for (let key = 0; key < 20; key++) {
          const previous = await input.textContent()
          const start = performance.now()
          await typeCharacter(page, previous, key ? 'a' : 'x')
          driver.push(performance.now() - start)
        }
        const measured = await page.evaluate(
          () => window.__hibiInputMeasurements,
        )
        const sample = {
          fixture: fixture.name,
          run,
          effectiveAddons,
          driver,
          mainThreadPerKey: perKey(typingStart, await readMetrics(session), 20),
          ...measured,
          canPerKey: (measured.can - formatStart.can) / 20,
          formatCheckMsPerKey:
            (measured.formatCheckMs - formatStart.formatCheckMs) / 20,
        }
        if (arrows) {
          const arrowStart = await readMetrics(session)
          for (let key = 0; key < 20; key++) {
            const head = await page.evaluate(
              () =>
                document.querySelector('.tiptap').editor.state.selection.head,
            )
            await input.press('ArrowLeft')
            await page.waitForFunction(
              (head) =>
                document.querySelector('.tiptap').editor.state.selection
                  .head !== head,
              head,
            )
          }
          sample.arrowMainThreadPerKey = perKey(
            arrowStart,
            await readMetrics(session),
            20,
          )
        }
        samples.push(sample)
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
        emulateFocus,
        findQuery,
        enabledAddons,
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
            canPerKeyMedian: percentile(
              group.map((sample) => sample.canPerKey),
              0.5,
            ),
            formatCheckMsPerKeyMedian: percentile(
              group.map((sample) => sample.formatCheckMsPerKey),
              0.5,
            ),
            mainThreadPerKeyMedian: Object.fromEntries(
              mainThreadMetrics.map((name) => [
                name,
                percentile(
                  group.map((sample) => sample.mainThreadPerKey[name]),
                  0.5,
                ),
              ]),
            ),
            arrowMainThreadPerKeyMedian: arrows
              ? Object.fromEntries(
                  mainThreadMetrics.map((name) => [
                    name,
                    percentile(
                      group.map((sample) => sample.arrowMainThreadPerKey[name]),
                      0.5,
                    ),
                  ]),
                )
              : null,
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
