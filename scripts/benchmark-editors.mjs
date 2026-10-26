import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, release } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { showTestWindows, waitForDocumentEditor } from '../tests/electron.mjs'
import { clickMenu, pressShortcut } from '../tests/keyboard.mjs'
import { launchBenchmarkApp, selectBenchmarkFile } from './benchmark-flows.mjs'
import { createTraceFinalizer } from './trace-stream.mjs'

const sizes = ['blank', '100kb', '575kb', '2mb', '50mib']
const metricNames = [
  'TaskDuration',
  'ScriptDuration',
  'LayoutDuration',
  'RecalcStyleDuration',
]
const hash = (source) => createHash('sha256').update(source).digest('hex')

export function editorFixture(size) {
  assert.ok(sizes.includes(size), `unknown fixture: ${size}`)
  if (size === 'blank') return ''
  // Same 100,000-word paragraph fixture as trace-input-paint.mjs.
  const words = [
    'alpha',
    'beta',
    'gamma',
    'delta',
    'epsilon',
    'zeta',
    'eta',
    'theta',
    'iota',
    'kappa',
  ]
  const audit = Array.from(
    { length: 100000 },
    (_, index) =>
      `${index ? (index % 20 === 0 ? '\n\n' : ' ') : ''}${words[index % words.length]}`,
  ).join('')
  const bytes = {
    '100kb': 100000,
    '575kb': audit.length,
    '2mb': 2000000,
    '50mib': 50 * 1024 * 1024,
  }[size]
  return `${audit}\n\n`
    .repeat(Math.ceil(bytes / (audit.length + 2)))
    .slice(0, bytes)
}

export function editorBenchmarkPlan(selected, runs) {
  return selected.flatMap((size) =>
    Array.from({ length: runs }, (_, run) =>
      (size === '50mib'
        ? ['codemirror']
        : run % 2
          ? ['codemirror', 'tiptap']
          : ['tiptap', 'codemirror']
      ).map((engine) => ({ size, run, engine })),
    ).flat(),
  )
}

export function statistics(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  const n = sorted.length
  return {
    n,
    missing: values.length - n,
    median: n
      ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2
      : null,
    p95: n ? sorted[Math.ceil(n * 0.95) - 1] : null,
    min: n ? sorted[0] : null,
    max: n ? sorted[n - 1] : null,
  }
}

export function operationPaint(events, label) {
  const mark = (phase) =>
    events.find(
      (event) =>
        event.name === `${label}:${phase}` &&
        event.cat?.includes('blink.user_timing'),
    )
  const start = mark('start'),
    ready = mark('ready'),
    end = mark('end')
  const paint =
    ready &&
    end &&
    events
      .filter(
        (event) =>
          event.name === 'Paint' &&
          event.pid === ready.pid &&
          event.tid === ready.tid &&
          event.ts >= ready.ts &&
          event.ts < end.ts,
      )
      .sort((a, b) => a.ts - b.ts)[0]
  return {
    readyMs: start && ready ? (ready.ts - start.ts) / 1000 : null,
    paintMs: start && paint ? (paint.ts - start.ts) / 1000 : null,
    tracePaintUs: paint?.ts ?? null,
  }
}

export function requireFormattedEditor(engine, state) {
  assert.ok(
    state.mode === 'normal' && state.engine === engine && state.editable,
    `formatted editor required (${engine}); observed ${JSON.stringify(state)}. source fallback is not comparable; rebuild with large-note formatted opening support.`,
  )
}

const measurements = {
  openPaintMs: (row) => row.open.paintMs,
  keyTaskMedianMs: (row) =>
    statistics(row.keys.map((key) => key.taskMs)).median,
  keyTaskP95Ms: (row) => statistics(row.keys.map((key) => key.taskMs)).p95,
  keyPaintMedianMs: (row) =>
    statistics(row.keys.map((key) => key.paintMs)).median,
  keyPaintP95Ms: (row) => statistics(row.keys.map((key) => key.paintMs)).p95,
  findFirstPaintMs: (row) => row.find.first.paintMs,
  findNextPaintMs: (row) => row.find.next.paintMs,
  scrollMedianMs: (row) => statistics(row.scroll.frames).median,
  scrollP95Ms: (row) => statistics(row.scroll.frames).p95,
}

