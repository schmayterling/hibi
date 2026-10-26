import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { cpus, loadavg, release } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { showTestWindows, waitForDocumentEditor } from '../tests/electron.mjs'
import { clickMenu, pressShortcut } from '../tests/keyboard.mjs'
import { launchBenchmarkApp, selectBenchmarkFile } from './benchmark-flows.mjs'
import { createTraceFinalizer } from './trace-stream.mjs'

const sizes = ['blank', '100kb', '575kb', '2mb', '50mib']
const fixtures = ['prose', 'mixed']
const metricNames = [
  'TaskDuration',
  'ScriptDuration',
  'LayoutDuration',
  'RecalcStyleDuration',
]
const hash = (source) => createHash('sha256').update(source).digest('hex')

export function editorFixture(size, fixture = 'prose') {
  assert.ok(sizes.includes(size), `unknown fixture: ${size}`)
  assert.ok(fixtures.includes(fixture), `unknown fixture kind: ${fixture}`)
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
  const prose = Array.from(
    { length: 100000 },
    (_, index) =>
      `${index ? (index % 20 === 0 ? '\n\n' : ' ') : ''}${words[index % words.length]}`,
  ).join('')
  const bytes = {
    '100kb': 100000,
    '575kb': prose.length,
    '2mb': 2000000,
    '50mib': 50 * 1024 * 1024,
  }[size]
  const mixed = [
    'alpha beta gamma delta.',
    '# Heading',
    'Paragraph with **bold**, *italic*, and a [link](https://example.com/).',
    '- first item\n- second item',
    '1. ordered item\n2. another item',
    '```js\nconst answer = 42\n```',
    '| name | value |\n| --- | --- |\n| alpha | beta |',
    'Inline math $x^2$ and display math:\n\n$$\nx^2 + y^2 = z^2\n$$',
  ].join('\n\n')
  const block = `${fixture === 'mixed' ? mixed : prose}\n\n`
  return block.repeat(Math.ceil(bytes / block.length)).slice(0, bytes)
}

