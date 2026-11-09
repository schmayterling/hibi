// Reads a vault's themes and snippets without writing to the vault, and keeps
// Hibi's copies and choices in Hibi's own data folder.
import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import {
  obsidianConfiguration,
  obsidianDataPath,
} from '../../main/workspace-obsidian.ts'
import {
  type DroppedRule,
  MAX_ASSET_BYTES,
  MAX_SNIPPET_BYTES,
  MAX_THEME_BYTES,
  SANITIZER_VERSION,
  sanitizeCss,
} from './sanitize.ts'
import {
  readStyleSettings,
  type StyleSection,
  type StyleValues,
} from './style-settings.ts'

export type VaultAppearance = {
  cssTheme: string | null
  enabledCssSnippets: string[]
  /** Obsidian's own mode setting, reported only: Hibi's appearance decides light or dark. */
  theme: 'light' | 'dark' | 'system' | null
  accentColor?: string
  baseFontSize?: number
}
export type ThemeManifest = {
  name: string
  version?: string | undefined
  author?: string | undefined
  authorUrl?: string | undefined
  license?: string | undefined
}
export type VaultTheme = {
  name: string
  manifest: ThemeManifest
  hash: string
  bytes: number
}
export type VaultSnippet = { name: string; hash: string; bytes: number }
export type Vault = {
  themes: VaultTheme[]
  snippets: VaultSnippet[]
  appearance: VaultAppearance
  skipped: string[]
}
export type InstalledTheme = {
  id: string
  manifest: ThemeManifest
  source: 'vault' | 'folder' | 'community'
  /** For community themes: the GitHub repository, the release tag or branch, and the commit when known. */
  repository?: string
  ref?: string
  commit?: string
  /** The theme's name in the vault's themes folder, for vault themes. */
  folder?: string
  hash: string
  assets: Record<string, string>
  sanitizerVersion: number
  dropped: DroppedRule[]
  /** Options the theme describes for the Style Settings plugin. */
  settings?: StyleSection[]
}
export type Selection = {
  theme: string | null
  snippets: string[]
}

const sha256 = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex')
const text = (value: unknown, max = 200) =>
  typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : undefined
const assetTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

// Regular files only: a symlink could point anywhere outside the vault.
async function readRegular(path: string, max: number) {
  const info = await lstat(path)
  if (!info.isFile()) throw new Error('not a regular file')
  if (info.size > max) throw new Error('too large')
  return readFile(path)
}
/** Path inside the vault's Obsidian configuration folder, or null when it has none. */
export async function configPath(vault: string, ...parts: string[]) {
  const directory = (await obsidianConfiguration(vault))?.directory
  return directory ? join(vault, directory, ...parts) : null
}
async function entries(path: string | null) {
  if (!path) return []
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function readAppearance(vault: string): Promise<VaultAppearance> {
  let data: Record<string, unknown> = {}
  try {
    const path = await configPath(vault, 'appearance.json')
    if (!path) throw new Error('no configuration folder')
    const parsed: unknown = JSON.parse(
      (await readRegular(path, 256_000))
        .toString('utf8')
        .replace(/^\uFEFF/, ''),
    )
    if (parsed && typeof parsed === 'object') data = parsed as typeof data
  } catch {
    /* No appearance settings, or unreadable ones: Obsidian's defaults. */
  }
  const theme =
    data.theme === 'moonstone'
      ? 'light'
      : data.theme === 'obsidian'
        ? 'dark'
        : data.theme === 'system'
          ? 'system'
          : null
  return {
    cssTheme: text(data.cssTheme) ?? null,
    enabledCssSnippets: Array.isArray(data.enabledCssSnippets)
      ? data.enabledCssSnippets
          .filter((name): name is string => typeof name === 'string')
          .slice(0, 200)
      : [],
    theme,
    ...(typeof data.accentColor === 'string' &&
    /^#[\da-f]{6}$/i.test(data.accentColor)
      ? { accentColor: data.accentColor }
      : {}),
    ...(typeof data.baseFontSize === 'number'
      ? { baseFontSize: data.baseFontSize }
      : {}),
  }
}

async function readThemeFolder(folder: string) {
  // Obsidian before 0.16 kept each theme as one file in the themes folder.
  if ((await lstat(folder)).isFile() && folder.endsWith('.css'))
    return {
      manifest: { name: basename(folder).slice(0, -4) } as ThemeManifest,
      css: await readRegular(folder, MAX_THEME_BYTES),
    }
  let manifest: ThemeManifest = { name: basename(folder) }
  try {
    const raw: unknown = JSON.parse(
      (await readRegular(join(folder, 'manifest.json'), 64_000)).toString(
        'utf8',
      ),
    )
    if (raw && typeof raw === 'object') {
      const data = raw as Record<string, unknown>
      manifest = {
        name: text(data.name, 100) ?? manifest.name,
        version: text(data.version, 40),
        author: text(data.author),
        authorUrl: text(data.authorUrl),
      }
    }
  } catch {
    /* A theme without a manifest keeps its folder name. */
  }
  let css: Buffer
  try {
    css = await readRegular(join(folder, 'theme.css'), MAX_THEME_BYTES)
  } catch {
    // Themes from before 0.16 shipped obsidian.css.
    css = await readRegular(join(folder, 'obsidian.css'), MAX_THEME_BYTES)
  }
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license']) {
    try {
      manifest.license = (await readRegular(join(folder, name), 64_000))
        .toString('utf8')
        .slice(0, 64_000)
      break
    } catch {
      /* Try the next usual name. */
    }
  }
  return { manifest, css }
}

