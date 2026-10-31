import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { electron } from '../tests/electron.mjs'
import { clickMenu } from '../tests/keyboard.mjs'
import { documentEngineFixture } from './document-engine-fixtures.mjs'

const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [name, ...value] = arg.replace(/^--/, '').split('=')
    return [name, value.join('=') || 'true']
  }),
)
const sizes = (options.sizes ?? '1000,10000,100000').split(',').map(Number)
const families = (options.families ?? 'text,markdown,bbcode,typst,latex').split(
  ',',
)
const modes = (options.modes ?? 'source,visual').split(',')
const runs = Number(options.runs ?? 3),
  edits = Number(options.edits ?? 1000)
const foreground = options.foreground === 'true'
const deadline = Number(options.deadline ?? Math.max(60_000, edits * 300))
if (!Number.isFinite(deadline) || deadline < 1000 || deadline > 3_600_000)
  throw new Error('Use a case deadline between 1,000 and 3,600,000 ms.')
if (
  !Number.isInteger(runs) ||
  runs < 1 ||
  runs > 20 ||
  !Number.isInteger(edits) ||
  edits < 1 ||
  edits > 10_000
)
  throw new Error('Use 1–20 runs and 1–10,000 edits per position.')
if (modes.some((mode) => !['source', 'visual'].includes(mode)))
  throw new Error('Use source or visual modes.')
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[
    Math.max(0, Math.ceil(values.length * p) - 1)
  ] ?? null
