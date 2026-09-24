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
import {
  ADDON_API_VERSION,
  type AddonManifest,
  compatibleAddonManifest,
} from '../addons/api'
import {
  MAX_ADDON_BYTES,
  MAX_ADDON_ENTRIES,
  MAX_ADDON_FILE_BYTES,
  validAddonPath as validPath,
} from '../shared/addon-package'
import {
  type ColorschemeInput,
  defineColorscheme,
} from '../shared/colorschemes'
import { parseDependencies } from '../shared/dependencies'
import { parseSyntaxDescriptors } from '../shared/preservation'
import type { InstalledAddon } from '../shared/sideload'
import { downloadRepository, repositoryUrl } from './addon-repository'

type Package = InstalledAddon & { entry: string; hash: string; files: string[] }
let installed: Package[] = []
const root = () => join(app.getPath('userData'), 'installed-addons')
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value)

import { validDocumentExtensions } from '../shared/document-types'

function settingsMetadata(
  value: unknown,
): NonNullable<AddonManifest['settings']> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The addon settings metadata is invalid.')
  const { category, icon } = value as Record<string, unknown>
  if (
    [category, icon].some(
      (field) =>
        field !== undefined &&
        (typeof field !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(field)),
    )
  )
    throw new Error('The addon settings category or icon is invalid.')
  return {
    ...(typeof category === 'string' ? { category } : {}),
    ...(typeof icon === 'string' ? { icon } : {}),
  }
}

