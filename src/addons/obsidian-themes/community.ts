// Themes from Obsidian's community directory, fetched through Hibi's bounded
// HTTPS download (the same transport addon installs use) from GitHub only,
// then checked and stored exactly like a theme folder. Nothing is applied.
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { download } from '../../main/download.ts'
import { downloadUrl } from '../../shared/addon-package.ts'
import { assetPath } from './sanitize.ts'
import { type InstalledTheme, installTheme } from './store.ts'

export const MAX_COMMUNITY_CSS = 5 * 1024 * 1024
const MAX_MANIFEST = 64 * 1024
const MAX_LICENSE = 64 * 1024
const MAX_RELEASE = 1024 * 1024
export const MAX_SCREENSHOT = 2 * 1024 * 1024

// Every hop, redirects included, must stay on these hosts.
const hosts = new Set([
  'api.github.com',
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])
const githubUrl = (value: string) => {
  const url = downloadUrl(value)
  if (!hosts.has(url.hostname) || url.port)
    throw new Error('The download left GitHub.')
  return url
}

export type CommunityFailure = {
  ok: false
  code:
    | 'cancelled'
    | 'invalid'
    | 'not-found'
    | 'too-large'
    | 'network'
    | 'name-mismatch'
    | 'unsafe'
  message: string
}
class Failure extends Error {
  readonly code: CommunityFailure['code']
  constructor(code: CommunityFailure['code'], message: string) {
    super(message)
    this.code = code
  }
}

export type CommunityDeps = {
  /** Hibi's main-process fetch (no cookies, manual redirects); a recorded one in tests. */
  fetch: typeof fetch
  signal: AbortSignal
}

const repoPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
const refPattern = /^[A-Za-z0-9._/-]{1,100}$/
function repoOf(value: unknown) {
  if (
    typeof value !== 'string' ||
    !repoPattern.test(value) ||
    value.split('/').includes('..')
  )
    throw new Failure('invalid', 'This theme has no valid GitHub repository.')
  return value
}
function refOf(value: unknown) {
  if (value === undefined || value === null || value === '') return 'HEAD'
  if (
    typeof value !== 'string' ||
    !refPattern.test(value) ||
    value.split('/').some((part) => part === '..' || part === '')
  )
    throw new Failure('invalid', 'This theme names an invalid branch.')
  return value
}
const path = (value: string) =>
  value.split('/').map(encodeURIComponent).join('/')

async function get(
  url: string,
  maxBytes: number,
  deps: CommunityDeps,
  accept = 'application/octet-stream',
) {
  const parts: Uint8Array[] = []
  const timeout = AbortSignal.timeout(30_000)
  try {
    await download(url, {
      maxBytes,
      signal: AbortSignal.any([deps.signal, timeout]),
      stallTimeoutMs: 10_000,
      accept,
      parseUrl: githubUrl,
      fetch: deps.fetch,
      write: (chunk) => {
        parts.push(chunk)
      },
    })
  } catch (error) {
    if (deps.signal.aborted)
      throw new Failure('cancelled', 'The theme download was cancelled.')
    const message = (error as Error).message ?? ''
    if (/\(404\)/.test(message))
      throw new Failure('not-found', 'The theme was not found on GitHub.')
    if (/exceeds/.test(message))
      throw new Failure('too-large', 'The theme is larger than Hibi allows.')
    if (/left GitHub|HTTPS/.test(message))
      throw new Failure('unsafe', 'The theme download left GitHub.')
    throw new Failure(
      'network',
      'Could not download the theme. Check your connection and try again.',
    )
  }
  return Buffer.concat(parts)
}
// Optional files: missing ones are fine, anything else still fails.
async function optional(
  url: string,
  maxBytes: number,
  deps: CommunityDeps,
  accept?: string,
) {
  try {
    return await get(url, maxBytes, deps, accept)
  } catch (error) {
    if (error instanceof Failure && error.code === 'not-found') return null
    throw error
  }
}

type Fetched = {
  manifest: Buffer
  css: Buffer
  file: 'theme.css' | 'obsidian.css'
  license: Buffer | null
  ref: string
  commit?: string
}

/** A theme's files from its latest release when it ships them, else from the branch. */
export async function fetchCommunityTheme(
  input: { repo: unknown; branch?: unknown },
  deps: CommunityDeps,
): Promise<Fetched> {
  const repo = repoOf(input.repo)
  const branch = refOf(input.branch)
  const api = `https://api.github.com/repos/${repo}`
  const release = await optional(
    `${api}/releases/latest`,
    MAX_RELEASE,
    deps,
    'application/vnd.github+json',
  )
  let fetched: Omit<Fetched, 'license'> | null = null
  if (release) {
    let data: { tag_name?: unknown; assets?: unknown }
    try {
      data = JSON.parse(release.toString('utf8'))
    } catch {
      data = {}
    }
    const assets = Array.isArray(data.assets) ? data.assets : []
    const asset = (name: string) => {
      const url = assets.find(
        (item: { name?: unknown }) => item?.name === name,
      )?.browser_download_url
      // Release assets must belong to this repository's releases.
      return typeof url === 'string' &&
        url.startsWith(`https://github.com/${repo}/releases/download/`)
        ? url
        : null
    }
    const css = asset('theme.css')
    const manifest = asset('manifest.json')
    if (css && manifest && typeof data.tag_name === 'string')
      fetched = {
        manifest: await get(manifest, MAX_MANIFEST, deps),
        css: await get(css, MAX_COMMUNITY_CSS, deps),
        file: 'theme.css',
        ref: refOf(data.tag_name),
      }
  }
  if (!fetched) {
    const raw = `https://raw.githubusercontent.com/${repo}/${path(branch)}`
    const manifest = await get(`${raw}/manifest.json`, MAX_MANIFEST, deps)
    let css = await optional(`${raw}/theme.css`, MAX_COMMUNITY_CSS, deps)
    let file: Fetched['file'] = 'theme.css'
    if (!css) {
      // Themes from before Obsidian 0.16 ship obsidian.css.
      css = await get(`${raw}/obsidian.css`, MAX_COMMUNITY_CSS, deps)
      file = 'obsidian.css'
    }
    const sha = await optional(
      `${api}/commits/${path(branch)}`,
      1024,
      deps,
      'application/vnd.github.sha',
    )
    const commit = sha?.toString('utf8').trim()
    fetched = {
      manifest,
      css,
      file,
      ref: branch,
      ...(commit && /^[a-f0-9]{40}$/.test(commit) ? { commit } : {}),
    }
  }
  // The license as of the same version, when the repository has one.
  const at = path(fetched.commit ?? fetched.ref)
  let license: Buffer | null = null
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    license = await optional(
      `https://raw.githubusercontent.com/${repo}/${at}/${name}`,
      MAX_LICENSE,
      deps,
    )
    if (license) break
  }
  return { ...fetched, license }
}