const distribution = (values) => ({
  samples: values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  p99: percentile(values, 0.99),
})
const directory = await mkdtemp(join(tmpdir(), 'hibi-document-engine-'))
const root = resolve('.')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const report = {
  recordedAt: new Date().toISOString(),
  head: git('rev-parse', 'HEAD'),
  dirty: git('status', '--short'),
  environment: {
    shellNode: process.version,
    platform: platform(),
    osRelease: release(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
    build: 'production assets; test Electron; not packaged',
    foreground,
    displayRefresh: 'not measured',
    powerMode: 'not measured',
  },
  endpoints: {
    driver:
      'real key input through constant-size version acknowledgement; no timed whole-source or whole-DOM polling',
    cpu: 'CM dispatch / PM dispatchTransaction including synchronous host listeners; input handling before dispatch excluded',
    sourceCommit:
      'beforeinput to synchronous addon document observer; null if browser emits no beforeinput',
    echo: 'next animation-frame callback after committed key; rendering proxy, not physical presentation',
    diagnostics:
      'disabled; test-only observer records constant-size acknowledgements',
  },
  samples: [],
}
async function saveReport() {
  if (options.output)
    await writeFile(resolve(options.output), JSON.stringify(report, null, 2))
}
async function installProbe(profile, format) {
  const folder = join(profile, 'installed-addons', 'engine-benchmark')
  await mkdir(folder, { recursive: true })
  const files = ['index.js', 'hibi-addon.json']
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'engine-benchmark',
      name: 'Engine benchmark',
      description: 'Temporary measurement observer',
      apiVersion: 3,
      version: '1.0.0',
      kind: 'extension',
      authors: [{ displayName: 'Hibi benchmark' }],
      capabilities: [],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({ hash: 'b'.repeat(64), files, source: 'local' }),
  )
  await writeFile(
    join(folder, 'index.js'),
    `export default () => ({ start(context) {
    const probe = window.__engineBenchmark = { context, ack: null, samples: [], lastInput: null };
    context.editor.onDocumentChange(document => {
      probe.ack = { tabId: document.tabId, revision: document.revision, version: document.contentVersion, name: document.name };
      if (probe.lastInput !== null) { probe.samples.push(performance.now() - probe.lastInput); probe.lastInput = null; }
    });
  }});`,
  )
  const owner = {
    bbcode: 'bbcode',
    typst: 'typst',
    latex: 'math',
    mermaid: 'mermaid',
  }[format]
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({
      'engine-benchmark': true,
      diagnostics: false,
      ...(owner ? { [owner]: true } : {}),
    }),
  )
}
async function run(fixture, mode, run) {
  const profile = join(directory, `${fixture.name}-${mode}-${run}`)
  await installProbe(profile, fixture.format)
  const file = join(directory, fixture.name)
  await writeFile(file, fixture.source)
  for (const [name, source] of Object.entries(fixture.resources))
    await writeFile(join(directory, name), source)
  const sample = {
    fixture: {
      family: fixture.family,
      format: fixture.format,
      ...fixture.metadata,
    },
    mode,
    run,
    enabledOptionalAddons: [fixture.format],
    status: 'pending',
    positions: [],
  }
  report.samples.push(sample)
  let app, watchdog
  try {
    app = await electron.launch({
      args: [root, `--user-data-dir=${profile}`],
      timeout: 20_000,
    })
    watchdog = setTimeout(() => {
      sample.status = 'timeout'
      sample.error = `Case exceeded ${deadline} ms; terminated its owned Electron process.`
      app.process().kill('SIGKILL')
    }, deadline)
    const page = await app.firstWindow()
    page.setDefaultTimeout(12_000)
    report.environment.electron = await app.evaluate(() => process.versions)
    await app.evaluate(({ dialog }, file) => {
      globalThis.__engineBenchmarkDialogs = []
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1)
        globalThis.__engineBenchmarkDialogs.push({
          message: options.message,
          detail: options.detail,
        })
        return { response: 1 }
      }
    }, file)
    if (foreground) {
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0]
        w.setFocusable(true)
        w.show()
        w.focus()
      })
      await page.waitForFunction(() => document.hasFocus())
    }
    await page.waitForFunction(() => window.__engineBenchmark?.ack)
    await page.evaluate(() => {
      const probe = window.__engineBenchmark
      probe.errors = []
      const observer = new MutationObserver(() => {
        for (const node of document.querySelectorAll('[role="alert"]')) {
          const text = node.textContent?.slice(0, 2000)
          if (text && !probe.errors.includes(text) && probe.errors.length < 16)
            probe.errors.push(text)
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      probe.stopErrorCapture = () => observer.disconnect()
    })
    const openStart = performance.now()
    await clickMenu(app, 'Open…')
    try {
      await page.waitForFunction(
        (name) => window.__engineBenchmark.ack.name === name,
        fixture.name,
        { timeout: 20_000 },
      )
    } catch (error) {
      sample.status = 'open-failed'
      sample.error = error.message
      sample.notice = await page
        .locator('body')
        .innerText({ timeout: 1000 })
        .catch(() => 'renderer unavailable')
      sample.notice = sample.notice.slice(-2000)
      sample.dialogs = await app.evaluate(
        () => globalThis.__engineBenchmarkDialogs,
      )
      sample.errors = await page.evaluate(() => window.__engineBenchmark.errors)
      if (
        /2 MiB|too large|size limit/i.test(
          JSON.stringify([sample.notice, sample.dialogs, sample.errors]),
        )
      )
        sample.status = 'cap-rejected'
      return
    }
    if (mode === 'visual') {
      const visual = page.getByRole('button', {
        name: 'Normal view',
        exact: true,
      })
      if ((await visual.count()) && (await visual.isEnabled()))
        await visual.click()
      const available = await page
        .locator(
          '.rich-pane .hibi-formatted .cm-content[contenteditable="true"]',
        )
        .count()
      if (!available || fixture.format !== 'markdown') {
        sample.status = 'unsupported-visual'
        sample.note =
          'No direct visual authoring capability; preview/source is not counted as a pass.'
        return
      }
    } else {
      const source = page.getByRole('button', {
        name: 'Source view',
        exact: true,
      })
      if (await source.isEnabled()) await source.click()
      await page.waitForFunction(
        () =>
          document.querySelector('.editor-panes')?.dataset.sourceReady ===
          'true',
      )
    }
    const selector =
      mode === 'source'
        ? '.source-pane .cm-content'
        : '.rich-pane .hibi-formatted .cm-content'
    const input = page.locator(selector)
    await input.waitFor()
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.isContentEditable,
      selector,
    )
    sample.firstEditableMs = performance.now() - openStart
    await page.evaluate(() => window.__engineBenchmark.stopErrorCapture())
    // These editor handles are used only by this measurement driver. No runtime
    // addon imports are added merely to get a clock around accepted dispatch.
    await page.evaluate((selector) => {
      const dom = document.querySelector(selector),
        probe = window.__engineBenchmark
      probe.cpu = []
      probe.view = dom.cmTile?.root?.view
      if (!probe.view)
        throw new Error('Installed editor measurement handle changed.')
      dom.addEventListener(
        'beforeinput',
        () => {
          probe.lastInput = performance.now()
        },
        true,
      )
      const original = probe.view.dispatch
      probe.view.dispatch = (...args) => {
        const version = probe.ack.version,
          start = performance.now()
        try {
          return original(...args)
        } finally {
          if (probe.ack.version !== version)
            probe.cpu.push(performance.now() - start)
        }
      }
    }, selector)
    for (const position of ['start', 'middle', 'end']) {
      await page.evaluate((position) => {
        const { view } = window.__engineBenchmark
        const line =
          position === 'start'
            ? 1
            : position === 'end'
              ? view.state.doc.lines
              : Math.ceil(view.state.doc.lines / 2)
        view.dispatch({
          selection: { anchor: view.state.doc.line(line).from },
          scrollIntoView: true,
        })
        view.focus()
        window.__engineBenchmark.cpu = []
        window.__engineBenchmark.samples = []
      }, position)
      const driver = [],
        echo = []
      const previous = await page.evaluate(
        () => window.__engineBenchmark.context.editor.getDocument().markdown,
      )
      for (let i = 0; i < edits; i++) {
        const version = await page.evaluate(
          () => window.__engineBenchmark.ack.version,
        )
        const start = performance.now()
        await page.keyboard.type('x')
        await page.waitForFunction(
          (version) => window.__engineBenchmark.ack.version > version,
          version,
        )
        driver.push(performance.now() - start)
        echo.push(
          await page.evaluate(
            () =>
              new Promise((resolve) => {
                const start = performance.now()
                requestAnimationFrame(() => resolve(performance.now() - start))
              }),
          ),
        )
      }
      const measurements = await page.evaluate(() => {
        const p = window.__engineBenchmark
        return {
          cpu: p.cpu,
          source: p.samples,
          version: p.ack.version,
          sourceText: p.context.editor.getDocument().markdown,
          domNodes: document.getElementsByTagName('*').length,
          heapBytes: performance.memory?.usedJSHeapSize ?? null,
        }
      })
      assert.ok(
        measurements.sourceText.length >= previous.length + edits,
        'Every typed character must commit.',
      )
      const native = await page.evaluate(() => window.hibi.getDocument())
      assert.equal(
        native.markdown,
        measurements.sourceText,
        'Native recovery must match committed source outside timing.',
      )
      sample.positions.push({
        position,
        cpu: distribution(measurements.cpu),
        sourceCommit: distribution(measurements.source),
        driver: distribution(driver),
        nextFrame: distribution(echo),
        domNodes: measurements.domNodes,
        heapBytes: measurements.heapBytes,
        version: measurements.version,
      })
    }
    sample.status = 'measured'
    sample.processes = await app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .map(({ type, memory, cpu }) => ({ type, memory, cpu })),
    )
  } catch (error) {
    if (sample.status !== 'timeout') {
      sample.status = 'failed'
      sample.error = error.stack
    }
  } finally {
    clearTimeout(watchdog)
    if (app) {
      const timer = setTimeout(() => app.process().kill('SIGKILL'), 5000)
      try {
        await app.close()
      } catch {
      } finally {
        clearTimeout(timer)
      }
    }
    await saveReport()
    console.log(
      JSON.stringify({
        fixture: fixture.name,
        mode,
        run,
        status: sample.status,
        cpuP95: sample.positions.map((p) => p.cpu.p95),
        error: sample.error?.split('\n')[0],
      }),
    )
  }
}
try {
  for (const family of families)
    for (const size of sizes) {
      const fixture = documentEngineFixture(family, size)
      for (const mode of modes)
        for (let iteration = 0; iteration < runs; iteration++)
          await run(fixture, mode, iteration)
    }
} finally {
  await saveReport()
  await rm(directory, { recursive: true, force: true })
}
if (!options.output) console.log(JSON.stringify(report, null, 2))
if (
  report.samples.some((sample) =>
    ['failed', 'timeout', 'open-failed'].includes(sample.status),
  )
)
  process.exitCode = 1
