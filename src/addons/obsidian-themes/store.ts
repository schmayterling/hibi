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
  source: 'vault' | 'folder'
  hash: string
  assets: Record<string, string>
  sanitizerVersion: number
  dropped: DroppedRule[]
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
      if (entry.isDirectory()) {
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

/** Copy a theme folder into Hibi's data with its hash, manifest and checked CSS. */
/** A theme folder's checked CSS, with its own assets inlined. Reads only. */
export async function checkTheme(folder: string) {
  const { manifest, css } = await readThemeFolder(folder)
  const original = css.toString('utf8')
  const first = sanitizeCss(original)
  const assets = await inlineAssets(folder, first.assets)
  const result = sanitizeCss(original, { assets: assets.data })
  return { manifest, original, result, assets, hash: sha256(css) }
}

export async function installTheme(
  root: string,
  folder: string,
  source: InstalledTheme['source'],
): Promise<InstalledTheme> {
  const { manifest, original, result, assets, hash } = await checkTheme(folder)
  const id = `${slug(manifest.name)}-${hash.slice(0, 12)}`
  const record: InstalledTheme = {
    id,
    manifest,
    source,
    hash,
    assets: assets.hashes,
    sanitizerVersion: SANITIZER_VERSION,
    dropped: result.dropped,
  }
  await writeFolder(join(root, 'themes', id), {
    'theme.css': original,
    'checked.css': result.css,
    'hibi-theme.json': JSON.stringify(record, null, 2),
  })
  return record
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

export async function themeCss(root: string, id: unknown) {
  return readFile(join(root, 'themes', themeId(id), 'checked.css'), 'utf8')
}

/** Copy one snippet into Hibi's data, keyed by its content. */
/** A vault snippet's checked CSS. Reads only. */
export async function checkSnippet(vault: string, name: string) {
  if (!/^[^/\\]{1,200}$/.test(name) || name.startsWith('.'))
    throw new Error('Choose a snippet from this vault.')
  const path = await configPath(vault, 'snippets', `${name}.css`)
  if (!path) throw new Error('This vault has no Obsidian settings folder.')
  const css = await readRegular(path, MAX_SNIPPET_BYTES)
  return {
    css,
    hash: sha256(css),
    result: sanitizeCss(css.toString('utf8'), { maxBytes: MAX_SNIPPET_BYTES }),
  }
}

export async function installSnippet(
  vault: string,
  root: string,
  name: string,
) {
  const { css, hash, result } = await checkSnippet(vault, name)
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
      },
      null,
      2,
    ),
  })
  return { name, hash, dropped: result.dropped }
}

export async function snippetCss(root: string, hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Unknown snippet.')
  return readFile(join(root, 'snippets', hash, 'checked.css'), 'utf8')
}

// Choices live in the vault's overlay in Hibi's data, never in the vault.
const selectionPath = async (data: string, vault: string) =>
  join(await obsidianDataPath(vault, data), 'themes.json')

export type StoredSelection = Selection & {
  /** Snippet name → content hash of the copy in Hibi's data. */
  snippetHashes: Record<string, string>
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
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(selection))
  await rename(temporary, target)
}
