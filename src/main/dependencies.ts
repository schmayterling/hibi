import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { app, type BrowserWindow, dialog, shell } from 'electron'
import {
  type DependencyState,
  dependencyIdentity,
  dependencyInstallCommand,
  parseDependencies,
} from '../shared/dependencies'
import { getAddonManifests, getAddonStates } from './addons'
import { retryRename } from './atomic-rename'
import { executableFile, findTool, toolSearchPath } from './tool-paths'
import { workspaceRoot } from './workspace'

const execute = promisify(execFile)
const checked = new Map<
  string,
  Pick<DependencyState, 'path' | 'status' | 'version' | 'message'>
>()
const installing = new Map<string, Promise<DependencyState>>()
const processes = new Set<() => void>()
app.on('before-quit', () => {
  for (const stop of processes) stop()
})
let preferences: Promise<Record<string, string>> | undefined
let saving: Promise<void> = Promise.resolve()
function paths() {
  preferences ??= readFile(
    join(app.getPath('userData'), 'dependencies.json'),
    'utf8',
  )
    .then((text) => {
      const value = JSON.parse(text)
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid dependency paths.')
      return Object.fromEntries(
        Object.entries(value).filter(
          ([key, path]) =>
            /^[a-f0-9]{64}$/.test(key) &&
            typeof path === 'string' &&
            isAbsolute(path),
        ),
      ) as Record<string, string>
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT')
        console.error('could not load dependency paths:', error)
      return {}
    })
  return preferences
}

function groups() {
  const enabled = new Map(
    getAddonStates().map((state) => [state.id, state.enabled]),
  )
  const groups = new Map<
    string,
    {
      key: string
      definition: ReturnType<typeof parseDependencies>[number]
      addons: DependencyState['addons']
    }
  >()
  for (const manifest of getAddonManifests()) {
    for (const definition of parseDependencies(manifest.dependencies)) {
      const key = createHash('sha256')
        .update(dependencyIdentity(definition))
        .digest('hex')
      let group = groups.get(key)
      if (!group) {
        group = { key, definition, addons: [] }
        groups.set(key, group)
      }
      group.addons.push({
        id: manifest.id,
        name: manifest.name,
        enabled: enabled.get(manifest.id) ?? false,
        reason: definition.reason,
        optional: definition.optional ?? false,
      })
    }
  }
  return [...groups.values()]
}
function group(key: unknown) {
  if (typeof key !== 'string')
    throw new Error('Choose a declared addon dependency.')
  const found = groups().find((entry) => entry.key === key)
  if (!found)
    throw new Error(
      'This dependency is no longer declared by an installed addon.',
    )
  return found
}
function owned(owner: unknown, id: unknown) {
  if (typeof owner !== 'string' || typeof id !== 'string')
    throw new Error('Choose a declared addon dependency.')
  const found = groups().find(
    (entry) =>
      entry.definition.id === id &&
      entry.addons.some((addon) => addon.id === owner),
  )
  if (!found) throw new Error('This addon did not declare that dependency.')
  return found
}
async function location(entry: ReturnType<typeof group>) {
  const custom = (await paths())[entry.key]
  return custom
    ? executableFile(custom)
    : findTool(entry.definition.command, workspaceRoot())
}
async function installer(entry: ReturnType<typeof group>) {
  const plan = dependencyInstallCommand(entry.definition, process.platform)
  if (!plan) return null
  const path = await findTool(plan.command, workspaceRoot())
  return path ? { ...plan, path } : null
}
async function state(
  entry: ReturnType<typeof group>,
): Promise<DependencyState> {
  const [path, plan, configured] = await Promise.all([
    location(entry),
    installer(entry),
    paths(),
  ])
  const previous = checked.get(entry.key)
  return {
    key: entry.key,
    id: entry.definition.id,
    name: entry.definition.name,
    command: entry.definition.command,
    homepage: entry.definition.homepage,
    status: path ? 'available' : 'missing',
    customPath: !!configured[entry.key],
    ...(previous?.path === path ? previous : {}),
    path: path ?? configured[entry.key] ?? null,
    ...(installing.has(entry.key) ? { status: 'installing' as const } : {}),
    installer: plan
      ? {
          manager: plan.manager,
          command: [plan.command, ...plan.args].join(' '),
        }
      : null,
    addons: entry.addons,
  }
}

export async function listDependencies(owner?: unknown) {
  if (
    owner !== undefined &&
    (typeof owner !== 'string' ||
      !getAddonManifests().some((manifest) => manifest.id === owner))
  )
    throw new Error('This addon is unavailable.')
  const declared = groups().filter(
    (entry) =>
      owner === undefined || entry.addons.some((addon) => addon.id === owner),
  )
  return Promise.all(declared.map(state))
}
export async function resolveDependency(owner: string, id: string) {
  const entry = owned(owner, id)
  return location(entry)
}
export function dependencyKey(owner: unknown, id: unknown) {
  return owned(owner, id).key
}
export function dependencyTarget(value: unknown) {
  if (typeof value === 'string') return group(value).key
  if (value && typeof value === 'object') {
    const target = value as { addon?: unknown; id?: unknown }
    return dependencyKey(target.addon, target.id)
  }
  throw new Error('Choose a declared addon dependency.')
}