/** Fetch, check and store a community theme. Never applies it. */
export async function installCommunityTheme(
  root: string,
  input: { repo: unknown; name: unknown; branch?: unknown },
  deps: CommunityDeps,
): Promise<{ ok: true; theme: InstalledTheme } | CommunityFailure> {
  try {
    if (
      typeof input.name !== 'string' ||
      !input.name ||
      input.name.length > 100
    )
      throw new Failure('invalid', 'This theme has no valid name.')
    const repository = repoOf(input.repo)
    const fetched = await fetchCommunityTheme(input, deps)
    let manifest: { name?: unknown }
    try {
      manifest = JSON.parse(fetched.manifest.toString('utf8'))
    } catch {
      throw new Failure('invalid', 'The theme’s manifest.json is not valid.')
    }
    // Obsidian requires the directory name and the manifest name to match.
    if (manifest?.name !== input.name)
      throw new Failure(
        'name-mismatch',
        'The theme’s manifest names a different theme than the directory.',
      )
    deps.signal.throwIfAborted()
    const folder = join(root, 'incoming', randomUUID())
    await mkdir(folder, { recursive: true })
    try {
      await writeFile(join(folder, 'manifest.json'), fetched.manifest)
      await writeFile(join(folder, fetched.file), fetched.css)
      if (fetched.license)
        await writeFile(join(folder, 'LICENSE'), fetched.license)
      const theme = await installTheme(root, folder, 'community', {
        repository,
        ref: fetched.ref,
        ...(fetched.commit ? { commit: fetched.commit } : {}),
      })
      return { ok: true, theme }
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  } catch (error) {
    if (error instanceof Failure)
      return { ok: false, code: error.code, message: error.message }
    if (deps.signal.aborted)
      return {
        ok: false,
        code: 'cancelled',
        message: 'The theme download was cancelled.',
      }
    throw error
  }
}

const imageTypes: [string, (bytes: Buffer) => boolean][] = [
  [
    'image/png',
    (b) => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  ],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', (b) => /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1'))],
  [
    'image/webp',
    (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  ],
]

/** A directory screenshot as a data URL, loaded only when asked for. */
export async function communityScreenshot(
  input: { repo: unknown; path: unknown; branch?: unknown },
  deps: CommunityDeps,
): Promise<{ ok: true; dataUrl: string } | CommunityFailure> {
  try {
    const repo = repoOf(input.repo)
    const file = typeof input.path === 'string' ? assetPath(input.path) : null
    if (!file) throw new Failure('invalid', 'This theme has no screenshot.')
    const bytes = await get(
      `https://raw.githubusercontent.com/${repo}/${path(refOf(input.branch))}/${path(file)}`,
      MAX_SCREENSHOT,
      deps,
      'image/*',
    )
    const type = imageTypes.find(([, test]) => test(bytes))?.[0]
    if (!type)
      throw new Failure(
        'unsafe',
        'The screenshot is not a PNG, JPEG, GIF or WebP image.',
      )
    return {
      ok: true,
      dataUrl: `data:${type};base64,${bytes.toString('base64')}`,
    }
  } catch (error) {
    if (error instanceof Failure)
      return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

export type CommunityTheme = {
  name: string
  author: string
  repo: string
  screenshot: string | null
  modes: ('light' | 'dark')[]
  branch?: string
}

/** Valid entries of community-css-themes.json; others are left out. */
export function parseCommunityThemes(json: unknown): CommunityTheme[] {
  if (!Array.isArray(json)) return []
  return json.slice(0, 5000).flatMap((item): CommunityTheme[] => {
    if (!item || typeof item !== 'object') return []
    const { name, author, repo, screenshot, modes, branch } = item as Record<
      string,
      unknown
    >
    if (
      typeof name !== 'string' ||
      !name ||
      name.length > 100 ||
      typeof author !== 'string' ||
      author.length > 200 ||
      typeof repo !== 'string' ||
      !repoPattern.test(repo)
    )
      return []
    let ref: string | undefined
    try {
      ref = branch === undefined ? undefined : refOf(branch)
    } catch {
      return []
    }
    return [
      {
        name,
        author,
        repo,
        screenshot:
          typeof screenshot === 'string' ? assetPath(screenshot) : null,
        modes: Array.isArray(modes)
          ? modes.filter(
              (mode): mode is 'light' | 'dark' =>
                mode === 'light' || mode === 'dark',
            )
          : [],
        ...(ref ? { branch: ref } : {}),
      },
    ]
  })
}
