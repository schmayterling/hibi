import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron, waitForDocumentEditor } from '../tests/electron.mjs'

function cpuTotals() {
  return cpus().reduce(
    (total, cpu) => ({
      idle: total.idle + cpu.times.idle,
      total:
        total.total +
        Object.values(cpu.times).reduce((sum, value) => sum + value, 0),
    }),
    { idle: 0, total: 0 },
  )
}

const [appRoot, workspace] = process.argv.slice(2)
if (!appRoot || !workspace)
  throw new Error(
    'usage: node scripts/probe-workspace-open.mjs <built app root> <workspace>',
  )

const profileRoot = await mkdtemp(join(tmpdir(), 'hibi-workspace-probe-'))
const profile = join(profileRoot, 'profile')
let application
try {
  await mkdir(profile)
  const addonPreferences = {}
  const addonRoot = join(resolve(appRoot), 'src/addons')
  for (const entry of await readdir(addonRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const { id } = JSON.parse(
        await readFile(join(addonRoot, entry.name, 'hibi-addon.json'), 'utf8'),
      )
      addonPreferences[id] = id === 'markdown'
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify(addonPreferences),
  )
  // The older build needs this preference to accept the same large fixture.
  await writeFile(
    join(profile, 'workspace-settings.json'),
    JSON.stringify({
      enabled: false,
      showAllFiles: false,
      entryLimit: 100000,
      path: null,
      startup: 'empty',
      startupFolder: null,
    }),
  )
  application = await electron.launch({
    args: [resolve(appRoot), `--user-data-dir=${profile}`],
  })
  const page = await application.firstWindow()
  await waitForDocumentEditor(application, page)
  const runtime = await application.evaluate(({ app, BrowserWindow }) => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    mainNode: process.versions.node,
    chromium: process.versions.chrome,
    hidden: BrowserWindow.getAllWindows().every(
      (window) => !window.isVisible(),
    ),
  }))
  const addons = await page.evaluate(
    async () => (await window.hibi.bootstrap.addons()).states,
  )
  if (
    addons.some(
      (state) =>
        state.savedEnabled !== (state.id === 'markdown') ||
        state.enabled !== (state.id === 'markdown'),
    )
  )
    throw new Error('sampler requires explicit markdown-only addon states.')
  const folder = await realpath(workspace)
  const cpuBefore = cpuTotals()
  await application.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    })
    const started = performance.now()
    const sample = { started, previous: started, maxDelay: 0, turns: 0 }
    globalThis.workspaceOpenProbe = sample
    globalThis.workspaceOpenTimer = setInterval(() => {
      const now = performance.now()
      sample.maxDelay = Math.max(sample.maxDelay, now - sample.previous - 20)
      sample.previous = now
      sample.turns++
    }, 20)
    globalThis.workspaceOpenTimer.unref()
  }, folder)
  await page.evaluate(async () => {
    await window.hibi.openWorkspace(false)
  })
  await page.getByRole('button', { name: 'Toggle workspace sidebar' }).click()
  await page.getByRole('treeitem').first().waitFor()
  const sample = await application.evaluate(async () => {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    clearInterval(globalThis.workspaceOpenTimer)
    const sample = globalThis.workspaceOpenProbe
    return {
      elapsedMs: performance.now() - sample.started,
      mainMaxDelayMs: sample.maxDelay,
      timerTurns: sample.turns,
    }
  })
  const cpuAfter = cpuTotals()
  const cpuTime = cpuAfter.total - cpuBefore.total
  const machineCpuPercent =
    cpuTime > 0 ? 100 * (1 - (cpuAfter.idle - cpuBefore.idle) / cpuTime) : null
  process.stdout.write(
    `${JSON.stringify(
      {
        appRoot: resolve(appRoot),
        workspace: folder,
        driverNode: process.version,
        profile: 'fresh',
        cacheCondition: 'filesystem caches uncontrolled',
        intervalMs: 20,
        machineCpuPercent,
        ...runtime,
        addons,
        ...sample,
      },
      null,
      2,
    )}\n`,
  )
} finally {
  if (application) {
    await application.evaluate(() =>
      clearInterval(globalThis.workspaceOpenTimer),
    )
    await application.close()
  }
  await rm(profileRoot, { recursive: true, force: true })
}
