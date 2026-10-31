import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pressShortcut } from '../tests/keyboard.mjs'
import {
  benchmarkDocuments,
  launchBenchmarkApp,
  openBenchmarkDocument,
  selectBenchmarkFile,
  waitForEditor,
} from './benchmark-flows.mjs'

const manifest = JSON.parse(await readFile(process.argv[2], 'utf8'))
const results = []
const root = await mkdtemp(join(tmpdir(), 'hibi-log-scenarios-'))
const file = join(root, 'large.md')
await writeFile(file, benchmarkDocuments[0].source)
try {
  for (let round = 0; round < 3; round++) {
    for (const variant of round % 2
      ? [...manifest.variants].reverse()
      : manifest.variants) {
      const profile = join(root, `${variant.profile}-${round}`)
      await mkdir(profile)
      const app = await launchBenchmarkApp(profile, variant.directory)
      try {
        const page = await app.firstWindow()
        await waitForEditor(page)
        const runtime = await app.evaluate(({ app, ipcMain, screen }) => {
          globalThis.diagnosticCalls = 0
          const channel = 'hibi:local-diagnostics'
          const handler = ipcMain._invokeHandlers.get(channel)
          if (handler) {
            ipcMain.removeHandler(channel)
            ipcMain.handle(channel, (...args) => {
              if (args[1] === 'batch') globalThis.diagnosticCalls++
              return handler(...args)
            })
          }
          return {
            versions: process.versions,
            display: screen.getPrimaryDisplay().displayFrequency,
            packaged: app.isPackaged,
          }
        })
        const modes = [
          ['rich', 'Meta+Shift+['],
          ['source', 'Meta+Shift+]'],
          ['split', 'Meta+Shift+\\'],
        ]
        await selectBenchmarkFile(app, file)
        await openBenchmarkDocument(app, page, benchmarkDocuments[0].title)
        const measurements = []
        for (const [mode, shortcut] of modes) {
          await pressShortcut(
            app,
            process.platform === 'darwin'
              ? shortcut
              : shortcut.replace('Meta', 'Control'),
          )
          const selector =
            mode === 'rich'
              ? '.rich-pane .cm-content[contenteditable="true"]'
              : '.source-pane .cm-content[contenteditable="true"]'
          await page.locator(selector).waitFor()
          await page.evaluate((selector) => {
            const element = document.querySelector(selector)
            const measured = {
              cpu: [],
              visibleProxy: [],
              frames: [],
              lastFrame: 0,
              stop: false,
            }
            window.diagnosticMeasurements = measured
            const frame = (now) => {
              if (measured.stop) return
              if (measured.lastFrame)
                measured.frames.push(now - measured.lastFrame)
              measured.lastFrame = now
              requestAnimationFrame(frame)
            }
            requestAnimationFrame(frame)
            element.addEventListener(
              'beforeinput',
              () => {
                const start = performance.now()
                requestAnimationFrame(() =>
                  requestAnimationFrame(() =>
                    measured.visibleProxy.push(performance.now() - start),
                  ),
                )
              },
              { capture: true },
            )
            const view = element.cmTile.root.view,
              dispatch = view.dispatchTransactions
            view.dispatchTransactions = function (transactions, editor) {
              const start = performance.now()
              try {
                dispatch.call(this, transactions, editor)
              } finally {
                if (transactions.some((t) => t.docChanged))
                  measured.cpu.push(performance.now() - start)
              }
            }
          }, selector)
          await page.locator(selector).click()
          await page
            .locator(selector)
            .press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
          for (let n = 0; n < 120; n++) await page.locator(selector).press('a')
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          )
          const measured = await page.evaluate(() => {
            window.diagnosticMeasurements.stop = true
            return window.diagnosticMeasurements
          })
          assert.equal(measured.cpu.length, 120)
          const scroll = performance.now()
          for (let n = 0; n < 10; n++)
            await page.mouse.wheel(0, n % 2 ? -300 : 300)
          measurements.push({
            mode,
            ...measured,
            scrollDriverMs: performance.now() - scroll,
          })
        }
        const diagnosticCalls = await app.evaluate(
          () => globalThis.diagnosticCalls,
        )
        assert.equal(diagnosticCalls, 0)
        const savedPath = join(root, `${variant.profile}-${round}.md`)
        await app.evaluate(({ dialog }, path) => {
          dialog.showSaveDialog = async () => ({
            canceled: false,
            filePath: path,
          })
        }, savedPath)
        const saveStart = performance.now()
        const saved = await page.evaluate(() => window.hibi.saveDocument(true))
        const saveMs = performance.now() - saveStart
        // A large note saves with a receipt instead of its text.
        const markdown = saved?.saveReceipt
          ? (await page.evaluate(() => window.hibi.getDocument())).markdown
          : saved?.markdown
        assert.equal(await readFile(savedPath, 'utf8'), markdown)
        await page.evaluate(() => window.hibi.setAddonEnabled('typst', true))
        const compilation = []
        for (let i = 0; i < 3; i++) {
          const start = performance.now()
          const valid = await page.evaluate(
            async () =>
              !!(
                await window.hibi.queryAddon('typst', 'compile', {
                  source: '= Synthetic benchmark\nA paragraph.',
                })
              ).svg,
          )
          compilation.push(performance.now() - start)
          assert.ok(valid)
        }
        const idleBefore = await app.evaluate(({ app }) => ({
          metrics: app
            .getAppMetrics()
            .map(({ type, cpu, memory }) => ({ type, cpu, memory })),
          diagnostics: globalThis.diagnosticCalls,
        }))
        await new Promise((resolve) => setTimeout(resolve, 1500))
        const idleAfter = await app.evaluate(({ app }) => ({
          metrics: app
            .getAppMetrics()
            .map(({ type, cpu, memory }) => ({ type, cpu, memory })),
          diagnostics: globalThis.diagnosticCalls,
        }))
        assert.equal(idleAfter.diagnostics, idleBefore.diagnostics)
        results.push({
          round,
          profile: variant.profile,
          runtime,
          measurements,
          diagnosticCalls,
          saveMs,
          compilation,
          idleBefore,
          idleAfter,
        })
      } finally {
        await app.close()
      }
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log(
  JSON.stringify(
    {
      fixture: {
        bytes: Buffer.byteLength(benchmarkDocuments[0].source),
        paragraphs: 180,
      },
      note: 'hidden-window double-rAF proxy, not confirmed screen presentation; dispatch wrappers exist only in this harness',
      results,
    },
    null,
    2,
  ),
)
