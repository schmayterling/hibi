import { createHash, randomUUID } from 'node:crypto'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { download } from '../../main/download.ts'
import { errorMessage } from '../../shared/errors.ts'
import {
  type CommunityDetails,
  type CommunityDirectory,
  type CommunityEntry,
  parseCommunityEntries,
  validCommunityRepo,
} from './community-types.ts'
import {
  type CommunityPluginSource,
  parseObsidianManifest,
  pluginLimits,
} from './package.ts'
import {
  makeDirectory,
  readObsidianPackageBytes,
  readPluginFile,
} from './store.ts'

const DIRECTORY =
  'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/'
const ORIGINS = [
  'https://github.com',
  'https://api.github.com',
  'https://raw.githubusercontent.com',
  'https://release-assets.githubusercontent.com',
  'https://objects.githubusercontent.com',
]
const DIRECTORY_LIMIT = 8 * 1024 * 1024
const HOUR = 60 * 60 * 1000
type Saved = { text: string; etag: string | null; fetchedAt: string }
type Release = { tag: string; assets: Record<string, string> }
export class CommunityHttpError extends Error {
  constructor(readonly status: number) {
    super('GitHub returned HTTP ' + status + '. Try again later.')
  }
}
const decode = (bytes: Uint8Array) => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text.includes('\0'))
    throw new Error('The community file is not valid UTF-8 text.')
  return text
}
const tagFromUrl = (url: URL, repo: string) => {
  const prefix = '/' + repo + '/releases/download/'
  if (url.origin !== 'https://github.com' || !url.pathname.startsWith(prefix))
    return null
  const tag = url.pathname.slice(prefix.length).split('/')[0]
  return tag ? decodeURIComponent(tag) : null
}

