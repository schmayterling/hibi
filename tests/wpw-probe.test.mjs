// Scratch probe for the windows paragraph width red. Never commit.
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'vite'
import { after, before, electron, waitForFormattedEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { paragraphTracePlugin, tracePath } from './wpw-trace.mjs'

const out = process.env.WPW_OUT ?? resolve('.scratch/probe-out.jsonl')
const scenarios = JSON.parse(process.env.WPW_SCENARIOS ?? '[{"name":"plain"}]')
let app, folder, page, harness
const consoleLines = []

before(
  async () => {
    folder = await mkdtemp(join(tmpdir(), 'hibi-wpw-probe-'))
    const bundle = join(folder, 'bundle')
    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: tracePath ? [paragraphTracePlugin()] : [],
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: bundle,
        assetsInlineLimit: 0,
        lib: {
          entry: resolve('tests/fixtures/formatted-tables.ts'),
          name: 'TablesHarness',
          formats: ['iife'],
          fileName: () => 'harness.js',
          cssFileName: 'harness',
        },
      },
    })
    const html = join(bundle, 'index.html')
    await writeFile(
      html,
      '<!doctype html><html lang="en"><head><link rel="stylesheet" href="harness.css"></head><body><script src="harness.js"></script></body></html>',
    )
    await mkdir(join(folder, 'notes'))
    const file = join(folder, 'notes', 'tables.md')
    await writeFile(file, '# Formatted tables\n\nA paragraph.\n')
    app = await electron.launch({
      args: [
        resolve('.'),
        '--force-device-scale-factor=1',
        `--user-data-dir=${join(folder, 'profile')}`,
      ],
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    await waitForFormattedEditor(app, page)
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, file)
    await pressShortcut(
      app,
      process.platform === 'darwin' ? 'Meta+o' : 'Control+o',
    )
    await page
      .locator('.rich-pane .hibi-lp-h1', { hasText: 'Formatted tables' })
      .waitFor()
    const size = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getContentSize(),
    )
    const next = app.waitForEvent('window')
    await app.evaluate(
      ({ BrowserWindow }, { path, size }) => {
        const window = new BrowserWindow({
          width: size[0],
          height: size[1],
          useContentSize: true,
          show: false,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
          },
        })
        void window.loadFile(path)
      },
      { path: html, size },
    )
    harness = await next
    await harness.setViewportSize({ width: 1000, height: 720 })
    harness.setDefaultTimeout(10000)
    await harness.waitForFunction(() => Boolean(window.tables))
    const focus = await harness.context().newCDPSession(harness)
    await focus.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    harness.on('console', (message) =>
      consoleLines.push(`${message.type()}: ${message.text()}`),
    )
  },
  { timeout: 90000 },
)

after(
  async () => {
    await app?.close()
    if (folder) await rm(folder, { recursive: true, force: true })
  },
  { timeout: 30000 },
)

const hugeParagraphs = Array.from(
  { length: 300 },
  (_, i) => `Paragraph ${i} of the text above.`,
).join('\n\n')
const hugeMore = '\nmore\n'.repeat(200)
const hugeLines = Array.from(
  { length: 20000 },
  (_, i) => `line ${i} of one long paragraph`,
).join('\n')
const hugeParagraph = `${hugeParagraphs}\n\n${hugeLines}\n\nAfter.\n${hugeMore}`
const target = 'line 15000 of'