/** Themes, snippets and appearance settings in a vault. Read only. */
export async function readVault(vault: string): Promise<Vault> {
  const skipped: string[] = []
  const themes: VaultTheme[] = []
  const themeRoot = await configPath(vault, 'themes')
  for (const entry of await entries(themeRoot)) {
    try {
      if (
        entry.isDirectory() ||
        (entry.isFile() && entry.name.endsWith('.css'))
      ) {
        const { manifest, css } = await readThemeFolder(
          join(themeRoot as string, entry.name),
        )
        themes.push({
          name: entry.name,
          manifest,
          hash: sha256(css),
          bytes: css.length,
        })
      } else skipped.push(`themes/${entry.name}`)
    } catch {
      skipped.push(`themes/${entry.name}`)
    }
  }
  const snippets: VaultSnippet[] = []
  const snippetRoot = await configPath(vault, 'snippets')
  for (const entry of await entries(snippetRoot)) {
    if (!entry.name.endsWith('.css')) continue
    try {
      const css = await readRegular(
        join(snippetRoot as string, entry.name),
        MAX_SNIPPET_BYTES,
      )
      snippets.push({
        name: entry.name.slice(0, -4),
        hash: sha256(css),
        bytes: css.length,
      })
    } catch {
      skipped.push(`snippets/${entry.name}`)
    }
  }
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name)
  return {
    themes: themes.sort(byName),
    snippets: snippets.sort(byName),
    appearance: await readAppearance(vault),
    skipped,
  }
}