export function editorBenchmarkPlan(
  selected,
  runs,
  selectedFixtures = fixtures,
) {
  assert.ok(
    Number.isSafeInteger(runs) && runs >= 2 && runs % 2 === 0,
    'runs must be an even integer >= 2 for balanced ab/ba order',
  )
  return selected.flatMap((size) =>
    (size === 'blank' ? ['prose'] : selectedFixtures).flatMap((fixture) =>
      Array.from({ length: runs }, (_, run) =>
        (size === '50mib'
          ? ['codemirror']
          : run % 2
            ? ['codemirror', 'tiptap']
            : ['tiptap', 'codemirror']
        ).map((engine) => ({ size, fixture, run, engine })),
      ).flat(),
    ),
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

export function operationPaint(events, label, startLabel = label) {
  const mark = (phase) =>
    events.find(
      (event) =>
        event.name === `${phase === 'start' ? startLabel : label}:${phase}` &&
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

export function requireFormattedEditor(engine, state, mixed = false) {
  assert.ok(
    state.mode === 'normal' && state.engine === engine && state.editable,
    `formatted editor required (${engine}); observed ${JSON.stringify(state)}. source fallback is not comparable; rebuild with large-note formatted opening support.`,
  )
  if (mixed)
    assert.ok(
      state.formatted,
      'mixed fixture requires a rendered formatted element',
    )
}

export async function ensureFormattedEditor(
  engine,
  state,
  switchView,
  mixed = false,
) {
  const path = state.mode === 'markdown' ? 'source-first' : 'formatted'
  const open = {
    path,
    method: path === 'source-first' ? 'open+switch' : 'open',
  }
  if (path === 'source-first') {
    if (engine === 'codemirror')
      return {
        ...open,
        method: 'n/a',
        unavailable:
          'codemirror source-first: large-note formatted opening needs #450',
        dependency: '#450',
      }
    state = await switchView()
    open.afterSwitch = state
  }
  if (state.mode === 'side-by-side' && state.preview && !state.editable)
    return {
      ...open,
      method: 'n/a',
      unavailable: 'formatted editing unavailable: observed read-only preview',
    }
  requireFormattedEditor(engine, state, mixed)
  return open
}

export async function captureEditorSample(config, measure) {
  const sample = {
    ...config,
    startedAt: new Date().toISOString(),
    loadAverage: loadavg(),
  }
  try {
    return { ...sample, status: 'complete', ...(await measure()) }
  } catch (error) {
    return {
      ...sample,
      ...error.sample,
      status: 'failed',
      error: error.message,
    }
  }
}

const measurements = {
  openReadyMs: (row) => row.open.readyMs,
  openPaintMs: (row) => row.open.paintMs,
  findFirstPaintMs: (row) => row.find.first.paintMs,
  findNextPaintMs: (row) => row.find.next.paintMs,
  scrollMainThreadPerFrameMs: (row) => row.scroll.mainThreadPerFrameMs,
  scrollMedianMs: (row) => statistics(row.scroll.frames).median,
  scrollP95Ms: (row) => statistics(row.scroll.frames).p95,
}

export function summarizeEditors(samples) {
  const groups = new Map()
  for (const sample of samples) {
    const key = `${sample.size}/${sample.fixture}/${sample.engine}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(sample)
  }
  return [...groups.values()].map((attempts) => {
    const group = attempts.filter((sample) => sample.status === 'complete')
    const keys = group.flatMap((sample) => sample.keys)
    return {
      size: attempts[0].size,
      fixture: attempts[0].fixture,
      engine: attempts[0].engine,
      runs: group.length,
      failed: attempts.filter((sample) => sample.status === 'failed').length,
      unavailable: attempts.filter((sample) => sample.status === 'unavailable')
        .length,
      openMethods: [...new Set(group.map((sample) => sample.open.method))],
      keyPaintCoverage: {
        observed: keys.filter((key) => Number.isFinite(key.paintMs)).length,
        total: keys.length,
      },
      metrics: {
        ...Object.fromEntries(
          Object.entries(measurements).map(([name, read]) => [
            name,
            statistics(group.map(read)),
          ]),
        ),
        keyTaskMs: statistics(keys.map((key) => key.taskMs)),
        keyReadyMs: statistics(keys.map((key) => key.readyMs)),
        keyPaintMs: statistics(keys.map((key) => key.paintMs)),
      },
    }
  })
}

// Observers read model lengths, never materialize the document while timing input.
function installProbe({ fileName, sourceLength, engine, fixture }) {
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
      formatted: !!document.querySelector(
        '.rich-pane .tiptap h1, .rich-pane .hibi-lp-h1',
      ),
      preview: !!document.querySelector('.rich-pane .large-markdown-preview'),
      sourceReady:
        document.querySelector('.editor-panes')?.dataset.sourceReady === 'true',
      modelLength: length(),
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
    if (!pending?.started || pending.ready || pending.done) return
    let ready = false
    const count = document.querySelector('.find-count')?.textContent ?? ''
    if (pending.kind === 'open' || pending.kind === 'switch') {
      const tab = document.querySelector(
        '.document-tabs [role="tab"][aria-selected="true"]',
      )
      const observed = state()
      const settled =
        tab?.getAttribute('aria-label') === fileName &&
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false' &&
        document
          .querySelector('#document-editor-panel')
          ?.getAttribute('aria-busy') === 'false' &&
        document.fonts.status === 'loaded'
      if (
        settled &&
        observed.mode === 'side-by-side' &&
        observed.preview &&
        !observed.editable &&
        observed.sourceReady
      ) {
        performance.mark(`${pending.label}:unavailable`)
        pending.done = true
        return
      }
      ready =
        settled &&
        (observed.mode === 'markdown' && pending.kind === 'open'
          ? observed.sourceReady
          : observed.mode === 'normal' &&
            observed.engine === engine &&
            observed.editable &&
            (fixture === 'mixed'
              ? observed.formatted && length() > 0
              : length() === sourceLength + (engine === 'tiptap' ? 2 : 0)))
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
    if (kind === 'open' || kind === 'switch') begin()
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

export async function scrollFrames(page, session, frameCount) {
  await page.evaluate(async () => {
    document.querySelector('.rich-pane').scrollTop = 0
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
  })
  const before = await metrics(session)
  const scroll = await page.evaluate(async (frameCount) => {
    const pane = document.querySelector('.rich-pane')
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
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
    performance.mark('scroll:start')
    const frames = []
    let previous = await frame()
    for (let index = 1; index <= frameCount; index++) {
      pane.scrollTop = (distancePx * index) / frameCount
      const now = await frame()
      frames.push(now - previous)
      previous = now
    }
    await frame()
    performance.mark('scroll:end')
    return { requestedPx, distancePx, actualPx: pane.scrollTop, frames }
  }, frameCount)
  const after = await metrics(session)
  const taskMs = (after.TaskDuration - before.TaskDuration) * 1000
  return {
    ...scroll,
    taskMs: scroll.frames.length ? taskMs : null,
    mainThreadPerFrameMs: scroll.frames.length
      ? taskMs / scroll.frames.length
      : null,
  }
}

async function runSample(config, directory, file, out) {
  const { engine, size, fixture, run } = config
  const sample = {}
  const profile = join(directory, `${size}-${fixture}-${run}-${engine}`)
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
      fileName: basename(file),
      sourceLength: config.sourceLength,
      engine,
      fixture,
    })
    const trace = `traces/${basename(directory)}-${size}-${fixture}-${run}-${engine}.json`
    sample.trace = trace
    const finishTrace = createTraceFinalizer(session, join(out, trace))
    await session.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      categories:
        'devtools.timeline,blink.user_timing,v8,disabled-by-default-devtools.timeline.frame,disabled-by-default-v8.gc',
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
      sample.open = {
        path: observed.mode === 'markdown' ? 'source-first' : 'formatted',
        observed,
      }
      Object.assign(
        sample.open,
        await ensureFormattedEditor(
          engine,
          observed,
          async () => {
            await arm(page, 'switch', 'switch')
            await page
              .getByRole('button', { name: 'normal', exact: true })
              .click()
            await finish(page, 'switch')
            return page.evaluate(() => window.__editorBenchmark.state())
          },
          fixture === 'mixed',
        ),
      )
      const opened = await page.evaluate(() => window.hibi.getDocument())
      assert.equal(
        hash(opened.markdown),
        config.sourceHash,
        'opened source differs from fixture',
      )
      sample.integrity = {
        expectedHash: config.sourceHash,
        actualHash: hash(opened.markdown),
      }
      if (!sample.open.unavailable) {
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
        await arm(page, 'warmup', 'key')
        await page.keyboard.press('x')
        await finish(page, 'warmup')
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
        sample.scroll = await scrollFrames(page, session, config.scrollFrames)
        sample.keys = keys
        sample.find = {
          query: size === 'blank' ? 'x' : 'alpha',
          firstCount,
          nextCount,
        }
        sample.integrity = {
          expectedHash: config.expectedHash,
          actualHash: hash(canonical.markdown),
        }
      } else sample.status = 'unavailable'
      const traceCollection = await finishTrace()
      tracing = false
      const events = JSON.parse(
        await readFile(join(out, trace), 'utf8'),
      ).traceEvents
      const runtime = await app.evaluate(() => ({ ...process.versions }))
      const addons = (await page.evaluate(() => window.hibi.getAddonStates()))
        .filter(({ enabled, blockedBy }) => enabled && !blockedBy?.length)
        .map(({ id }) => id)
        .sort()
      return {
        ...sample,
        runtime,
        addons,
        trace,
        traceCollection,
        viewport: await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
        })),
        open: {
          ...sample.open,
          ...(sample.open.unavailable
            ? { readyMs: null, paintMs: null, tracePaintUs: null }
            : operationPaint(
                events,
                sample.open.method === 'open+switch' ? 'switch' : 'open',
                'open',
              )),
          source:
            sample.open.path === 'source-first'
              ? operationPaint(events, 'open')
              : null,
          switch: sample.open.afterSwitch
            ? operationPaint(events, 'switch')
            : null,
        },
        keys: (sample.keys ?? []).map((key) => ({
          ...key,
          ...operationPaint(events, key.label),
        })),
        find: sample.find
          ? {
              ...sample.find,
              first: operationPaint(events, 'find-first'),
              next: operationPaint(events, 'find-next'),
            }
          : null,
        scroll: sample.scroll ?? null,
      }
    } finally {
      if (tracing) await finishTrace().catch(() => {})
    }
  } catch (error) {
    throw Object.assign(error, { sample })
  } finally {
    await app.close()
  }
}

function markdownReport(report) {
  const columns = [
    ['open readyMs', 'openReadyMs'],
    ['open → paint', 'openPaintMs'],
    ['key task median', 'keyTaskMs'],
    ['key task p95', 'keyTaskMs', 'p95'],
    ['key processing median', 'keyReadyMs'],
    ['key processing p95', 'keyReadyMs', 'p95'],
    ['key → paint median', 'keyPaintMs'],
    ['key → paint p95', 'keyPaintMs', 'p95'],
    ['first find → paint', 'findFirstPaintMs'],
    ['next find → paint', 'findNextPaintMs'],
    ['scroll main/frame', 'scrollMainThreadPerFrameMs'],
    ['scroll interval median', 'scrollMedianMs'],
    ['scroll interval p95', 'scrollP95Ms'],
  ]
  const cell = (stats, value = 'median') =>
    stats.n
      ? `${stats[value].toFixed(2)} [${stats.min.toFixed(2)}–${stats.max.toFixed(2)}]${stats.missing ? `; ${stats.missing} missing` : ''}`
      : 'n/a'
  return [
    `# editor comparison (${report.smoke ? 'smoke only' : report.status})`,
    '',
    `status: ${report.status}. all timings in ms; cells are median [min–max], or nearest-rank p95 where named. key statistics pool measured keys across launches; other statistics summarize launches.`,
    '',
    `| size | fixture | engine | passed/failed/unavailable | open method | key paints | ${columns.map(([name]) => name).join(' | ')} |`,
    `| --- | --- | --- | ---: | --- | ---: | ${columns.map(() => '---:').join(' | ')} |`,
    ...report.summary.map(
      (row) =>
        `| ${row.size} | ${row.fixture} | ${row.engine} | ${row.runs}/${row.failed}/${row.unavailable} | ${row.openMethods.join(', ') || 'n/a'} | ${row.keyPaintCoverage.observed}/${row.keyPaintCoverage.total} | ${columns.map(([, name, value]) => cell(row.metrics[name], value)).join(' | ')} |`,
    ),
    '',
    'hidden windows, focus emulation, fresh profiles; engine order alternates within balanced pairs (ab, ba). startup and engine-selection reload are excluded. no os cache clearing.',
    'open readyMs ends at editable formatted DOM with loaded fonts; mixed fixtures also require a rendered heading. open paint is the first subsequent renderer Paint. source-first tiptap attempts normal view; open+switch is reported only if an editable formatted view becomes ready. an observed read-only preview, or codemirror source fallback needing #450, records unavailable formatted metrics while retaining source-open timing, capability state, source hash and traces. unavailable samples make the report partial; unexpected errors fail it. the matrix continues in both cases.',
    'one untimed warm-up key precedes measured keys. key processing is keydown → model-ready (readyMs); cdp task deltas also include observer/driver work and two-frame settlement. key → paint is mostly next-frame wait (0.6–14.8 ms in prior input traces); it is not a processing-time metric.',
    'Paint is a same-thread temporal trace match within the operation, not proof of glyph presentation or physical keyboard latency. missing paint is n/a, never zero. full frame, layout, gc and User Timing evidence is retained in traces.',
    'scroll requests 3600 css px over a fixed number of animation frames after resetting and settling at the top. main/frame is the CDP TaskDuration delta divided by measured scroll frames; it includes the scroll driver and final settlement. short documents clamp distance; documents that fit have no scroll sample. raw task deltas, distances and frame intervals are in results.json.',
    "the prose 575kb fixture is trace-input-paint.mjs's exact 574,998-byte, 100,000-word paragraph fixture. mixed fixtures repeat headings, emphasis, links, lists, code, a table and math at the same byte sizes. math rendering depends on the enabled addons recorded per sample.",
    report.smoke
      ? 'smoke numbers validate the sampler under shared load; they establish no performance ranking or full-matrix pass.'
      : 'compare complete pairs on a quiet machine; this report does not enforce a speed threshold.',
    ...report.samples
      .filter((sample) => sample.status !== 'complete')
      .map(
        (sample) =>
          `${sample.status}: ${sample.size}/${sample.fixture}/${sample.engine} run ${sample.run + 1}: ${sample.error ?? sample.open.unavailable}`,
      ),
    ...(report.error ? ['', `failure: ${report.error}`] : []),
    '',
  ].join('\n')
}

async function fileHashes(paths) {
  const result = {}
  for (const path of paths.sort()) result[path] = hash(await readFile(path))
  return result
}

async function main() {
  const { values } = parseArgs({
    options: {
      smoke: { type: 'boolean', default: false },
      runs: { type: 'string' },
      keys: { type: 'string' },
      'scroll-frames': { type: 'string' },
      sizes: { type: 'string' },
      fixtures: { type: 'string' },
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
  const selectedFixtures = values.fixtures?.split(',') ?? fixtures
  assert.ok(
    selectedFixtures.length &&
      selectedFixtures.every((fixture) => fixtures.includes(fixture)) &&
      new Set(selectedFixtures).size === selectedFixtures.length,
    'unknown or repeated fixtures',
  )
  const positive = (value, minimum) => {
    const number = Number(value)
    assert.ok(
      Number.isSafeInteger(number) && number >= minimum,
      `expected integer >= ${minimum}`,
    )
    return number
  }
  const runs = positive(values.runs ?? (values.smoke ? 2 : 6), 2)
  const plan = editorBenchmarkPlan(selected, runs, selectedFixtures)
  const keys = positive(values.keys ?? (values.smoke ? 4 : 20), 2)
  const frameCount = positive(
    values['scroll-frames'] ?? (values.smoke ? 12 : 60),
    2,
  )
  const out = resolve(values.out)
  await mkdir(join(out, 'traces'), { recursive: true })
  const directory = await mkdtemp(join(out, 'scratch-'))
  const rendererFiles = await fileHashes(
    (await readdir('out/renderer', { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name)),
  )
  const report = {
    smoke: values.smoke,
    status: 'running',
    startedAt: new Date().toISOString(),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    gitStatus: execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8',
    }),
    samplerHash: hash(await readFile(new URL(import.meta.url))),
    helperHashes: await fileHashes([
      'scripts/benchmark-flows.mjs',
      'scripts/trace-stream.mjs',
      'tests/electron.mjs',
      'tests/keyboard.mjs',
    ]),
    rendererBuildHash: hash(JSON.stringify(rendererFiles)),
    rendererFiles,
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
      fixtures: selectedFixtures,
      warmupKeys: 1,
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
      for (const fixture of size === 'blank' ? ['prose'] : selectedFixtures) {
        const source = editorFixture(size, fixture)
        const file = join(directory, `${size}-${fixture}.md`)
        await writeFile(file, source)
        report.fixtures.push({
          size,
          fixture,
          bytes: Buffer.byteLength(source),
          sha256: hash(source),
        })
        for (const row of plan.filter(
          (row) => row.size === size && row.fixture === fixture,
        )) {
          console.error(
            `${values.smoke ? 'smoke ' : ''}${size} ${fixture} ${row.engine} run ${row.run + 1}/${runs}`,
          )
          const sample = await captureEditorSample(row, async () => {
            const sample = await runSample(
              {
                ...row,
                keys,
                scrollFrames: frameCount,
                sourceLength: source.length,
                sourceHash: hash(source),
                expectedHash: hash('x'.repeat(keys + 1) + source),
              },
              directory,
              file,
              out,
            )
            const other = report.samples.find(
              (sample) =>
                sample.status === 'complete' &&
                sample.size === size &&
                sample.fixture === fixture &&
                sample.engine !== row.engine,
            )
            if (other)
              assert.deepEqual(
                sample.addons,
                other.addons,
                'paired engines must use the same addons',
              )
            return sample
          })
          report.samples.push(sample)
          if (sample.status !== 'complete')
            console.error(
              `sample ${sample.status}: ${sample.error ?? sample.open.unavailable}`,
            )
          await save()
        }
      }
    }
    report.status = report.samples.some((sample) => sample.status === 'failed')
      ? 'failed'
      : report.samples.some((sample) => sample.status === 'unavailable')
        ? 'partial'
        : 'complete'
    if (report.status === 'failed') process.exitCode = 1
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
