import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, loadavg, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { showTestWindows } from '../tests/electron.mjs'
import {
  benchmarkDocuments,
  benchmarkEngine,
  benchmarkProvenance,
  launchBenchmarkApp,
  openBenchmarkDocument,
  seedBenchmarkProfile,
  selectBenchmarkFile,
  switchToSource,
  typeCharacter,
  waitForEditor,
  waitForWorkspaces,
} from './benchmark-flows.mjs'

const { values } = parseArgs({
  options: {
    'script-census': { type: 'boolean', default: false },
    engine: {
      type: 'string',
      default: process.env.HIBI_BENCH_ENGINE ?? 'tiptap',
    },
  },
})
const engine = benchmarkEngine(values.engine)
assert.ok(!showTestWindows, 'startup comparison requires hidden test windows')
const runs = Number(process.env.HIBI_BENCH_RUNS ?? 5)
if (!Number.isInteger(runs) || runs < 1 || runs > 50)
  throw new Error('Use 1–50 runs.')
const provenance = await benchmarkProvenance(new URL(import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'hibi-benchmark-'))
const samples = []
const recentPaths = ['notes', 'journal', 'projects'].map((name) =>
  join(temp, name),
)
for (const path of recentPaths) await mkdir(path)
const enabledAddons = (process.env.HIBI_BENCH_ADDONS ?? '')
  .split(',')
  .filter(Boolean)
const documents =
  process.env.HIBI_BENCH_DOCUMENTS === '1' ? benchmarkDocuments : []
for (const document of documents)
  await writeFile(join(temp, document.name), document.source)
const minimal = join(temp, 'minimal.cjs')
await writeFile(
  minimal,
  `const {app,BrowserWindow}=require('electron');
app.setPath('userData',app.commandLine.getSwitchValue('user-data-dir'));
app.whenReady().then(()=>{ const win=new BrowserWindow({width:1000,height:720,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.loadURL('data:text/html,<body contenteditable="true" role="textbox" aria-label="Document editor"></body>'); });
app.on('window-all-closed',()=>app.quit());`,
)

async function measure(page, start, app, scenario) {
  const editor = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await waitForEditor(page, scenario === 'minimal' ? undefined : engine)
  const editable = performance.now() - start
  let ready = null
  if (
    ['fresh-profile', 'warm-profile', 'warm-profile-prime'].includes(scenario)
  ) {
    await waitForWorkspaces(page, recentPaths)
    ready = performance.now() - start
  }
  // debugger activation can perturb input cost; census launches omit typing.
  const session = await page.context().newCDPSession(page)
  let scripts = []
  session.on('Debugger.scriptParsed', ({ url }) => {
    if (url.startsWith('app://hibi/')) scripts.push(url)
  })
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  let beforeInputScripts = null
  if (values['script-census']) {
    await session.send('Debugger.enable')
    await session.send('Debugger.disable')
    beforeInputScripts = [...new Set(scripts)]
  }
  let firstInput = null
  const typing = []
  if (!values['script-census']) {
    const previousText = await editor.textContent()
    const beforeInput = performance.now()
    await typeCharacter(page, previousText)
    firstInput = performance.now() - beforeInput
    for (let i = 0; i < 8; i++) {
      const before = performance.now()
      if (process.env.HIBI_BENCH_INSERT_TEXT === '1')
        await page.keyboard.insertText('a')
      else await editor.press('a')
      typing.push(performance.now() - before)
      await new Promise((done) => setTimeout(done, 50))
    }
  }
  const renderer = await page.evaluate(() => ({
    timeOrigin: performance.timeOrigin,
    spans: performance
      .getEntriesByType('measure')
      .filter((entry) => entry.name.startsWith('hibi:'))
      .map((entry) => ({
        name: entry.name,
        ms: entry.startTime,
        duration: entry.duration,
      })),
    milestones: performance
      .getEntriesByType('mark')
      .filter((entry) => entry.name.startsWith('hibi:'))
      .map((entry) => ({ name: entry.name, ms: entry.startTime })),
    paint: performance
      .getEntriesByType('paint')
      .map((entry) => ({ name: entry.name, ms: entry.startTime })),
    sourceMounted: !!document.querySelector('.source-pane .cm-editor'),
  }))
  renderer.beforeInputScripts = beforeInputScripts
  scripts = []
  await session.send('Debugger.enable')
  renderer.scripts = [...new Set(scripts)]
  await session.detach()
  const main = await app.evaluate(() => ({
    timeOrigin: performance.timeOrigin,
    runtime: { ...process.versions },
    entries: performance
      .getEntries()
      .filter((entry) => entry.name.startsWith('hibi:'))
      .map((entry) => ({
        name: entry.name,
        ms: entry.startTime,
        duration: entry.duration,
      })),
  }))
  const visibility = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { visible: window.isVisible(), focused: window.isFocused() }
  })
  assert.equal(
    visibility.visible,
    false,
    'startup comparison requires a hidden window',
  )
  const addons =
    scenario === 'minimal'
      ? []
      : await page.evaluate(async () =>
          (await window.hibi.getAddonStates())
            .filter(({ enabled, blockedBy }) => enabled && !blockedBy?.length)
            .map(({ id }) => id)
            .sort(),
        )
  samples.push({
    scenario,
    engine: scenario === 'minimal' ? null : engine,
    addons,
    visibility,
    focusEmulation: true,
    loadAverage: loadavg(),
    startedAt: performance.timeOrigin + start,
    editable,
    ready,
    firstInput,
    typing,
    renderer,
    main,
  })
}

