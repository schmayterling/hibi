import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron } from '../tests/electron.mjs'

const backend = process.argv.includes('--backend')
const runs = Number(
  process.argv.find((arg) => arg.startsWith('--runs='))?.slice(7) ?? 5,
)
const extraAddons = Number(
  process.argv.find((arg) => arg.startsWith('--addons='))?.slice(9) ?? 0,
)
if (
  !Number.isSafeInteger(runs) ||
  runs < 5 ||
  runs > 30 ||
  !Number.isSafeInteger(extraAddons) ||
  extraAddons < 0 ||
  extraAddons > 200
)
  throw new Error('Use --runs=5..30 and --addons=0..200.')

const entry = resolve(
  process.argv.find((arg) => arg.startsWith('--entry='))?.slice(8) ?? '.',
)
const directory = await mkdtemp(join(tmpdir(), 'hibi-foundations-ipc-'))
const profile = join(directory, 'profile')
const workspace = join(directory, 'notes')
const addon = join(profile, 'installed-addons', 'foundations-ipc-benchmark')
const source = `# Existing\n\n${'Representative note content.\n'.repeat(100)}`
const head = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
const report = {
  head,
  dirty: execFileSync('git', ['status', '--short'], {
    encoding: 'utf8',
  }).trim(),
  runtime: null,
  buildSha256: null,
  measurement:
    'Trusted invocations through the main index.ts handle wrapper and workspace:changed-v2 sends. Byte values are v8.serialize structured-clone payload estimates, not Electron wire bytes. Other handlers, rejected senders, and outgoing channels are excluded.',
  operations: [],
}

function difference(after, before) {
  return Object.fromEntries(
    Object.entries(after).flatMap(([channel, count]) => {
      const previous = before[channel] ?? {}
      const delta = Object.fromEntries(
        Object.entries(count).map(([key, value]) => [
          key,
          value - (previous[key] ?? 0),
        ]),
      )
      return delta.calls ? [[channel, delta]] : []
    }),
  )
}

let app
try {
  report.buildSha256 = createHash('sha256')
    .update(
      await readFile(
        entry.endsWith('.js') ? entry : join(entry, 'out/main/index.js'),
      ),
    )
    .digest('hex')
  await mkdir(workspace)
  await mkdir(addon, { recursive: true })
  await writeFile(join(workspace, 'existing.md'), source)
  await writeFile(join(workspace, 'other.md'), '# Other\n')
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({
      'foundations-ipc-benchmark': true,
    }),
  )
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'foundations-ipc-benchmark',
      name: 'Foundations IPC benchmark',
      description: 'Temporary workspace API measurement addon',
      kind: 'extension',
      apiVersion: 3,
      version: '1.0.0',
      authors: [{ displayName: 'Hibi benchmark' }],
      capabilities: [],
      startup: 'background',
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'b'.repeat(64),
      files: ['index.js', 'hibi-addon.json'],
      source: 'local',
    }),
  )
  await writeFile(
    join(addon, 'index.js'),
    'export default () => ({ start(context) { window.__foundationsIpcAddon = { workspace: context.workspace, changes: [] }; } })',
  )

  if (backend) {
    for (let index = 0; index < extraAddons; index++) {
      const id = `ipc-extra-${index}`
      const folder = join(profile, 'installed-addons', id)
      await mkdir(folder, { recursive: true })
      await writeFile(
        join(folder, 'hibi-addon.json'),
        JSON.stringify({
          id,
          name: id,
          description: 'IPC scale fixture.',
          kind: 'extension',
          apiVersion: 3,
          version: '1.0.0',
          defaultEnabled: false,
          authors: [{ displayName: 'Benchmark' }],
          capabilities: [],
          entry: 'index.js',
        }),
      )
      await writeFile(
        join(folder, 'index.js'),
        'export default () => ({ start() {} })',
      )
      await writeFile(
        join(folder, '.hibi-install.json'),
        JSON.stringify({
          hash: 'a'.repeat(64),
          files: ['index.js', 'hibi-addon.json'],
          source: 'local',
        }),
      )
    }
  }

  app = await electron.launch({
    args: [entry, `--user-data-dir=${profile}`],
    env: { ...process.env, HIBI_FOUNDATIONS_IPC_BENCH: '1' },
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(12_000)
  report.runtime = await app.evaluate(() => process.versions)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, workspace)
  await page.locator('.titlebar').waitFor()
  await page.waitForFunction(() => !!window.__foundationsIpcAddon)
  await page.evaluate(() => window.hibi.openWorkspace())
  const target = await page.evaluate(async () => {
    const addon = window.__foundationsIpcAddon
    addon.subscription = await addon.workspace.subscribeChanges((change) =>
      addon.changes.push(change),
    )
    return addon.subscription.snapshot.target
  })
  assert.ok(target, 'workspace target must be available to installed addon')

  const counters = () =>
    app.evaluate(() => globalThis.__hibiFoundationsIpcBenchmark.snapshot())
  async function measure(name, channel, operation) {
    const before = await counters()
    const value = await operation()
    const after = await counters()
    const sample = {
      name,
      invokes: difference(after.invokes, before.invokes),
      sends: difference(after.sends, before.sends),
    }
    assert.equal(sample.invokes[channel]?.calls, 1, `${name} invoke count`)
    assert.equal(
      sample.invokes[channel]?.failedCalls,
      0,
      `${name} failed calls`,
    )
    assert.equal(
      sample.invokes[channel]?.unavailableEstimates,
      0,
      `${name} unavailable byte estimates`,
    )
    report.operations.push(sample)
    return value
  }

  const snapshot = await measure(
    'change snapshot',
    'workspace:change-snapshot',
    () =>
      page.evaluate(() =>
        window.__foundationsIpcAddon.workspace.changeSnapshot(),
      ),
  )
  assert.deepEqual(snapshot.target, target)
  const listed = await measure('list page', 'workspace:list-page', () =>
    page.evaluate(
      ({ target, sequence }) =>
        window.__foundationsIpcAddon.workspace.listPage({
          target,
          sequence,
          limit: 2,
        }),
      { target, sequence: snapshot.sequence },
    ),
  )
  assert.equal(listed.ok, true)
  assert.equal(listed.value.entries.length, 2)
  const read = await measure('read text', 'workspace:read-text', () =>
    page.evaluate(
      (captured) =>
        window.__foundationsIpcAddon.workspace.readText(
          captured,
          'existing.md',
        ),
      target,
    ),
  )
  assert.equal(read.ok, true)
  assert.equal(read.value.markdown, source)
  const created = await measure(
    'create text',
    'workspace:create-text',
    async () => {
      const result = await page.evaluate(
        (captured) =>
          window.__foundationsIpcAddon.workspace.createText(
            captured,
            'created.md',
            '# Created\n',
          ),
        target,
      )
      await page.waitForFunction(() =>
        window.__foundationsIpcAddon.changes.some((change) =>
          change.paths?.includes('created.md'),
        ),
      )
      return result
    },
  )
  assert.equal(created.ok, true)
  assert.equal(
    await readFile(join(workspace, 'created.md'), 'utf8'),
    '# Created\n',
  )
  assert.ok(
    report.operations.at(-1).sends['workspace:changed-v2']?.calls >= 1,
    'create must send workspace change to subscribed addon',
  )
  await page.evaluate(() => window.__foundationsIpcAddon.subscription.dispose())
  if (backend) report.backend = await measureBackend(app, page)
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (app) await app.close()
  await rm(directory, { recursive: true, force: true })
}

