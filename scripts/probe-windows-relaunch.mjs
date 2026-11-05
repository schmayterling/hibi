import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout } from 'node:timers/promises'
import electronPath from 'electron'
import { electron, waitForAsync, waitForFormattedEditor } from '../tests/electron.mjs'
import { pressShortcut, replaceRichText } from '../tests/keyboard.mjs'

const root = resolve('.')
const hook = resolve('scripts/probe-windows-relaunch-hook.cjs')
const known = new Map()
const roots = new Set()
const log = (event, values = {}) => console.log('relaunch-result', JSON.stringify({ event, ...values }))
const argsFor = (profile) => ['-r', hook, root, `--user-data-dir=${profile}`]
const powershell = (command) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 10000 }).trim()
function processes(label) {
  const json = powershell('Get-CimInstance Win32_Process -Filter "name=\'electron.exe\'" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress')
  const values = json ? JSON.parse(json) : []
  const rows = Array.isArray(values) ? values : [values]
  const ids = new Set(roots)
  for (let previous = -1; previous !== ids.size;) {
    previous = ids.size
    for (const row of rows) if (ids.has(row.ParentProcessId)) ids.add(row.ProcessId)
  }
  const own = rows.filter((row) => ids.has(row.ProcessId) || known.get(row.ProcessId) === row.CommandLine)
  for (const row of own) known.set(row.ProcessId, row.CommandLine)
  log('processes', { label, rows: own })
  return own
}
function cleanup(label) {
  const rows = processes(label)
  if (rows.length) powershell(`Stop-Process -Id ${rows.map((row) => row.ProcessId).join(',')} -Force -ErrorAction SilentlyContinue`)
}
async function launch(profile) {
  const app = await electron.launch({ args: argsFor(profile), timeout: 15000 })
  roots.add(app.process().pid)
  app.process().stderr.on('data', (data) => {
    for (const line of data.toString().split('\n')) if (line.includes('relaunch-probe')) console.log(line)
  })
  const identity = await app.evaluate(({ app }) => ({ pid: process.pid, profile: app.getPath('userData'), locked: app.hasSingleInstanceLock() }))
  roots.add(identity.pid)
  log('identity', { launcherPid: app.process().pid, ...identity })
  return app
}
async function prepared() {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-relaunch-probe-'))
  const file = join(profile, 'note.md')
  await writeFile(file, 'original')
  const app = await launch(profile)
  const page = await app.firstWindow()
  const editor = await waitForFormattedEditor(app, page)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, file)
  await pressShortcut(app, 'Control+o')
  await waitForAsync(page, async () => (await window.hibi.getDocument()).markdown === 'original')
  await replaceRichText(page, editor, 'unsaved crash copy')
  await waitForAsync(page, async () => (await window.hibi.getDocument()).markdown === 'unsaved crash copy')
  const directory = join(profile, 'recovery')
  const deadline = Date.now() + 8000
  let found = false
  while (!found && Date.now() < deadline) {
    const names = await readdir(directory).catch(() => [])
    for (const name of names) {
      const text = await readFile(join(directory, name), 'utf8').catch(() => '')
      if (text.includes('unsaved crash copy')) found = true
    }
    if (!found) await setTimeout(50)
  }
  if (!found) throw new Error('no recovery copy before kill')
  return { app, profile }
}
async function playwrightCase(mode) {
  const { app, profile } = await prepared()
  const child = app.process()
  processes(`${mode}:before-kill`)
  const exited = once(child, 'exit')
  if (mode === 'pid-only') child.kill('SIGKILL')
  else execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000 })
  await exited
  log('killed', { mode, launcherPid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })
  const started = performance.now()
  let second
  try {
    second = await launch(profile)
    const page = await second.firstWindow()
    await waitForFormattedEditor(second, page)
    await page.getByRole('button', { name: 'Restore note.md' }).waitFor({ timeout: 8000 })
    log('relaunch', { mode, ok: true, ms: performance.now() - started })
  } catch (error) {
    log('relaunch', { mode, ok: false, ms: performance.now() - started, error: String(error).slice(0, 18000) })
  }
  processes(`${mode}:after-relaunch`)
  if (second) {
    await second.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }) })
    await second.close()
  }
  cleanup(`${mode}:cleanup`)
  return profile
}
function nativeLaunch(profile) {
  const child = spawn(electronPath, [...argsFor(profile), '--hibi-test'], { stdio: ['ignore', 'pipe', 'pipe'] })
  roots.add(child.pid)
  let timer
  const loaded = new Promise((resolve, reject) => {
    timer = globalThis.setTimeout(() => reject(new Error('native launch did not load')), 15000)
    child.once('error', reject)
    child.once('exit', (code, signal) => reject(new Error(`native exit ${code}/${signal}`)))
    for (const stream of [child.stdout, child.stderr]) {
      const lines = createInterface({ input: stream })
      lines.on('line', (line) => {
        if (!line.includes('relaunch-probe')) return
        console.log(line)
        if (line.includes('"event":"loaded"')) resolve()
      })
    }
  }).finally(() => globalThis.clearTimeout(timer))
  return { child, loaded }
}
async function nativeCase(profile) {
  const first = nativeLaunch(profile)
  await first.loaded
  processes('native:before-kill')
  const exited = once(first.child, 'exit')
  first.child.kill('SIGKILL')
  await exited
  const second = nativeLaunch(profile)
  try {
    await second.loaded
    log('native-relaunch', { ok: true, firstPid: first.child.pid, secondPid: second.child.pid })
  } catch (error) {
    log('native-relaunch', { ok: false, firstPid: first.child.pid, secondPid: second.child.pid, error: String(error) })
  }
  cleanup('native:cleanup')
}
try {
  const profile = await playwrightCase('pid-only')
  await playwrightCase('tree')
  await nativeCase(profile)
  log('complete')
  process.exit(0)
} catch (error) {
  console.error(error)
  try { cleanup('fatal:cleanup') } catch {}
  process.exit(1)
}