try {
  for (const scenario of ['minimal', 'fresh-profile', 'warm-profile']) {
    for (let run = 0; run < runs; run++) {
      const profile = join(
        temp,
        scenario === 'warm-profile' ? 'warm' : `${scenario}-${run}`,
      )
      await mkdir(profile, { recursive: true })
      if (scenario !== 'minimal')
        await writeFile(
          join(profile, 'recent-workspaces.json'),
          JSON.stringify(recentPaths),
        )
      if (scenario !== 'minimal' && enabledAddons.length)
        await writeFile(
          join(profile, 'addons.json'),
          JSON.stringify(
            Object.fromEntries(enabledAddons.map((id) => [id, true])),
          ),
        )
      if (scenario !== 'minimal' && (scenario !== 'warm-profile' || run === 0))
        await seedBenchmarkProfile(profile, engine)
      const start = performance.now()
      const app = await launchBenchmarkApp(
        profile,
        scenario === 'minimal' ? minimal : undefined,
      )
      try {
        await measure(
          await app.firstWindow(),
          start,
          app,
          scenario === 'warm-profile' && run === 0
            ? 'warm-profile-prime'
            : scenario,
        )
        if (scenario === 'fresh-profile' && process.platform === 'darwin') {
          await app.evaluate(
            ({ BrowserWindow }) =>
              new Promise((resolve) => {
                const window = BrowserWindow.getAllWindows()[0]
                window.once('closed', () => resolve())
                window.close()
              }),
          )
          const reopening = performance.now()
          const window = app.waitForEvent('window')
          await app.evaluate(({ app }) => app.emit('activate'))
          await measure(await window, reopening, app, 'window-reopen')
        }
        if (scenario === 'fresh-profile') {
          const page = await app.firstWindow()
          for (const document of documents) {
            await selectBenchmarkFile(app, join(temp, document.name))
            const opening = performance.now()
            await openBenchmarkDocument(app, page, document.title)
            await measure(page, opening, app, `document-open:${document.name}`)
          }
          if (documents.length) {
            const switching = performance.now()
            await switchToSource(app, page)
            samples.at(-1).firstSourceSwitch = performance.now() - switching
          }
        }
      } finally {
        await app.close()
      }
    }
  }
  const chunks = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const visited = new Set()
  function visit(file) {
    if (visited.has(file)) return
    const chunk = chunks.find((chunk) => chunk.file === file)
    if (!chunk) return
    visited.add(file)
    for (const dependency of chunk.imports) visit(dependency)
  }
  for (const entry of chunks.filter((chunk) => chunk.entry)) visit(entry.file)
  const initial = chunks.filter((chunk) => visited.has(chunk.file))
  const quantile = (values, q) =>
    values.toSorted((a, b) => a - b)[Math.ceil(values.length * q) - 1]
  for (const sample of samples) {
    if (sample.renderer.beforeInputScripts === null) {
      sample.renderer.beforeInputBytes = null
      sample.renderer.beforeInputModules = null
      continue
    }
    const loaded = new Set(
      sample.renderer.beforeInputScripts.map((url) =>
        new URL(url).pathname.slice(1),
      ),
    )
    const beforeInput = chunks.filter((chunk) => loaded.has(chunk.file))
    sample.renderer.beforeInputBytes = beforeInput.reduce(
      (sum, chunk) => sum + chunk.bytes,
      0,
    )
    sample.renderer.beforeInputModules = beforeInput.flatMap(
      (chunk) => chunk.modules,
    )
  }
  const summary = [...new Set(samples.map((sample) => sample.scenario))].map(
    (scenario) => {
      const group = samples.filter((sample) => sample.scenario === scenario)
      return {
        scenario,
        engine: group[0].engine,
        runs: group.length,
        editableMedian: quantile(
          group.map((sample) => sample.editable),
          0.5,
        ),
        editableP95: quantile(
          group.map((sample) => sample.editable),
          0.95,
        ),
        readyMedian:
          quantile(
            group.flatMap((sample) =>
              sample.ready === null ? [] : [sample.ready],
            ),
            0.5,
          ) ?? null,
        readyP95:
          quantile(
            group.flatMap((sample) =>
              sample.ready === null ? [] : [sample.ready],
            ),
            0.95,
          ) ?? null,
        firstInputP95:
          quantile(
            group.flatMap((sample) =>
              sample.firstInput === null ? [] : [sample.firstInput],
            ),
            0.95,
          ) ?? null,
        typingP95:
          quantile(
            group.flatMap((sample) => sample.typing),
            0.95,
          ) ?? null,
      }
    },
  )
  console.log(
    JSON.stringify(
      {
        ...provenance,
        engine,
        scriptCensus: values['script-census'],
        runtime: process.version,
        host: {
          cpu: cpus()[0]?.model,
          logicalCores: cpus().length,
          release: release(),
        },
        platform: process.platform,
        arch: process.arch,
        enabledAddons,
        conditions:
          'production assets in test electron; hidden windows with focus emulation; app profiles seeded at app origin without loading hibi, before launch timing; minimal control unseeded; fresh profile is not os cold-cache; input timing and pre-input script census use separate launches; driver latency included. source and build hashes are independent; rebuild the recorded source before comparing.',
        initialBytes: initial.reduce((sum, chunk) => sum + chunk.bytes, 0),
        initialModules: initial.flatMap((chunk) => chunk.modules),
        summary,
        samples,
      },
      null,
      2,
    ),
  )
} finally {
  await rm(temp, { recursive: true, force: true })
}