/** Same bounded, cookie-free HTTPS downloader used by Hibi garden. No renderer fetches. */
export async function fetchCommunityFile(
  url: string,
  maxBytes: number,
  signal: AbortSignal,
  request: typeof fetch,
  etag?: string | null,
  cachedText?: string,
) {
  const parts: Uint8Array[] = []
  let nextEtag: string | null = null
  let release: string | null = null
  const repo = new URL(url).pathname.split('/').slice(1, 3).join('/')
  const result = await download(url, {
    maxBytes,
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    stallTimeoutMs: 10000,
    allowedOrigins: ORIGINS,
    accept: 'application/json, text/plain;q=0.9',
    fetch: async (input, init) => {
      const target = new URL(String(input))
      const headers = new Headers(init?.headers)
      headers.set('User-Agent', 'Hibi-Obsidian-Community')
      if (etag && target.href === url) headers.set('If-None-Match', etag)
      const response = await request(input, { ...init, headers })
      const location = response.headers.get('location')
      if (location) release ??= tagFromUrl(new URL(location, target), repo)
      nextEtag = response.headers.get('etag')
      if (response.status === 304 && cachedText !== undefined)
        return new Response(cachedText, {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      if (
        !response.ok &&
        ![301, 302, 303, 307, 308].includes(response.status)
      ) {
        await response.body?.cancel()
        throw new CommunityHttpError(response.status)
      }
      return response
    },
    write: (chunk) => {
      parts.push(chunk)
    },
  })
  return {
    bytes: Buffer.concat(parts),
    etag: nextEtag ?? etag ?? null,
    release,
    url: result.url,
  }
}

export class CommunityService {
  private cache = new Map<string, Saved | null>()
  constructor(
    readonly root: string,
    readonly fetch: typeof globalThis.fetch,
  ) {}

  private async json(
    name: string,
    validate: (value: unknown) => void,
    refresh: boolean,
    signal: AbortSignal,
  ): Promise<{ value: unknown; fetchedAt: string; error?: string }> {
    const path = join(this.root, name)
    if (!this.cache.has(name)) {
      let saved: Saved | null = null
      try {
        const value = JSON.parse(
          decode(await readPluginFile(path, DIRECTORY_LIMIT * 3)),
        ) as Saved
        if (
          typeof value.text === 'string' &&
          Buffer.byteLength(value.text) <= DIRECTORY_LIMIT &&
          typeof value.fetchedAt === 'string' &&
          Number.isFinite(Date.parse(value.fetchedAt)) &&
          (value.etag === null ||
            (typeof value.etag === 'string' &&
              value.etag.length < 1000 &&
              !/[\r\n]/.test(value.etag)))
        ) {
          validate(JSON.parse(value.text))
          saved = value
        }
      } catch {
        /* Missing or invalid cache is replaced by a validated response. */
      }
      this.cache.set(name, saved)
    }
    const saved = this.cache.get(name)
    if (saved && !refresh && Date.now() - Date.parse(saved.fetchedAt) < HOUR)
      return { value: JSON.parse(saved.text), fetchedAt: saved.fetchedAt }
    try {
      const result = await fetchCommunityFile(
        DIRECTORY + name,
        DIRECTORY_LIMIT,
        signal,
        this.fetch,
        saved?.etag,
        saved?.text,
      )
      const text = decode(result.bytes)
      const value: unknown = JSON.parse(text)
      validate(value)
      signal.throwIfAborted()
      const next: Saved = {
        text,
        etag: result.etag,
        fetchedAt: new Date().toISOString(),
      }
      await makeDirectory(this.root)
      const temporary = join(this.root, '.' + randomUUID() + '.tmp')
      try {
        await writeFile(temporary, JSON.stringify(next), {
          flag: 'wx',
          mode: 0o600,
        })
        signal.throwIfAborted()
        await rename(temporary, path)
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
      this.cache.set(name, next)
      return { value, fetchedAt: next.fetchedAt }
    } catch (error) {
      signal.throwIfAborted()
      if (!saved) throw error
      return {
        value: JSON.parse(saved.text),
        fetchedAt: saved.fetchedAt,
        error: errorMessage(error),
      }
    }
  }

  async directory(
    refresh = false,
    signal = new AbortController().signal,
  ): Promise<CommunityDirectory> {
    const plugins = await this.json(
      'community-plugins.json',
      (value) => {
        parseCommunityEntries(value, 'plugin')
      },
      refresh,
      signal,
    )
    const stats = await this.json(
      'community-plugin-stats.json',
      (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Invalid community download statistics.')
      },
      refresh,
      signal,
    ).catch((error) => {
      signal.throwIfAborted()
      return {
        value: {},
        fetchedAt: plugins.fetchedAt,
        error: errorMessage(error),
      }
    })
    const themes = await this.json(
      'community-css-themes.json',
      (value) => {
        parseCommunityEntries(value, 'theme')
      },
      refresh,
      signal,
    ).catch((error) => {
      signal.throwIfAborted()
      return {
        value: [],
        fetchedAt: plugins.fetchedAt,
        error: errorMessage(error),
      }
    })
    const errors = [plugins.error, stats.error, themes.error]
      .filter(Boolean)
      .join(' ')
    return {
      entries: [
        ...parseCommunityEntries(plugins.value, 'plugin', stats.value),
        ...parseCommunityEntries(themes.value, 'theme'),
      ],
      fetchedAt: plugins.fetchedAt,
      ...(errors ? { error: errors } : {}),
    }
  }

  async entry(kind: unknown, id: unknown, signal: AbortSignal) {
    if (
      (kind !== 'plugin' && kind !== 'theme') ||
      typeof id !== 'string' ||
      id.length > 200
    )
      throw new Error('Choose an item from the Obsidian community directory.')
    const entry = (await this.directory(false, signal)).entries.find(
      (item) => item.kind === kind && item.id === id,
    )
    if (!entry)
      throw new Error(
        'This item is no longer in the Obsidian community directory.',
      )
    return entry
  }

  async latest(repo: string, signal: AbortSignal): Promise<Release> {
    if (!validCommunityRepo(repo))
      throw new Error('Invalid community repository.')
    const response = await fetchCommunityFile(
      'https://api.github.com/repos/' + repo + '/releases/latest',
      1024 * 1024,
      signal,
      this.fetch,
    )
    const value = JSON.parse(decode(response.bytes))
    if (
      typeof value.tag_name !== 'string' ||
      !value.tag_name ||
      value.tag_name.length > 200 ||
      /\p{Cc}/u.test(value.tag_name) ||
      value.draft ||
      value.prerelease ||
      !Array.isArray(value.assets)
    )
      throw new Error('This repository has no installable latest release.')
    const assets: Record<string, string> = {}
    for (const asset of value.assets) {
      if (
        !['manifest.json', 'main.js', 'styles.css', 'theme.css'].includes(
          asset.name,
        )
      )
        continue
      const target = new URL(asset.browser_download_url)
      if (
        target.origin !== 'https://github.com' ||
        target.pathname !==
          '/' +
            repo +
            '/releases/download/' +
            encodeURIComponent(value.tag_name) +
            '/' +
            asset.name
      )
        throw new Error('The release contains an invalid asset URL.')
      assets[asset.name] = target.href
    }
    return { tag: value.tag_name, assets }
  }

  async details(
    entry: CommunityEntry,
    signal: AbortSignal,
  ): Promise<CommunityDetails> {
    const raw =
      'https://raw.githubusercontent.com/' +
      entry.repo +
      '/' +
      (entry.branch ? encodeURIComponent(entry.branch) : 'HEAD') +
      '/README.md'
    const result: CommunityDetails = {
      readme: '',
      readmeUrl: raw,
      release: null,
    }
    try {
      let url = raw
      let response: Awaited<ReturnType<typeof fetchCommunityFile>>
      try {
        response = await fetchCommunityFile(
          url,
          1024 * 1024,
          signal,
          this.fetch,
        )
      } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof CommunityHttpError) || error.status !== 404)
          throw error
        const metadata = JSON.parse(
          decode(
            (
              await fetchCommunityFile(
                'https://api.github.com/repos/' + entry.repo + '/readme',
                64 * 1024,
                signal,
                this.fetch,
              )
            ).bytes,
          ),
        )
        const target = new URL(metadata.download_url)
        if (
          target.origin !== 'https://raw.githubusercontent.com' ||
          !target.pathname
            .toLowerCase()
            .startsWith('/' + entry.repo.toLowerCase() + '/')
        )
          throw new Error(
            'The README download does not belong to this repository.',
          )
        url = target.href
        response = await fetchCommunityFile(
          url,
          1024 * 1024,
          signal,
          this.fetch,
        )
      }
      result.readme = decode(response.bytes)
      result.readmeUrl = url
    } catch (error) {
      signal.throwIfAborted()
      result.error = errorMessage(error)
    }
    if (entry.kind === 'theme') {
      try {
        const release = await this.latest(entry.repo, signal)
        if (release.assets['theme.css']) result.release = release.tag
      } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof CommunityHttpError && error.status === 404))
          result.error = [result.error, errorMessage(error)]
            .filter(Boolean)
            .join(' ')
      }
      if (!result.release) {
        try {
          const response = await fetchCommunityFile(
            'https://api.github.com/repos/' +
              entry.repo +
              '/commits/' +
              encodeURIComponent(entry.branch ?? 'HEAD'),
            64 * 1024,
            signal,
            this.fetch,
          )
          const text = decode(response.bytes)
          const sha = text.trim().startsWith('{')
            ? JSON.parse(text).sha
            : text.trim()
          if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha))
            throw new Error('The theme repository returned an invalid version.')
          result.release = sha
        } catch (error) {
          signal.throwIfAborted()
          result.error = [result.error, errorMessage(error)]
            .filter(Boolean)
            .join(' ')
        }
      }
      return result
    }
    try {
      const release = await this.latest(entry.repo, signal)
      result.release = release.tag
      const manifestUrl =
        release.assets['manifest.json'] ??
        'https://github.com/' +
          entry.repo +
          '/releases/download/' +
          encodeURIComponent(release.tag) +
          '/manifest.json'
      const rawManifest = JSON.parse(
        decode(
          (
            await fetchCommunityFile(
              manifestUrl,
              pluginLimits['manifest.json'],
              signal,
              this.fetch,
            )
          ).bytes,
        ),
      )
      const manifest = parseObsidianManifest(rawManifest)
      if (
        manifest.id !== entry.id ||
        typeof rawManifest.isDesktopOnly !== 'boolean'
      )
        throw new Error(
          'The release manifest does not match this directory entry.',
        )
      result.version = manifest.version
      result.minAppVersion = manifest.minAppVersion
      result.desktopOnly = manifest.isDesktopOnly
    } catch (error) {
      signal.throwIfAborted()
      result.error = [result.error, errorMessage(error)]
        .filter(Boolean)
        .join(' ')
    }
    return result
  }

  async plugin(entry: CommunityEntry, signal: AbortSignal) {
    let manifestFile: Awaited<ReturnType<typeof fetchCommunityFile>> | undefined
    let release: Release
    try {
      manifestFile = await fetchCommunityFile(
        'https://github.com/' +
          entry.repo +
          '/releases/latest/download/manifest.json',
        pluginLimits['manifest.json'],
        signal,
        this.fetch,
      )
    } catch (error) {
      signal.throwIfAborted()
      if (
        !(error instanceof CommunityHttpError) ||
        ![403, 404].includes(error.status)
      )
        throw error
    }
    if (manifestFile?.release)
      release = { tag: manifestFile.release, assets: {} }
    else release = await this.latest(entry.repo, signal)
    const asset = async (name: keyof typeof pluginLimits) => {
      const url =
        release.assets[name] ??
        'https://github.com/' +
          entry.repo +
          '/releases/download/' +
          encodeURIComponent(release.tag) +
          '/' +
          name
      return (
        await fetchCommunityFile(url, pluginLimits[name], signal, this.fetch)
      ).bytes
    }
    // A latest link without a verifiable tag is refetched from the pinned release.
    const manifest = manifestFile?.release
      ? manifestFile.bytes
      : await asset('manifest.json')
    const parsed = parseObsidianManifest(JSON.parse(decode(manifest)))
    if (parsed.id !== entry.id)
      throw new Error(
        'The release manifest does not match this directory entry.',
      )
    const main = await asset('main.js')
    let styles: Buffer | null = null
    try {
      styles = await asset('styles.css')
    } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof CommunityHttpError) || error.status !== 404)
        throw error
    }
    const packageData = readObsidianPackageBytes(manifest, main, styles)
    const hash = (value: Buffer) =>
      createHash('sha256').update(value).digest('hex')
    const source: CommunityPluginSource = {
      repo: entry.repo,
      author: entry.author,
      release: release.tag,
      hashes: {
        manifest: hash(manifest),
        main: hash(main),
        styles: styles ? hash(styles) : null,
      },
    }
    return { packageData, source }
  }
}
