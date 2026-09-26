import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron } from '../tests/electron.mjs'

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
  measurement:
    'Main-process ipcMain.handle invokes and workspace:changed-v2 sends. Byte values are v8.serialize structured-clone payload estimates, not Electron wire bytes. Other ipcMain.on and outgoing channels are excluded.',
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
      apiVersion: 2,
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

  app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
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
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (app) await app.close()
  await rm(directory, { recursive: true, force: true })
}
