import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { extname, join } from 'node:path'
import { app, type BrowserWindow, dialog, shell } from 'electron'
import type { AddonManifest } from '../addons/api'
import {
  requiredAddonDependencies,
  validateAddonRequirements,
} from '../shared/addon-dependencies'
import {
  admitInstalledAddon,
  parseAddonManifest,
  validId,
} from '../shared/addon-manifest'
import {
  MAX_ADDON_BYTES,
  MAX_ADDON_ENTRIES,
  MAX_ADDON_FILE_BYTES,
  MAX_ADDON_MANIFEST_BYTES,
  validAddonPath as validPath,
} from '../shared/addon-package'
import type { InstalledAddon } from '../shared/sideload'
import { downloadRepository, repositoryUrl } from './addon-repository'

type Package = InstalledAddon & { entry: string; hash: string; files: string[] }
let installed: Package[] = []
const root = () => join(app.getPath('userData'), 'installed-addons')
/** `files` is the recorded inventory; declared resources must appear in it. */
async function readManifest(
  folder: string,
  compiledIds: readonly string[],
  phase: 'install' | 'load' = 'install',
  files?: readonly string[],
) {
  const path = join(folder, 'hibi-addon.json')
  const stat = await lstat(path)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > MAX_ADDON_MANIFEST_BYTES
  )
    throw new Error(
      'hibi-addon.json must be a JSON file no larger than 64 KiB.',
    )
  const value = JSON.parse(await readFile(path, 'utf8'))
  const themeFiles = new Map<string, unknown>()
  if (phase === 'install')
    for (const theme of parseAddonManifest(value).themes) {
      if (typeof theme !== 'string') continue
      const file = await packageFile(folder, theme, files)
      if (!file || file.size > MAX_ADDON_MANIFEST_BYTES)
        throw new Error(
          `The theme file ${theme} must be a JSON file in the addon no larger than 64 KiB.`,
        )
      try {
        themeFiles.set(theme, JSON.parse(await readFile(file.path, 'utf8')))
      } catch {
        throw new Error(`The theme file ${theme} is not valid JSON.`)
      }
    }
  const data = admitInstalledAddon(value, compiledIds, phase, themeFiles)
  for (const style of data.styles ?? [])
    if (!(await packageFile(folder, style, files)))
      throw new Error(`The stylesheet ${style} is missing from the addon.`)
  return data
}
/** A regular file reached without symbolic links, listed in `files` when given. */
async function packageFile(
  folder: string,
  relative: string,
  files?: readonly string[],
) {
  if (files && !files.includes(relative)) return null
  let path = folder
  try {
    for (const part of relative.split('/')) {
      path = join(path, part)
      if ((await lstat(path)).isSymbolicLink()) return null
    }
    const stat = await lstat(path)
    return stat.isFile() ? { path, size: stat.size } : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
function descriptor(data: Omit<Package, 'url'>): Package {
  const base = `app://hibi/installed-addons/${data.manifest.id}/${data.hash}/`
  return {
    ...data,
    url: data.entry ? base + data.entry : null,
    ...(data.styles ? { styles: data.styles.map((path) => base + path) } : {}),
  }
}
export function installedAddons(): InstalledAddon[] {
  return installed.map(({ manifest, url, themes, styles, source }) => ({
    manifest,
    url,
    themes,
    ...(styles ? { styles } : {}),
    source: source ?? 'local',
  }))
}
export function installedDocumentationPath(id: string, path: string) {
  const entry = installed.find((item) => item.manifest.id === id)
  if (!entry || !validPath(path)) return Promise.resolve(null)
  return installedAsset(
    `app://hibi/installed-addons/${id}/${entry.hash}/${path}`,
  )
}
export async function loadInstalledAddons(
  builtins: readonly AddonManifest[],
): Promise<string[]> {
  const builtinIds = builtins.map((manifest) => manifest.id)
  const notices: string[] = []
  const entries = await readdir(root(), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return []
    },
  )
  const next: Package[] = []
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !validId(entry.name) ||
      builtinIds.includes(entry.name)
    )
      continue
    try {
      const folder = join(root(), entry.name)
      const record = JSON.parse(
        await readFile(join(folder, '.hibi-install.json'), 'utf8'),
      )
      if (
        !/^[a-f\d]{64}$/.test(record.hash) ||
        !Array.isArray(record.files) ||
        record.files.length > MAX_ADDON_ENTRIES ||
        !record.files.every(validPath)
      )
        throw new Error(
          'The addon installation record is invalid. Reinstall the addon.',
        )
      // Older installs never validated styles or theme files, so they keep ignoring them.
      const data = await readManifest(
        folder,
        builtinIds,
        record.resources === true ? 'install' : 'load',
        record.files,
      )
      if (data.manifest.id !== entry.name)
        throw new Error(
          'The addon installation record is invalid. Reinstall the addon.',
        )
      next.push(
        descriptor({
          ...data,
          hash: record.hash,
          files: record.files,
          source: record.source === 'third-party' ? 'third-party' : 'local',
        }),
      )
    } catch (error) {
      console.error(`could not load installed addon ${entry.name}:`, error)
      notices.push(
        `Could not load addon "${entry.name}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const all = [...builtins, ...next.map((addon) => addon.manifest)]
  try {
    validateAddonRequirements(all, { allowMissing: true })
  } catch (error) {
    const graph = new Map(
      all.map((manifest) => [
        manifest.id,
        manifest.requires?.addons.map((dependency) => dependency.id) ?? [],
      ]),
    )
    const cyclic = (id: string) => {
      const visited = new Set<string>()
      const reachesOwner = (owner: string): boolean => {
        for (const dependency of graph.get(owner) ?? []) {
          if (dependency === id) return true
          if (visited.has(dependency)) continue
          visited.add(dependency)
          if (reachesOwner(dependency)) return true
        }
        return false
      }
      return reachesOwner(id)
    }
    const rejected = next.filter((addon) => cyclic(addon.manifest.id))
    if (!rejected.length) throw error
    const reason = `Addons with dependency cycles were not loaded: ${rejected.map((addon) => addon.manifest.id).join(', ')}. ${error instanceof Error ? error.message : String(error)}`
    console.error(reason)
    notices.push(reason)
    const rejectedIds = new Set(rejected.map((addon) => addon.manifest.id))
    installed = next.filter((addon) => !rejectedIds.has(addon.manifest.id))
    validateAddonRequirements(
      [...builtins, ...installed.map((addon) => addon.manifest)],
      { allowMissing: true },
    )
    return notices
  }
  installed = next
  return notices
}
export async function installPackage(
  window: BrowserWindow,
  builtins: readonly AddonManifest[],
  disable: (id: string) => Promise<() => Promise<void>>,
  url?: unknown,
): Promise<boolean> {
  if (url !== undefined) {
    const { downloadAddon, unpackAddon } = await import('./addon-download')
    const temporary = await mkdtemp(join(app.getPath('temp'), 'hibi-addon-'))
    try {
      let download = repositoryUrl(url)
        ? await downloadRepository(url, temporary)
        : await downloadAddon(url)
      if (
        download.zip.length < 4 ||
        download.zip.readUInt32LE(0) !== 0x04034b50
      )
        download = await downloadRepository(url, temporary)
      const packageDirectory = join(temporary, 'package')
      await mkdir(packageDirectory, { mode: 0o700 })
      await unpackAddon(download.zip, packageDirectory)
      return await installDirectory(
        window,
        packageDirectory,
        builtins,
        disable,
        'third-party',
        download.host,
      )
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
  const selection = await dialog.showOpenDialog(window, {
    title: 'Choose an addon folder',
    properties: ['openDirectory'],
  })
  if (selection.canceled || !selection.filePaths[0]) return false
  const source = await realpath(selection.filePaths[0])
  return installDirectory(window, source, builtins, disable, 'local')
}

async function installDirectory(
  window: BrowserWindow,
  source: string,
  builtins: readonly AddonManifest[],
  disable: (id: string) => Promise<() => Promise<void>>,
  origin: 'local' | 'third-party',
  host?: string,
): Promise<boolean> {
  const compiledIds = builtins.map((manifest) => manifest.id)
  const data = await readManifest(source, compiledIds)
  const validateGraph = () => {
    const graph = [
      ...builtins,
      ...installed
        .filter((addon) => addon.manifest.id !== data.manifest.id)
        .map((addon) => addon.manifest),
      data.manifest,
    ]
    validateAddonRequirements(graph, { allowMissing: true })
    const ids = new Set(graph.map((manifest) => manifest.id))
    for (const id of requiredAddonDependencies(graph, data.manifest.id))
      if (!ids.has(id))
        throw new Error(
          `Addon "${data.manifest.id}" requires unknown addon "${id}".`,
        )
  }
  validateGraph()
  const verdict = await dialog.showMessageBox(window, {
    type: data.manifest.kind === 'extension' ? 'warning' : 'question',
    message: `Install ${data.manifest.name} ${data.manifest.version}?`,
    detail: `${data.manifest.description}\n\nBy ${data.manifest.authors?.map((author) => author.displayName).join(', ')}${host ? `\n\nDownloaded from ${host}` : ''}${data.manifest.network ? `\n\nConnects to: ${data.manifest.network.origins.join(', ')}` : ''}\n\n${data.manifest.kind === 'extension' ? 'Extensions can run code and read or edit documents in Hibi. Only install addons you trust. ' : ''}This addon will stay disabled until you enable it.`,
    buttons: [
      'Cancel',
      installed.some((item) => item.manifest.id === data.manifest.id)
        ? 'Replace addon'
        : 'Install',
    ],
    defaultId: 0,
    cancelId: 0,
  })
  if (verdict.response !== 1) return false
  await mkdir(root(), { recursive: true, mode: 0o700 })
  const staging = join(root(), `.staging-${randomUUID()}`)
  await mkdir(staging, { mode: 0o700 })
  const files: string[] = []
  let bytes = 0
  let count = 0
  const hash = createHash('sha256')
  let restore: (() => Promise<void>) | undefined
  const destination = join(root(), data.manifest.id),
    backup = join(root(), `.backup-${randomUUID()}`)
  let backedUp = false,
    replaced = false
  try {
    async function copy(directory: string, parent = '') {
      const entries = (await readdir(directory, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (++count > MAX_ADDON_ENTRIES)
          throw new Error('An addon can contain up to 1,000 entries.')
        const relative = parent ? `${parent}/${entry.name}` : entry.name
        if (!validPath(relative) || entry.isSymbolicLink())
          throw new Error(
            'Addon folders cannot contain symbolic links or invalid paths.',
          )
        const path = join(directory, entry.name),
          target = join(staging, relative)
        if (entry.isDirectory()) {
          await mkdir(target)
          await copy(path, relative)
          continue
        }
        if (
          !entry.isFile() ||
          ![
            '.js',
            '.mjs',
            '.json',
            '.css',
            '.woff',
            '.woff2',
            '.ttf',
            '.svg',
            '.png',
            '.jpg',
            '.jpeg',
            '.webp',
            '.gif',
            '.mp3',
            '.ogg',
            '.wav',
            '.md',
            '.txt',
          ].includes(extname(entry.name).toLowerCase())
        )
          throw new Error(
            `This file type is not allowed in addons: ${relative}`,
          )
        const stat = await lstat(path)
        if (
          stat.isSymbolicLink() ||
          stat.size > MAX_ADDON_FILE_BYTES ||
          files.length >= MAX_ADDON_ENTRIES
        )
          throw new Error(
            'Addon files must be regular files no larger than 5 MiB, with at most 1,000 entries in total.',
          )
        const content = await readFile(path)
        bytes += content.length
        if (bytes > MAX_ADDON_BYTES)
          throw new Error('The addon exceeds the 25 MiB limit.')
        await writeFile(target, content, { mode: 0o600, flag: 'wx' })
        files.push(relative)
        hash.update(relative).update('\0').update(content)
      }
    }
    await copy(source)
    if (
      !files.includes('README.md') ||
      (data.entry && !files.includes(data.entry)) ||
      (data.manifest.analysis && !files.includes(data.manifest.analysis.entry))
    )
      throw new Error(
        'The addon needs README.md and the entry file listed in hibi-addon.json.',
      )
    const copied = await readManifest(staging, compiledIds, 'install', files)
    if (JSON.stringify(copied) !== JSON.stringify(data))
      throw new Error('The addon files changed during installation. Try again.')
    const fingerprint = hash.digest('hex')
    await writeFile(
      join(staging, '.hibi-install.json'),
      JSON.stringify({
        hash: fingerprint,
        files,
        source: origin,
        resources: true,
      }),
      { mode: 0o600 },
    )
    const exists = await lstat(destination).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      },
    )
    if (
      exists &&
      !installed.some((item) => item.manifest.id === data.manifest.id)
    )
      throw new Error(
        'An unrecognized addon already uses this ID. Check the addons folder before installing.',
      )
    validateGraph()
    restore = await disable(data.manifest.id)
    if (exists) {
      await rename(destination, backup)
      backedUp = true
    }
    await rename(staging, destination)
    replaced = true
    installed = [
      ...installed.filter((item) => item.manifest.id !== data.manifest.id),
      descriptor({ ...copied, hash: fingerprint, files, source: origin }),
    ]
    if (backedUp)
      await shell
        .trashItem(backup)
        .catch((error) => console.error('old addon package retained:', error))
    return true
  } catch (error) {
    if (!replaced && backedUp) await rename(backup, destination)
    if (!replaced) await restore?.()
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
export async function removePackage(id: unknown): Promise<void> {
  const packageInfo = installed.find((item) => item.manifest.id === id)
  if (!packageInfo)
    throw new Error(
      'Only addons you installed can be removed. Disable built-in addons instead.',
    )
  await shell.trashItem(join(root(), packageInfo.manifest.id))
  installed = installed.filter((item) => item !== packageInfo)
}
export async function openAddonsFolder(): Promise<void> {
  await mkdir(root(), { recursive: true, mode: 0o700 })
  const error = await shell.openPath(root())
  if (error) throw new Error(error)
}
export async function installedAsset(url: string): Promise<string | null> {
  const parsed = new URL(url)
  if (
    parsed.protocol !== 'app:' ||
    parsed.host !== 'hibi' ||
    parsed.username ||
    parsed.password
  )
    return null
  const [, prefix, id, hash, ...parts] = decodeURIComponent(
    parsed.pathname,
  ).split('/')
  if (prefix !== 'installed-addons') return null
  const entry = installed.find(
    (item) => item.manifest.id === id && item.hash === hash,
  )
  const relative = parts.join('/')
  if (!entry || !validPath(relative) || !entry.files.includes(relative))
    return null
  let path = join(root(), entry.manifest.id)
  if ((await lstat(path)).isSymbolicLink()) return null
  for (const part of parts) {
    path = join(path, part)
    if ((await lstat(path)).isSymbolicLink()) return null
  }
  const stat = await lstat(path)
  return stat.isFile() && stat.size <= MAX_ADDON_FILE_BYTES ? path : null
}