// Theme assets become data URLs, read only from inside the theme's own folder.
async function inlineAssets(folder: string, paths: readonly string[]) {
  const data = new Map<string, string>()
  const hashes: Record<string, string> = {}
  const root = await realpath(folder)
  for (const path of paths) {
    const type = assetTypes[extname(path).toLowerCase()]
    if (!type) continue
    try {
      const file = await realpath(join(folder, ...path.split('/')))
      const inside = relative(root, file)
      if (!inside || inside.startsWith(`..${sep}`) || inside === '..') continue
      const bytes = await readRegular(file, MAX_ASSET_BYTES)
      hashes[path] = sha256(bytes)
      data.set(path, `data:${type};base64,${bytes.toString('base64')}`)
    } catch {
      /* Missing or unreadable assets are reported as dropped rules. */
    }
  }
  return { data, hashes }
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'theme'

async function writeFolder(target: string, files: Record<string, string>) {
  const temporary = `${target}.${randomUUID()}.tmp`
  await mkdir(temporary, { recursive: true })
  try {
    for (const [name, value] of Object.entries(files))
      await writeFile(join(temporary, name), value)
    await rm(target, { recursive: true, force: true })
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

/** A theme folder's checked CSS, with its own assets inlined. Reads only. */
export async function checkTheme(folder: string) {
  const { manifest, css } = await readThemeFolder(folder)
  const original = css.toString('utf8')
  const first = sanitizeCss(original)
  const assets = await inlineAssets(folder, first.assets)
  const result = sanitizeCss(original, { assets: assets.data })
  return {
    manifest,
    original,
    result,
    assets,
    hash: sha256(css),
    settings: readStyleSettings(original).sections,
  }
}

/** Hash of a theme's CSS as it is now, without checking it. Reads only. */
// Hashes of kept vault files by path, reused while size and time match, so
// opening a vault doesn't read a 5 MB theme again.
const hashes = new Map<string, { key: string; hash: string }>()
/** Vault files read for hashing; tests check that unchanged files aren't read again. */
export const hashReads = { count: 0 }
async function fileHash(path: string, max: number) {
  const info = await lstat(path)
  if (!info.isFile()) throw new Error('not a regular file')
  const key = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`
  const known = hashes.get(path)
  if (known?.key === key) return known.hash
  hashReads.count++
  const hash = sha256(await readRegular(path, max))
  hashes.set(path, { key, hash })
  return hash
}

export async function themeHash(folder: string) {
  const info = await lstat(folder)
  if (info.isFile()) return fileHash(folder, MAX_THEME_BYTES)
  try {
    return await fileHash(join(folder, 'theme.css'), MAX_THEME_BYTES)
  } catch {
    return fileHash(join(folder, 'obsidian.css'), MAX_THEME_BYTES)
  }
}

export async function snippetHash(vault: string, name: string) {
  if (!/^[^/\\]{1,200}$/.test(name) || name.startsWith('.'))
    throw new Error('Choose a snippet from this vault.')
  const path = await configPath(vault, 'snippets', `${name}.css`)
  if (!path) throw new Error('This vault has no Obsidian settings folder.')
  return fileHash(path, MAX_SNIPPET_BYTES)
}

// Copying, saving a choice and pruning run one at a time, across windows
// (the main process has one copy of this module), so a prune never removes
// a copy that is about to be chosen.
let copies: Promise<unknown> = Promise.resolve()
export function withCopies<T>(task: () => Promise<T>): Promise<T> {
  const result = copies.then(task, task)
  copies = result.catch(() => undefined)
  return result
}

/** Copy a theme folder into Hibi's data with its hash, manifest and checked CSS. */
export async function installTheme(
  root: string,
  folder: string,
  source: InstalledTheme['source'],
  origin: Pick<InstalledTheme, 'repository' | 'ref' | 'commit'> = {},
): Promise<InstalledTheme> {
  const { manifest, original, result, assets, hash, settings } =
    await checkTheme(folder)
  const id = `${slug(manifest.name)}-${hash.slice(0, 12)}`
  const record: InstalledTheme = {
    id,
    manifest,
    source,
    ...(source === 'vault' ? { folder: basename(folder) } : {}),
    ...origin,
    hash,
    assets: assets.hashes,
    sanitizerVersion: SANITIZER_VERSION,
    dropped: result.dropped,
    settings,
  }
  await writeFolder(join(root, 'themes', id), {
    'theme.css': original,
    'checked.css': result.css,
    'hibi-theme.json': JSON.stringify(record, null, 2),
    // Kept so a newer sanitizer can check the original again.
    'assets.json': JSON.stringify(Object.fromEntries(assets.data)),
  })
  return record
}

async function replaceFile(path: string, text: string) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, text)
  await rename(temporary, path)
}
const current = async (path: string) => {
  try {
    return (
      JSON.parse(await readFile(path, 'utf8')).sanitizerVersion ===
      SANITIZER_VERSION
    )
  } catch {
    return false
  }
}

export async function installedThemes(root: string): Promise<InstalledTheme[]> {
  const themes: InstalledTheme[] = []
  for (const entry of await entries(join(root, 'themes'))) {
    if (!entry.isDirectory() || entry.name.endsWith('.tmp')) continue
    try {
      themes.push(
        JSON.parse(
          await readFile(
            join(root, 'themes', entry.name, 'hibi-theme.json'),
            'utf8',
          ),
        ),
      )
    } catch {
      /* Half-written or foreign folders are ignored. */
    }
  }
  return themes.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
}

const themeId = (id: unknown) => {
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,60}$/.test(id))
    throw new Error('Choose an installed theme.')
  return id
}

export async function removeTheme(root: string, id: unknown) {
  await rm(join(root, 'themes', themeId(id)), { recursive: true, force: true })
}

/** A copy's checked CSS, checked again from its original when the sanitizer has changed. */
export async function themeCss(root: string, id: unknown) {
  const folder = join(root, 'themes', themeId(id))
  const recordPath = join(folder, 'hibi-theme.json')
  if (await current(recordPath))
    return readFile(join(folder, 'checked.css'), 'utf8')
  const record: InstalledTheme = JSON.parse(await readFile(recordPath, 'utf8'))
  const original = await readFile(join(folder, 'theme.css'), 'utf8')
  let assets = new Map<string, string>()
  try {
    assets = new Map(
      Object.entries(
        JSON.parse(await readFile(join(folder, 'assets.json'), 'utf8')),
      ),
    )
  } catch {
    /* Copies from before assets were kept lose their local images. */
  }
  const result = sanitizeCss(original, { assets })
  await replaceFile(join(folder, 'checked.css'), result.css)
  await replaceFile(
    recordPath,
    JSON.stringify(
      {
        ...record,
        sanitizerVersion: SANITIZER_VERSION,
        dropped: result.dropped,
        settings: readStyleSettings(original).sections,
      },
      null,
      2,
    ),
  )
  return result.css
}

/** Copy one snippet into Hibi's data, keyed by its content. */
/** A vault snippet's checked CSS. Reads only. */
export async function checkSnippet(vault: string, name: string) {
  if (!/^[^/\\]{1,200}$/.test(name) || name.startsWith('.'))
    throw new Error('Choose a snippet from this vault.')
  const path = await configPath(vault, 'snippets', `${name}.css`)
  if (!path) throw new Error('This vault has no Obsidian settings folder.')
  const css = await readRegular(path, MAX_SNIPPET_BYTES)
  const text = css.toString('utf8')
  return {
    css,
    hash: sha256(css),
    result: sanitizeCss(text, { maxBytes: MAX_SNIPPET_BYTES }),
    settings: readStyleSettings(text).sections,
  }
}

export async function installSnippet(
  vault: string,
  root: string,
  name: string,
) {
  const { css, hash, result, settings } = await checkSnippet(vault, name)
  const folder = join(root, 'snippets', hash)
  await writeFolder(folder, {
    'snippet.css': css.toString('utf8'),
    'checked.css': result.css,
    'hibi-snippet.json': JSON.stringify(
      {
        name,
        hash,
        sanitizerVersion: SANITIZER_VERSION,
        dropped: result.dropped,
        settings,
      },
      null,
      2,
    ),
  })
  return { name, hash, dropped: result.dropped }
}

export async function snippetCss(root: string, hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Unknown snippet.')
  const folder = join(root, 'snippets', hash)
  const recordPath = join(folder, 'hibi-snippet.json')
  if (await current(recordPath))
    return readFile(join(folder, 'checked.css'), 'utf8')
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  const original = await readFile(join(folder, 'snippet.css'), 'utf8')
  const result = sanitizeCss(original, { maxBytes: MAX_SNIPPET_BYTES })
  await replaceFile(join(folder, 'checked.css'), result.css)
  await replaceFile(
    recordPath,
    JSON.stringify(
      {
        ...record,
        sanitizerVersion: SANITIZER_VERSION,
        dropped: result.dropped,
        settings: readStyleSettings(original).sections,
      },
      null,
      2,
    ),
  )
  return result.css
}

/** Style Settings sections kept with an installed theme or snippet copy. */
export async function copiedSettings(
  root: string,
  kind: 'theme' | 'snippet',
  id: string,
): Promise<StyleSection[]> {
  const path =
    kind === 'theme'
      ? join(root, 'themes', themeId(id), 'hibi-theme.json')
      : /^[a-f0-9]{64}$/.test(id)
        ? join(root, 'snippets', id, 'hibi-snippet.json')
        : null
  if (!path) return []
  try {
    const record = JSON.parse(await readFile(path, 'utf8'))
    return Array.isArray(record.settings) ? record.settings : []
  } catch {
    return []
  }
}

// Choices live in the vault's overlay in Hibi's data, never in the vault.
const selectionPath = async (data: string, vault: string) =>
  join(await obsidianDataPath(vault, data), 'themes.json')

export type StoredSelection = Selection & {
  /** Snippet name → content hash of the copy in Hibi's data. */
  snippetHashes: Record<string, string>
  /** Style Settings values keyed `section@@setting`, as the plugin keys them. */
  styleValues?: StyleValues
}

/** Keep only well-formed values: they come from the renderer. */
export function styleValues(input: unknown): StyleValues {
  const values: StyleValues = {}
  if (!input || typeof input !== 'object') return values
  for (const [key, value] of Object.entries(input).slice(0, 5000))
    if (
      /^[\w-]{1,100}@@[\w-]{1,100}(?:@@(?:light|dark))?$/.test(key) &&
      (typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.length <= 500))
    )
      values[key] = value
  return values
}

export async function readSelection(
  data: string,
  vault: string,
): Promise<StoredSelection | null> {
  try {
    const value = JSON.parse(
      await readFile(await selectionPath(data, vault), 'utf8'),
    )
    return {
      theme: typeof value.theme === 'string' ? value.theme : null,
      snippets: Array.isArray(value.snippets)
        ? value.snippets.filter((name: unknown) => typeof name === 'string')
        : [],
      snippetHashes:
        value.snippetHashes && typeof value.snippetHashes === 'object'
          ? value.snippetHashes
          : {},
      styleValues: styleValues(value.styleValues),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function writeSelection(
  data: string,
  vault: string,
  selection: StoredSelection,
) {
  const target = await selectionPath(data, vault)
  await mkdir(dirname(target), { recursive: true })
  // The copies chosen before stay for a while, so a change can be undone.
  let previous: unknown
  try {
    const old = JSON.parse(await readFile(target, 'utf8'))
    const same =
      old.theme === selection.theme &&
      JSON.stringify(old.snippetHashes ?? {}) ===
        JSON.stringify(selection.snippetHashes)
    previous = same
      ? old.previous
      : { theme: old.theme ?? null, snippetHashes: old.snippetHashes ?? {} }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify({ ...selection, previous }))
  await rename(temporary, target)
}

/**
 * Remove vault theme and snippet copies that no vault keeps or kept just
 * before. Themes added from a folder stay until removed. Only Hibi's data
 * folder is touched.
 */
export async function pruneCopies(root: string, data: string) {
  const themes = new Set<string>()
  const snippets = new Set<string>()
  const keep = (choice: unknown) => {
    if (!choice || typeof choice !== 'object') return
    const { theme, snippetHashes } = choice as Record<string, unknown>
    if (typeof theme === 'string') themes.add(theme)
    if (snippetHashes && typeof snippetHashes === 'object')
      for (const hash of Object.values(snippetHashes))
        if (typeof hash === 'string') snippets.add(hash)
  }
  for (const entry of await entries(join(data, 'obsidian-vaults'))) {
    if (!entry.isDirectory()) continue
    let value: Record<string, unknown>
    try {
      value = JSON.parse(
        await readFile(
          join(data, 'obsidian-vaults', entry.name, 'themes.json'),
          'utf8',
        ),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      // An unreadable choice might name any copy: keep them all.
      return []
    }
    keep(value)
    keep(value.previous)
  }
  const removed: string[] = []
  // Folders are removed by their own checked name, never by what a copy's
  // record says.
  for (const entry of await entries(join(root, 'themes'))) {
    if (
      !entry.isDirectory() ||
      !/^[a-z0-9-]{1,60}$/.test(entry.name) ||
      themes.has(entry.name)
    )
      continue
    let source: unknown
    try {
      source = JSON.parse(
        await readFile(
          join(root, 'themes', entry.name, 'hibi-theme.json'),
          'utf8',
        ),
      ).source
    } catch {
      continue
    }
    if (source !== 'vault') continue
    await rm(join(root, 'themes', entry.name), { recursive: true, force: true })
    removed.push(`themes/${entry.name}`)
  }
  for (const entry of await entries(join(root, 'snippets')))
    if (
      entry.isDirectory() &&
      /^[a-f0-9]{64}$/.test(entry.name) &&
      !snippets.has(entry.name)
    ) {
      await rm(join(root, 'snippets', entry.name), {
        recursive: true,
        force: true,
      })
      removed.push(`snippets/${entry.name}`)
    }
  return removed
}