for (const scenario of scenarios)
  test(`probe ${scenario.name}`, { timeout: 180000 }, async () => {
    consoleLines.length = 0
    const doc = hugeParagraph
    await harness.evaluate(
      async ({ doc, target, scenario }) => {
        if (scenario.trace) globalThis.__paragraphWidthArm?.()
        await window.tables.mount(
          doc,
          { width: 1400, height: 800 },
          { editable: true },
        )
        const view = window.tables.view()
        const pane = document.querySelector('.rich-pane')
        const frame = () => new Promise(requestAnimationFrame)
        const at = doc.indexOf(target)
        const where = (pos) => {
          if (
            !view.visibleRanges.some(
              (range) => range.from <= pos && pos < range.to,
            )
          )
            return null
          for (const at of [pos, pos + 1]) {
            const { node, offset } = view.domAtPos(at, 1)
            if (node.nodeType === Node.TEXT_NODE && offset < node.length) {
              const range = document.createRange()
              range.setStart(node, offset)
              range.setEnd(node, offset + 1)
              return range.getClientRects()[0].top
            }
          }
          return view.coordsAtPos(pos, 1).top
        }
        for (let i = 0; i < 60 && Math.abs(where(at) ?? 999) >= 200; i++) {
          view.dispatch({
            effects: view.constructor.scrollIntoView(at, {
              y: 'start',
              yMargin: 0,
            }),
          })
          for (let frames = 0; frames < 4; frames++) await frame()
        }
        for (let frames = 0; frames < 30; frames++) await frame()
        // JS-only state: no layout reads.
        const state = () => {
          const vs = view.viewState
          return {
            block: view.lineBlockAt(at).from,
            height: Math.round(vs.heightMap.height),
            gaps: vs.lineGaps.map((gap) => [gap.from, gap.to, Math.round(gap.size)]),
            scroll: pane.scrollTop,
            settling: !!window.tables.settling(),
          }
        }
        window.reading = {
          where,
          frame,
          state,
          panes: document.querySelector('.editor-panes'),
          rowAtTop: (y = 1) => {
            const caret = document.caretPositionFromPoint(
              view.contentDOM.getBoundingClientRect().left +
                Number.parseFloat(
                  getComputedStyle(view.contentDOM).paddingLeft,
                ) +
                1,
              pane.getBoundingClientRect().top + y,
            )
            return view.posAtDOM(caret.offsetNode, caret.offset)
          },
        }
      },
      { doc, target, scenario },
    )
    const log = { scenario, mount: await harness.evaluate(() => window.reading.state()), steps: [], states: [] }
    await harness.mouse.move(500, 400)
    const steps = []
    let index = 0
    for (const delta of [100, -100])
      for (let step = 0; step < 16; step++, index++) {
        const before = await harness.evaluate(() => {
          const { rowAtTop, where } = window.reading
          const pos = rowAtTop()
          return { pos, top: where(pos) }
        })
        await harness.mouse.wheel(0, delta)
        const after = await harness.evaluate(async (pos) => {
          const { where, frame } = window.reading
          for (let frames = 0; frames < 3; frames++) await frame()
          return where(pos)
        }, before.pos)
        steps.push(after === null ? null : after - before.top + delta)
        if (scenario.idleAt?.includes(index))
          // A quiet main thread, as between slow CDP round trips: idle callbacks run.
          await harness.evaluate(
            (ms) => new Promise((done) => setTimeout(done, ms)),
            scenario.idleMs ?? 300,
          )
        log.states.push({ index, ...(await harness.evaluate(() => window.reading.state())) })
      }
    const widths = await harness.evaluate(async (scenario) => {
      const { rowAtTop, where, frame, panes, state } = window.reading
      for (let frames = 0; frames < 30; frames++) await frame()
      if (scenario.idleBeforeWidths)
        await new Promise((done) => setTimeout(done, scenario.idleBeforeWidths))
      if (scenario.scrollBy) {
        document.querySelector('.rich-pane').scrollTop += scenario.scrollBy
        for (let frames = 0; frames < 30; frames++) await frame()
      }
      const view = window.tables.view()
      view.dispatch({
        effects: view.constructor.scrollIntoView(rowAtTop(300)),
      })
      for (let frames = 0; frames < 3; frames++) await frame()
      const pos = rowAtTop()
      const start = where(pos)
      const offs = []
      const before = state()
      const after = []
      const tape = globalThis.__paragraphWidthTrace
      for (const width of scenario.widths ?? [1100, 900, 1400]) {
        if (tape) {
          tape.phase = 'width'
          tape.width = width
          tape.stage = 'assign'
          tape.add('width-assignment', view, { pos, start, width })
        }
        panes.style.width = `${width}px`
        await frame()
        await new Promise((done) => setTimeout(done))
        if (tape) tape.stage = 'first'
        const painted = where(pos)
        tape?.add('width-oracle', view, { pos, top: painted, width })
        after.push({ width, painted: state() })
        if (tape) tape.stage = 'settling'
        for (let frames = 0; frames < 30; frames++) await frame()
        if (tape) tape.stage = 'settled'
        const settled = where(pos)
        tape?.add('width-oracle', view, { pos, top: settled, width })
        for (const top of [painted, settled])
          offs.push(top === null ? null : top - start)
      }
      const receipt = globalThis.__paragraphWidthTrace?.finish?.()
      return { offs, pos, start, before, after, receipt }
    }, scenario)
    log.steps = steps
    log.widths = widths.offs
    log.widthsBefore = widths.before
    log.widthsAfter = widths.after
    log.pos = widths.pos
    log.console = consoleLines.filter((line) => /stabilize|Measure loop/.test(line))
    const rowsHeld = (off) => off !== null && Math.abs(off) <= 60
    log.pass =
      steps.every((off) => off !== null && Math.abs(off) <= 30) &&
      widths.offs.every(rowsHeld)
    await appendFile(out, `${JSON.stringify(log)}\n`)
    if (widths.receipt && process.env.WPW_TRACE_OUT)
      await writeFile(
        `${process.env.WPW_TRACE_OUT}-${scenario.name}.json`,
        JSON.stringify({ receipt: widths.receipt }),
      )
    assert.ok(log.pass, JSON.stringify({ steps, widths: widths.offs }))
  })
