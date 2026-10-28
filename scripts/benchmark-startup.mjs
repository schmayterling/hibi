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
  focusBenchmarkPage,
  launchBenchmarkApp,
  openBenchmarkDocument,
  prepareBenchmarkInput,
  seedBenchmarkProfile,
  selectBenchmarkFile,
  switchToSource,
  typeCharacter,
  verifyBenchmarkProvenance,
  waitForEditor,
  waitForWorkspaces,
} from './benchmark-flows.mjs'

const { values } = parseArgs({
  options: {
    'script-census': { type: 'boolean', default: false },
    'require-build-manifest': { type: 'boolean', default: false },
    engine: {
      type: 'string',
      default: process.env.HIBI_BENCH_ENGINE ?? 'tiptap',
    },
  },
})
const engine = benchmarkEngine(values.engine)
if (values['require-build-manifest'])
  assert.ok(
    !showTestWindows,
    'verified startup comparison requires hidden test windows',
  )
const runs = Number(process.env.HIBI_BENCH_RUNS ?? 5)
if (!Number.isInteger(runs) || runs < 1 || runs > 50)
  throw new Error('Use 1–50 runs.')
const provenance = await benchmarkProvenance(
  new URL(import.meta.url),
  '.',
  values['require-build-manifest'],
)
const temp = await mkdtemp(join(tmpdir(), 'hibi-benchmark-'))
const samples = []
const profileSeeds = new Map()
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

async function measure(page, start, app, scenario, profileSeed) {
  const session = await focusBenchmarkPage(page)
  const editor = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await waitForEditor(page, scenario === 'minimal' ? undefined : engine)
  const editable = values['script-census'] ? null : performance.now() - start
  let ready = null
  if (
    ['fresh-profile', 'warm-profile', 'warm-profile-prime'].includes(scenario)
  ) {
    await waitForWorkspaces(page, recentPaths)
    ready = values['script-census'] ? null : performance.now() - start
  }
  await prepareBenchmarkInput(page)
  // census launches never type; timed renderers never enable the debugger.
  let beforeInputScripts = null
  if (values['script-census']) {
    const scripts = []
    const parsed = ({ url }) => {
      if (url.startsWith('app://hibi/')) scripts.push(url)
    }
    session.on('Debugger.scriptParsed', parsed)
    try {
      await session.send('Debugger.enable')
      await session.send('Debugger.disable')
      beforeInputScripts = [...new Set(scripts)]
    } finally {
      session.off('Debugger.scriptParsed', parsed)
    }
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
  renderer.scripts = beforeInputScripts
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
    profileSeed,
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
      if (!profileSeeds.has(profile))
        profileSeeds.set(profile, await seedBenchmarkProfile(profile, engine))
      const profileSeed = profileSeeds.get(profile)
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
          profileSeed,
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
          await measure(
            await window,
            reopening,
            app,
            'window-reopen',
            profileSeed,
          )
        }
        if (scenario === 'fresh-profile') {
          const page = await app.firstWindow()
          for (const document of documents) {
            await selectBenchmarkFile(app, join(temp, document.name))
            const opening = performance.now()
            await openBenchmarkDocument(app, page, document.title)
            await measure(
              page,
              opening,
              app,
              `document-open:${document.name}`,
              profileSeed,
            )
          }
          if (documents.length && !values['script-census']) {
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
  await verifyBenchmarkProvenance(provenance, new URL(import.meta.url))
  console.log(
    JSON.stringify(
      {
        ...provenance,
        provenanceVerifiedAtEnd: true,
        engine,
        scriptCensus: values['script-census'],
        requireBuildManifest: values['require-build-manifest'],
        windowPolicy: showTestWindows ? 'visible' : 'hidden',
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
          'production assets in test electron; configured windowPolicy, isVisible is diagnostic only on macos; one focus-emulated session per renderer, editor focus and two frames before input timing; all profiles including minimal seeded at app origin without loading hibi and with hardware acceleration disabled during seeding, before launch timing; seed file inventories recorded per sample; fresh means app-cold seeded chromium profile, not os cold-cache; input timing and script census use separate launches, timed renderers never enable the debugger; driver latency included; source/output fingerprints include ignored user addons and are verified again at end; buildVerified records manifest binding, false when the manifest is absent.',
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