function distribution(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    samples: samples.length,
    medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    rawMs: samples,
  }
}

async function measureBackend(app, page) {
  const result = {
    runs,
    extraAddons,
    addons: (await page.evaluate(() => window.hibi.getAddonStates())).length,
    load: execFileSync('uptime', { encoding: 'utf8' }).trim(),
    scope:
      'Production IPC round trips for three small persistent writes per run near the 16 MiB namespace limit. Retained memory is measured after full main-process collection, outside timing.',
  }
  const heap = () =>
    app.evaluate(async () => {
      const { Session } = process.getBuiltinModule('inspector')
      const session = new Session()
      session.connect()
      await new Promise((resolve, reject) =>
        session.post('HeapProfiler.collectGarbage', (error) =>
          error ? reject(error) : resolve(),
        ),
      )
      const { heapUsed, external, rss } = process.memoryUsage()
      session.disconnect()
      return { heapUsed, external, rss }
    })
  const beforeHeap = await heap()
  const owner = 'foundations-ipc-benchmark'
  const request = { owner, scope: { kind: 'global' }, version: 1 }
  await page.evaluate(async (request) => {
    for (const key of ['bulk-a', 'bulk-b']) {
      const value = await window.hibi.writeAddonStorage({
        ...request,
        key,
        value: 'x'.repeat(7.5 * 1024 * 1024),
        baseRevision: 0,
      })
      if (value.status !== 'saved') throw new Error('Storage seed failed.')
    }
  }, request)
  const storage = join(profile, 'addon-storage', 'global', `${owner}.json`)
  const namespaceBytes = Buffer.byteLength(await readFile(storage))
  const writes = await page.evaluate(
    async ({ request, runs }) => {
      const samples = []
      let revision = 0
      for (let index = 0; index < runs * 3; index++) {
        const start = performance.now()
        const value = await window.hibi.writeAddonStorage({
          ...request,
          key: 'tick',
          value: index,
          baseRevision: revision,
        })
        if (value.status !== 'saved') throw new Error('Storage write failed.')
        revision = value.revision
        samples.push(performance.now() - start)
      }
      return samples
    },
    { request, runs },
  )
  const afterHeap = await heap()
  result.storage = {
    namespaceBytes,
    ...distribution(writes),
    retainedHeapBytes: afterHeap.heapUsed - beforeHeap.heapUsed,
    retainedExternalBytes: afterHeap.external - beforeHeap.external,
    rssDeltaBytes: afterHeap.rss - beforeHeap.rss,
  }
  return result
}