export async function checkDependency(key: unknown) {
  const entry = group(key)
  if (installing.has(entry.key)) return state(entry)
  const path = await location(entry)
  checked.delete(entry.key)
  if (path && !path.toLowerCase().endsWith('.cmd')) {
    try {
      const result = await execute(path, ['--version'], {
        cwd: app.getPath('userData'),
        timeout: 5000,
        maxBuffer: 128 * 1024,
        windowsHide: true,
        env: { ...process.env, PATH: toolSearchPath().join(delimiter) },
      })
      checked.set(entry.key, {
        path,
        status: 'available',
        version:
          (result.stdout || result.stderr)
            .trim()
            .split(/\r?\n/)[0]
            ?.slice(0, 300) ?? '',
      })
    } catch (error) {
      checked.set(entry.key, {
        path,
        status: 'error',
        message: `Could not run ${entry.definition.name}: ${(error as Error).message.slice(0, 500)}`,
      })
    }
  }
  return state(entry)
}

export async function configureDependency(
  window: BrowserWindow,
  key: unknown,
  action: unknown,
) {
  const entry = group(key)
  if (installing.has(entry.key))
    throw new Error(
      'Wait for installation to finish before changing this path.',
    )
  const typed =
    action && typeof action === 'object' && 'path' in action
      ? action.path
      : undefined
  if (action !== 'choose' && action !== 'reset' && typeof typed !== 'string')
    throw new Error('Choose, enter, or reset the executable path.')
  let selected: string | undefined
  if (action === 'choose') {
    const result = await dialog.showOpenDialog(window, {
      title: `Choose ${entry.definition.name} executable`,
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return state(entry)
    selected = result.filePaths[0]
  } else if (typeof typed === 'string') selected = typed
  if (selected !== undefined) {
    if (
      selected.length > 32768 ||
      /[\0\r\n]/.test(selected) ||
      !isAbsolute(selected) ||
      !(await executableFile(selected)) ||
      (process.platform === 'win32' &&
        !/\.exe$/i.test(selected) &&
        !(
          entry.definition.command === 'quarto' &&
          /quarto\.cmd$/i.test(selected)
        ))
    )
      throw new Error('Enter an absolute path to an executable file.')
  }
  const save = saving.then(async () => {
    const next = { ...(await paths()) }
    if (selected) next[entry.key] = selected
    else delete next[entry.key]
    const file = join(app.getPath('userData'), 'dependencies.json')
    await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 })
    await retryRename(() => rename(`${file}.tmp`, file))
    preferences = Promise.resolve(next)
    checked.delete(entry.key)
  })
  saving = save.catch(() => {})
  await save
  return checkDependency(entry.key)
}

function runInstall(path: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(path, args, {
      cwd: app.getPath('userData'),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: toolSearchPath().join(delimiter),
        NONINTERACTIVE: '1',
        HOMEBREW_NO_AUTO_UPDATE: '1',
      },
    })
    let output = '',
      settled = false
    const stop = () => {
      if (!child.pid) return
      try {
        if (process.platform === 'win32')
          spawn(
            join(
              process.env.SystemRoot ?? 'C:\\Windows',
              'System32',
              'taskkill.exe',
            ),
            ['/pid', String(child.pid), '/t', '/f'],
            { windowsHide: true, stdio: 'ignore' },
          ).on('error', () => child.kill())
        else process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* The package manager already exited. */
      }
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      processes.delete(stop)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      stop()
      finish(
        new Error(
          'Installation took too long. Check the package manager, then try again.',
        ),
      )
    }, 15 * 60_000)
    processes.add(stop)
    const collect = (data: Buffer) => {
      output = (output + data.toString()).slice(-8000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', finish)
    child.on('close', (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(
              output.trim() ||
                'The package manager could not install this dependency.',
            ),
      ),
    )
  })
}

export function installDependency(
  window: BrowserWindow,
  key: unknown,
): Promise<DependencyState> {
  const entry = group(key)
  const pending = installing.get(entry.key)
  if (pending) return pending
  if (installing.size)
    return Promise.reject(
      new Error('Another dependency is installing. Wait for it to finish.'),
    )
  const task = (async () => {
    const plan = await installer(entry)
    if (!plan)
      throw new Error(
        'No supported package manager was found. Open the installation guide or choose an installed executable.',
      )
    const answer = await dialog.showMessageBox(window, {
      type: 'question',
      message: `Install ${entry.definition.name}?`,
      detail: `Requested by ${entry.addons.map((addon) => addon.name).join(', ')}.\n\n${plan.manager} will download and install this tool on your computer:\n${plan.path} ${plan.args.join(' ')}\n\nThis installation may also be used by other applications.`,
      buttons: ['Cancel', 'Install'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (answer.response !== 1) return false
    group(entry.key)
    await runInstall(plan.path, plan.args)
    checked.delete(entry.key)
    return true
  })()
    .then(async (installed) => {
      installing.delete(entry.key)
      if (!installed) return state(entry)
      const result = await checkDependency(entry.key)
      if (result.status !== 'missing') return result
      checked.set(entry.key, {
        path: null,
        status: 'missing',
        message:
          'Installation completed, but the executable was not found. Choose its location or restart Hibi to refresh PATH.',
      })
      return state(entry)
    })
    .finally(() => installing.delete(entry.key))
  installing.set(entry.key, task)
  return task
}

export async function openDependencyGuide(key: unknown) {
  const entry = group(key)
  await shell.openExternal(entry.definition.homepage)
}