export function summarizeEditors(samples) {
  const groups = new Map()
  for (const sample of samples) {
    const key = `${sample.size}/${sample.engine}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(sample)
  }
  return [...groups.values()].map((group) => ({
    size: group[0].size,
    engine: group[0].engine,
    runs: group.length,
    keyPaintCoverage: {
      observed: group
        .flatMap((row) => row.keys)
        .filter((key) => Number.isFinite(key.paintMs)).length,
      total: group.reduce((sum, row) => sum + row.keys.length, 0),
    },
    metrics: Object.fromEntries(
      Object.entries(measurements).map(([name, read]) => [
        name,
        statistics(group.map(read)),
      ]),
    ),
  }))
}

// Observers read model lengths, never materialize the document while timing input.
function installProbe({ fileName, sourceLength, engine }) {
  const input = () =>
    document.querySelector(
      '.rich-pane .tiptap, .rich-pane .hibi-formatted .cm-content',
    )
  const length = () => {
    const element = input()
    return (
      element?.editor?.state.doc.content.size ??
      element?.cmTile?.root.view.state.doc.length
    )
  }
  const state = () => {
    const element = input()
    return {
      mode: [...(document.querySelector('.editor-panes')?.classList ?? [])]
        .find((name) => name.startsWith('mode-'))
        ?.slice(5),
      engine: element?.classList.contains('tiptap')
        ? 'tiptap'
        : element
          ? 'codemirror'
          : null,
      editable: !!element?.isContentEditable && !element.closest('[inert]'),
    }
  }
  const probe = { pending: null, state }
  const begin = () => {
    const pending = probe.pending
    if (!pending || pending.started) return
    pending.started = true
    performance.mark(`${pending.label}:start`)
  }
  const check = () => {
    const pending = probe.pending
    if (!pending?.started || pending.ready) return
    let ready = false
    const count = document.querySelector('.find-count')?.textContent ?? ''
    if (pending.kind === 'open') {
      const tab = document.querySelector(
        '.document-tabs [role="tab"][aria-selected="true"]',
      )
      ready =
        tab?.getAttribute('aria-label') === fileName &&
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false' &&
        document
          .querySelector('#document-editor-panel')
          ?.getAttribute('aria-busy') === 'false' &&
        document.fonts.status === 'loaded' &&
        (state().mode === 'markdown'
          ? document.querySelector('.editor-panes')?.dataset.sourceReady ===
            'true'
          : state().editable &&
            length() === sourceLength + (engine === 'tiptap' ? 2 : 0))
    } else if (pending.kind === 'key')
      ready = length() === pending.beforeLength + 1
    else ready = /^\d+\/\d+$/.test(count) && count !== pending.beforeCount
    if (!ready) return
    pending.ready = true
    pending.count = count
    performance.mark(`${pending.label}:ready`)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        performance.mark(`${pending.label}:end`)
        pending.done = true
      }),
    )
  }
  probe.arm = (label, kind) => {
    probe.pending = {
      label,
      kind,
      beforeLength: length(),
      beforeCount: document.querySelector('.find-count')?.textContent ?? '',
    }
    if (kind === 'open') begin()
  }
  const observer = new MutationObserver(check)
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  })
  document.addEventListener(
    'keydown',
    (event) => {
      if (
        (probe.pending?.kind === 'key' && event.key === 'x') ||
        (probe.pending?.kind === 'find-next' && event.key === 'Enter')
      )
        begin()
    },
    true,
  )
  document.addEventListener(
    'input',
    (event) => {
      if (
        probe.pending?.kind === 'find-first' &&
        event.target.closest('.find-bar')
      )
        begin()
    },
    true,
  )
  document.fonts.addEventListener('loadingdone', check)
  window.__editorBenchmark = probe
}

async function arm(page, label, kind) {
  await page.evaluate(
    ({ label, kind }) => window.__editorBenchmark.arm(label, kind),
    { label, kind },
  )
}

async function finish(page, label) {
  await page.waitForFunction(
    (label) =>
      window.__editorBenchmark.pending?.label === label &&
      window.__editorBenchmark.pending.done,
    label,
  )
}

async function metrics(session) {
  const values = Object.fromEntries(
    (await session.send('Performance.getMetrics')).metrics.map(
      ({ name, value }) => [name, value],
    ),
  )
  for (const name of metricNames)
    assert.ok(Number.isFinite(values[name]), `missing cdp metric: ${name}`)
  return values
}

async function scrollFrames(page, frameCount) {
  return page.evaluate(async (frameCount) => {
    const pane = document.querySelector('.rich-pane')
    pane.scrollTop = 0
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    await frame()
    await frame()
    const requestedPx = 3600
    const distancePx = Math.min(
      requestedPx,
      pane.scrollHeight - pane.clientHeight,
    )
    if (distancePx <= 0)
      return {
        requestedPx,
        distancePx: 0,
        actualPx: 0,
        frames: [],
        reason: 'document fits viewport',
      }
    const frames = []
    let previous = await frame()
    for (let index = 1; index <= frameCount; index++) {
      pane.scrollTop = (distancePx * index) / frameCount
      const now = await frame()
      frames.push(now - previous)
      previous = now
    }
    await frame()
    return { requestedPx, distancePx, actualPx: pane.scrollTop, frames }
  }, frameCount)
}

async function runSample(config, directory, file, out) {
  const { engine, size, run } = config
  const profile = join(directory, `${size}-${run}-${engine}`)
  await mkdir(profile)
  const app = await launchBenchmarkApp(profile)
  try {
    const page = await app.firstWindow()
    await waitForDocumentEditor(app, page)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 900),
    )
    await page.evaluate((engine) => {
      if (engine === 'codemirror')
        localStorage.setItem('hibi:formatted-engine', engine)
      else localStorage.removeItem('hibi:formatted-engine')
      localStorage.setItem('default-view', 'normal')
    }, engine)
    await page.reload()
    await waitForDocumentEditor(app, page)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await session.send('Performance.enable')
    await page.waitForFunction(() => document.hasFocus())
    await page.evaluate(installProbe, {
      fileName: `${size}.md`,
      sourceLength: config.sourceLength,
      engine,
    })
    const trace = `traces/${basename(directory)}-${size}-${run}-${engine}.json`
    const finishTrace = createTraceFinalizer(session, join(out, trace))
    await session.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      categories: 'devtools.timeline,blink.user_timing',
    })
    let tracing = true
    try {
      await selectBenchmarkFile(app, file)
      await arm(page, 'open', 'open')
      await clickMenu(app, 'Open…')
      await finish(page, 'open')
      const observed = await page.evaluate(() =>
        window.__editorBenchmark.state(),
      )
      requireFormattedEditor(engine, observed)
      await page.evaluate(() => {
        const element = document.querySelector(
          '.rich-pane .tiptap, .rich-pane .cm-content',
        )
        if (element.editor) {
          element.editor.commands.setTextSelection(1)
          element.editor.view.focus()
        } else {
          const view = element.cmTile.root.view
          view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true })
          view.focus()
        }
      })
      const keys = []
      for (let index = 0; index < config.keys; index++) {
        const label = `key-${index}`
        await arm(page, label, 'key')
        const before = await metrics(session)
        await page.keyboard.press('x')
        await finish(page, label)
        const after = await metrics(session)
        keys.push({
          label,
          taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
          mainThreadMs: Object.fromEntries(
            metricNames.map((name) => [
              name,
              (after[name] - before[name]) * 1000,
            ]),
          ),
        })
      }
      const canonical = await page.evaluate(() => window.hibi.getDocument())
      assert.equal(
        hash(canonical.markdown),
        config.expectedHash,
        'typed source differs from expected bytes',
      )
      const findShortcut =
        process.platform === 'darwin' ? 'Meta+f' : 'Control+f'
      await pressShortcut(app, findShortcut)
      const findInput = page.getByRole('textbox', {
        name: 'Find in document',
        exact: true,
      })
      await findInput.waitFor()
      await arm(page, 'find-first', 'find-first')
      await findInput.fill(size === 'blank' ? 'x' : 'alpha')
      await finish(page, 'find-first')
      const firstCount = await page.locator('.find-count').textContent()
      await arm(page, 'find-next', 'find-next')
      await findInput.press('Enter')
      await finish(page, 'find-next')
      const nextCount = await page.locator('.find-count').textContent()
      await findInput.press('Escape')
      await page.locator('.find-bar').waitFor({ state: 'hidden' })
      const scroll = await scrollFrames(page, config.scrollFrames)
      const traceCollection = await finishTrace()
      tracing = false
      const events = JSON.parse(
        await readFile(join(out, trace), 'utf8'),
      ).traceEvents.filter(
        (event) =>
          event.cat?.includes('blink.user_timing') || event.name === 'Paint',
      )
      await writeFile(join(out, trace), JSON.stringify({ traceEvents: events }))
      const runtime = await app.evaluate(() => ({ ...process.versions }))
      const addons = (await page.evaluate(() => window.hibi.getAddonStates()))
        .filter(({ enabled, blockedBy }) => enabled && !blockedBy?.length)
        .map(({ id }) => id)
        .sort()
      return {
        size,
        engine,
        run,
        runtime,
        addons,
        trace,
        traceCollection,
        viewport: await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
        })),
        open: operationPaint(events, 'open'),
        keys: keys.map((key) => ({
          ...key,
          ...operationPaint(events, key.label),
        })),
        find: {
          query: size === 'blank' ? 'x' : 'alpha',
          firstCount,
          nextCount,
          first: operationPaint(events, 'find-first'),
          next: operationPaint(events, 'find-next'),
        },
        scroll,
        integrity: {
          expectedHash: config.expectedHash,
          actualHash: hash(canonical.markdown),
        },
      }
    } finally {
      if (tracing) await finishTrace().catch(() => {})
    }
  } finally {
    await app.close()
  }
}

function markdownReport(report) {
  const cell = (stats) =>
    stats.n
      ? `${stats.median.toFixed(2)} [${stats.min.toFixed(2)}–${stats.max.toFixed(2)}]${stats.missing ? `; ${stats.missing} missing` : ''}`
      : 'n/a'
  return [
    `# editor comparison (${report.smoke ? 'smoke only' : report.status})`,
    '',
    `status: ${report.status}. all timings in ms; cells are median across launches [min–max]. per-key and frame p95 use nearest rank within each launch.`,
    '',
    '| size | engine | runs | key paints | open → paint | key task median | key task p95 | key → paint median | key → paint p95 | first find → paint | next find → paint | scroll frame median | scroll frame p95 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.summary.map(
      (row) =>
        `| ${row.size} | ${row.engine} | ${row.runs} | ${row.keyPaintCoverage.observed}/${row.keyPaintCoverage.total} | ${Object.values(row.metrics).map(cell).join(' | ')} |`,
    ),
    '',
    'hidden windows, focus emulation, fresh profiles; engine order alternates within balanced pairs (ab, ba). startup and engine-selection reload are excluded. no os cache clearing.',
    'open starts before the native open menu call and ends at the first renderer Paint after editable formatted DOM with the expected model length and loaded fonts. keys start at renderer keydown; find starts at input/enter. ready and paint milestones are retained separately.',
    'Paint is a same-thread temporal trace match within the operation, not proof of glyph presentation or physical keyboard latency. missing paint is n/a, never zero. cdp task deltas include observer/driver work and work during the two-frame settlement.',
    'scroll requests 3600 css px over a fixed number of animation frames; short documents clamp distance. documents that fit have no scroll sample. raw distances and frame intervals are in results.json.',
    report.smoke
      ? 'smoke numbers validate the sampler under shared load; they establish no performance ranking or full-matrix pass.'
      : 'compare complete pairs on a quiet machine; this report does not enforce a speed threshold.',
    ...(report.error ? ['', `failure: ${report.error}`] : []),
    '',
  ].join('\n')
}