function manifest(value: unknown): {
  manifest: AddonManifest
  entry: string
  themes: ColorschemeInput[]
} {
  if (!value || typeof value !== 'object')
    throw new Error('The addon details in hibi-addon.json are invalid.')
  const data = value as Record<string, unknown>
  const string = (value: unknown, max: number): value is string =>
    typeof value === 'string' && !!value.trim() && value.length <= max
  if (
    !validId(data.id) ||
    !string(data.name, 100) ||
    !string(data.description, 500) ||
    !compatibleAddonManifest(data) ||
    !['theme', 'extension'].includes(String(data.kind)) ||
    !string(data.version, 40) ||
    !Array.isArray(data.authors) ||
    !data.authors.length ||
    data.authors.length > 20 ||
    data.authors.some(
      (author) =>
        !author ||
        !string(author.displayName, 100) ||
        (author.discordId !== undefined &&
          (typeof author.discordId !== 'string' ||
            !/^\d{5,24}$/.test(author.discordId))) ||
        (author.github !== undefined &&
          (typeof author.github !== 'string' ||
            !/^[a-z\d-]{1,39}$/i.test(author.github))) ||
        (author.role !== undefined && !string(author.role, 100)),
    )
  )
    throw new Error(
      'The addon needs an ID, kind, API version, version, description, and authors in hibi-addon.json.',
    )
  if (
    data.licenses !== undefined &&
    (!Array.isArray(data.licenses) ||
      data.licenses.length > 50 ||
      data.licenses.some(
        (license) =>
          !license ||
          !validId(license.id) ||
          !string(license.name, 100) ||
          !string(license.license, 100) ||
          !string(license.text, 32000),
      ))
  )
    throw new Error('The addon license details are invalid.')
  if (
    data.fileExtensions !== undefined &&
    (data.kind === 'theme' || !validDocumentExtensions(data.fileExtensions))
  )
    throw new Error('The addon lists invalid file extensions.')
  if (
    data.capabilities !== undefined &&
    (!Array.isArray(data.capabilities) ||
      data.capabilities.length > 4 ||
      new Set(data.capabilities).size !== data.capabilities.length ||
      data.capabilities.some(
        (value) => !['ui', 'rich', 'source', 'markdown'].includes(value),
      ))
  )
    throw new Error('The addon lists invalid SDK capabilities.')
  if (
    data.activation !== undefined &&
    !['command', 'source', 'rich'].includes(String(data.activation))
  )
    throw new Error('The addon activation mode is invalid.')
  if (
    data.commands !== undefined &&
    (!Array.isArray(data.commands) ||
      data.commands.length > 64 ||
      new Set(data.commands.map((command) => command?.id)).size !==
        data.commands.length ||
      data.commands.some(
        (command) =>
          !command ||
          !validId(command.id) ||
          !string(command.label, 100) ||
          (command.keywords !== undefined && !string(command.keywords, 300)),
      ))
  )
    throw new Error('The addon command descriptors are invalid.')
  if (
    data.activation === 'command' &&
    (!Array.isArray(data.commands) || !data.commands.length)
  )
    throw new Error('Command-activated addons must declare their commands.')
  if (data.activation !== undefined && data.capabilities === undefined)
    throw new Error(
      'Declare SDK capabilities before choosing an activation mode.',
    )
  const base: AddonManifest = {
    id: data.id,
    name: data.name,
    description: data.description,
    apiVersion: ADDON_API_VERSION,
    kind: data.kind as 'theme' | 'extension',
    version: data.version,
    authors: data.authors,
    defaultEnabled: false,
    ...(data.dependencies === undefined
      ? {}
      : { dependencies: parseDependencies(data.dependencies) }),
    ...(data.settings === undefined
      ? {}
      : { settings: settingsMetadata(data.settings) }),
    ...(data.analysis === undefined
      ? {}
      : { analysis: parseAnalysis(data.analysis) }),
    ...(data.syntax === undefined
      ? {}
      : { syntax: parseSyntaxDescriptors(data.syntax)! }),
    ...(data.capabilities === undefined
      ? {}
      : {
          capabilities: data.capabilities as NonNullable<
            AddonManifest['capabilities']
          >,
        }),
    ...(data.activation === undefined
      ? {}
      : {
          activation: data.activation as NonNullable<
            AddonManifest['activation']
          >,
        }),
    ...(data.commands === undefined
      ? {}
      : { commands: data.commands as NonNullable<AddonManifest['commands']> }),
    ...(data.startup === 'background'
      ? { startup: 'background' as const }
      : {}),
    ...(data.fileExtensions !== undefined
      ? {
          fileExtensions: data.fileExtensions,
        }
      : {}),
    ...(data.licenses
      ? { licenses: data.licenses as NonNullable<AddonManifest['licenses']> }
      : {}),
  }
  if (base.kind === 'theme') {
    if (
      data.analysis !== undefined ||
      data.syntax !== undefined ||
      data.capabilities !== undefined ||
      data.activation !== undefined ||
      data.commands !== undefined ||
      data.dependencies !== undefined ||
      data.entry !== undefined ||
      !Array.isArray(data.themes) ||
      !data.themes.length ||
      data.themes.length > 20
    )
      throw new Error(
        'Themes must contain color schemes without executable code.',
      )
    const themes = data.themes.map((value) => {
      if (
        !value ||
        typeof value !== 'object' ||
        !value.colors ||
        typeof value.colors !== 'object'
      )
        throw new Error('This theme has an invalid color scheme.')
      return defineColorscheme(value as ColorschemeInput)
    })
    if (
      themes.some((theme) => !validId(theme.id)) ||
      new Set(themes.map((theme) => theme.id)).size !== themes.length
    )
      throw new Error('Each theme needs a valid, unique ID.')
    base.licenses = [
      ...(base.licenses ?? []),
      ...themes.map((theme) => ({
        id: `theme-${theme.id}`,
        name: theme.name,
        license: theme.license.name,
        text: theme.license.text,
      })),
    ]
    return { manifest: base, entry: '', themes }
  }
  if (!validPath(data.entry) || !/\.(m?js)$/.test(data.entry))
    throw new Error(
      'The extension entry must point to a .js or .mjs file inside the addon folder.',
    )
  return { manifest: base, entry: data.entry, themes: [] }
}
function parseAnalysis(value: unknown): { entry: string } {
  const entry =
    value && typeof value === 'object'
      ? (value as { entry?: unknown }).entry
      : undefined
  if (!validPath(entry) || !/\.m?js$/.test(entry))
    throw new Error(
      'The analysis entry must be a JavaScript module inside the addon folder.',
    )
  return { entry }
}
async function readManifest(folder: string) {
  const path = join(folder, 'hibi-addon.json')
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
    throw new Error(
      'hibi-addon.json must be a JSON file no larger than 64 KiB.',
    )
  return manifest(JSON.parse(await readFile(path, 'utf8')))
}
function descriptor(data: Omit<Package, 'url'>): Package {
  return {
    ...data,
    url: data.entry
      ? `app://hibi/installed-addons/${data.manifest.id}/${data.hash}/${data.entry}`
      : null,
  }
}
export function installedAddons(): InstalledAddon[] {
  return installed.map(({ manifest, url, themes, source }) => ({
    manifest,
    url,
    themes,
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
export async function loadInstalledAddons(builtinIds: readonly string[]) {
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
      const [data, record] = await Promise.all([
        readManifest(folder),
        readFile(join(folder, '.hibi-install.json'), 'utf8').then((text) =>
          JSON.parse(text),
        ),
      ])
      if (
        data.manifest.id !== entry.name ||
        !/^[a-f\d]{64}$/.test(record.hash) ||
        !Array.isArray(record.files) ||
        record.files.length > MAX_ADDON_ENTRIES ||
        !record.files.every(validPath)
      )
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
    }
  }
  installed = next
}
export async function installPackage(
  window: BrowserWindow,
  builtinIds: readonly string[],
  disable: (id: string) => Promise<() => Promise<void>>,
  url?: unknown,
  garden?: { id: string; path: string },
): Promise<boolean> {
  if (url !== undefined) {
    if (garden && !repositoryUrl(url))
      throw new Error('The garden addon repository is invalid.')
    const { downloadAddon, unpackAddon } = await import('./addon-download')
    const temporary = await mkdtemp(join(app.getPath('temp'), 'hibi-addon-'))
    try {
      let download = repositoryUrl(url)
        ? await downloadRepository(url, temporary, undefined, garden?.path)
        : await downloadAddon(url)
      if (
        download.zip.length < 4 ||
        download.zip.readUInt32LE(0) !== 0x04034b50
      )
        download = await downloadRepository(
          url,
          temporary,
          undefined,
          garden?.path,
        )
      const packageDirectory = join(temporary, 'package')
      await mkdir(packageDirectory, { mode: 0o700 })
      await unpackAddon(download.zip, packageDirectory)
      return await installDirectory(
        window,
        packageDirectory,
        builtinIds,
        disable,
        'third-party',
        download.host,
        garden?.id,
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
  return installDirectory(window, source, builtinIds, disable, 'local')
}

async function installDirectory(
  window: BrowserWindow,
  source: string,
  builtinIds: readonly string[],
  disable: (id: string) => Promise<() => Promise<void>>,
  origin: 'local' | 'third-party',
  host?: string,
  expectedId?: string,
): Promise<boolean> {
  const data = await readManifest(source)
  if (expectedId && data.manifest.id !== expectedId)
    throw new Error('The garden addon does not match its catalog entry.')
  if (builtinIds.includes(data.manifest.id))
    throw new Error(
      'This addon uses the ID of a built-in addon and cannot replace it.',
    )
  const verdict = await dialog.showMessageBox(window, {
    type: data.manifest.kind === 'extension' ? 'warning' : 'question',
    message: `Install ${data.manifest.name} ${data.manifest.version}?`,
    detail: `${data.manifest.description}\n\nBy ${data.manifest.authors?.map((author) => author.displayName).join(', ')}${host ? `\n\nDownloaded from ${host}` : ''}\n\n${data.manifest.kind === 'extension' ? 'Extensions can run code and read or edit documents in Hibi. Only install addons you trust. ' : ''}This addon will stay disabled until you enable it.`,
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
    const copied = await readManifest(staging)
    if (JSON.stringify(copied) !== JSON.stringify(data))
      throw new Error('The addon files changed during installation. Try again.')
    const fingerprint = hash.digest('hex')
    await writeFile(
      join(staging, '.hibi-install.json'),
      JSON.stringify({ hash: fingerprint, files, source: origin }),
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