async function main() {
  const { values } = parseArgs({
    options: {
      smoke: { type: 'boolean', default: false },
      runs: { type: 'string' },
      keys: { type: 'string' },
      'scroll-frames': { type: 'string' },
      sizes: { type: 'string' },
      out: { type: 'string', default: 'test-results/editor-benchmark' },
    },
  })
  assert.ok(
    !showTestWindows,
    'editor comparison requires hidden test windows; unset window-visibility overrides',
  )
  const selected =
    values.sizes?.split(',') ?? (values.smoke ? sizes.slice(0, 2) : sizes)
  assert.ok(
    selected.length &&
      selected.every((size) => sizes.includes(size)) &&
      new Set(selected).size === selected.length,
    'unknown or repeated sizes',
  )
  if (values.smoke)
    assert.ok(
      selected.every((size) => ['blank', '100kb'].includes(size)),
      'smoke is limited to blank and 100kb',
    )
  const positive = (value, minimum) => {
    const number = Number(value)
    assert.ok(
      Number.isSafeInteger(number) && number >= minimum,
      `expected integer >= ${minimum}`,
    )
    return number
  }
  const runs = positive(values.runs ?? (values.smoke ? 2 : 5), 1)
  const keys = positive(values.keys ?? (values.smoke ? 4 : 20), 2)
  const frameCount = positive(
    values['scroll-frames'] ?? (values.smoke ? 12 : 60),
    2,
  )
  const out = resolve(values.out)
  await mkdir(join(out, 'traces'), { recursive: true })
  const directory = await mkdtemp(join(out, 'scratch-'))
  const report = {
    smoke: values.smoke,
    status: 'running',
    startedAt: new Date().toISOString(),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    samplerHash: hash(await readFile(new URL(import.meta.url))),
    buildHash: hash(await readFile('out/main/index.js')),
    lockfileHash: hash(await readFile('package-lock.json')),
    dependencies: Object.fromEntries(
      await Promise.all(
        [
          '@tiptap/core',
          '@codemirror/view',
          '@lezer/markdown',
          'playwright',
        ].map(async (name) => [
          name,
          JSON.parse(
            await readFile(`node_modules/${name}/package.json`, 'utf8'),
          ).version,
        ]),
      ),
    ),
    host: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      release: release(),
      cpu: cpus()[0]?.model,
      logicalCores: cpus().length,
    },
    config: {
      runs,
      keys,
      scrollFrames: frameCount,
      selected,
      hidden: true,
      focusEmulation: true,
      scrollPx: 3600,
      order: 'ab, ba',
    },
    fixtures: [],
    samples: [],
    summary: [],
  }
  const save = async () => {
    report.summary = summarizeEditors(report.samples)
    await writeFile(
      join(out, 'results.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    )
    await writeFile(join(out, 'table.md'), markdownReport(report))
  }
  try {
    for (const size of selected) {
      const source = editorFixture(size)
      const file = join(directory, `${size}.md`)
      await writeFile(file, source)
      report.fixtures.push({
        size,
        bytes: Buffer.byteLength(source),
        sha256: hash(source),
      })
      for (const row of editorBenchmarkPlan([size], runs)) {
        console.error(
          `${values.smoke ? 'smoke ' : ''}${size} ${row.engine} run ${row.run + 1}/${runs}`,
        )
        const sample = await runSample(
          {
            ...row,
            keys,
            scrollFrames: frameCount,
            sourceLength: source.length,
            expectedHash: hash('x'.repeat(keys) + source),
          },
          directory,
          file,
          out,
        )
        const other = report.samples.find(
          (sample) => sample.size === size && sample.engine !== row.engine,
        )
        if (other)
          assert.deepEqual(
            sample.addons,
            other.addons,
            'paired engines must use the same addons',
          )
        report.samples.push(sample)
        await save()
      }
    }
    report.status = 'complete'
  } catch (error) {
    report.status = 'failed'
    report.error = error.message
    process.exitCode = 1
    console.error(error)
  } finally {
    report.finishedAt = new Date().toISOString()
    await save()
    await rm(directory, { recursive: true, force: true })
  }
  console.log(markdownReport(report))
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await main()
