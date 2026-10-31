import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { downloadUrl } from '../shared/addon-package.ts'
import { writeText } from './files.ts'
import { imageMime } from './images.ts'
import { isPathInside } from './workspace-paths.ts'

const HOUR = 60 * 60 * 1000
/** A host can't fill the disk: a larger image is neither kept nor shown. */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024
/** Past this, a folder's least recently checked images are deleted. */
const MAX_FOLDER_BYTES = 512 * 1024 * 1024
/** A host that sends nothing for this long has failed, so a kept copy shows. */
const QUIET_MS = 15_000
/**
 * A copy kept before shows once a check takes this long, however steadily its
 * host trickles bytes; the check carries on.
 */
const STALE_MS = 3_000
// The formats a page's images ask for, so hosts send what they would draw.
const ACCEPT =
  'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
const READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)

/** Where a note's remote images are kept. */
export type RemoteImagePlace = {
  note: string | null
  workspace: string | null
  /** The app's data folder, for notes outside the workspace. */
  data: string
}

/** What is known about a kept image, stored beside it as JSON. */
type Kept = {
  url: string
  type: string
  size: number
  checked: number
  etag?: string
  modified?: string
}

/**
 * A folder Hibi made and can write to, never a link to one elsewhere: a
 * read-only one, such as in a shared folder, would fail every download.
 */
async function folder(path: string) {
  await mkdir(path, { mode: 0o700 }).catch(() => {})
  const stat = await lstat(path).catch(() => null)
  return stat?.isDirectory() &&
    (await access(path, constants.W_OK).then(
      () => true,
      () => false,
    ))
    ? path
    : null
}

/**
 * Where `source` is kept: in the workspace's `.hibi/cache/images`, which git
 * skips, for a note in the workspace; otherwise, or when the workspace's
 * cache can't be used, in the app's data folder.
 */
async function imagePath(source: unknown, place: RemoteImagePlace) {
  let url: URL
  try {
    url = downloadUrl(source)
  } catch {
    return null
  }
  let directory: string | null = null
  if (
    place.workspace &&
    place.note &&
    isPathInside(place.workspace, place.note)
  ) {
    const metadata = await folder(join(place.workspace, '.hibi'))
    const cache = metadata && (await folder(join(metadata, 'cache')))
    if (cache) {
      await writeFile(join(cache, '.gitignore'), '*\n', { flag: 'wx' }).catch(
        () => {},
      )
      directory = await folder(join(cache, 'images'))
    }
  }
  directory ??= await folder(join(place.data, 'image-cache'))
  const name = createHash('sha256').update(url.href).digest('hex')
  return directory ? { url, path: join(directory, name) } : null
}

async function readKept(path: string, url: string): Promise<Kept | null> {
  try {
    const [text, stat] = await Promise.all([
      readFile(`${path}.json`, { encoding: 'utf8', flag: READ }),
      lstat(path),
    ])
    const kept = JSON.parse(text) as Kept
    return kept.url === url &&
      /^image\/[\w.+-]+$/.test(kept.type) &&
      Number.isFinite(kept.checked) &&
      typeof (kept.etag ?? '') === 'string' &&
      typeof (kept.modified ?? '') === 'string' &&
      stat.isFile() &&
      stat.size === kept.size
      ? kept
      : null
  } catch {
    return null
  }
}

/**
 * Downloads `url` to `path`, or learns from `kept`'s validators that it has
 * not changed. Requests carry no cookies, skip Chromium's own cache, and
 * follow at most five redirects, each to an HTTPS address.
 */
async function download(
  path: string,
  url: URL,
  kept: Kept | null,
  fetch: typeof globalThis.fetch,
  stop: AbortSignal,
): Promise<Kept> {
  const quiet = new AbortController()
  const stopped = new Promise<never>((_resolve, reject) =>
    quiet.signal.addEventListener('abort', () => reject(quiet.signal.reason), {
      once: true,
    }),
  )
  stopped.catch(() => {})
  // A refresh that replaces this check ends it, as a quiet host does.
  if (stop.aborted) quiet.abort()
  else stop.addEventListener('abort', () => quiet.abort(), { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const wait = <T>(operation: Promise<T>) => {
    clearTimeout(timer)
    timer = setTimeout(() => quiet.abort(), QUIET_MS)
    return Promise.race([operation, stopped])
  }
  try {
    let target = url
    for (let redirects = 0; ; redirects++) {
      const response = await wait(
        fetch(target, {
          signal: quiet.signal,
          redirect: 'manual',
          credentials: 'omit',
          cache: 'no-store',
          headers: {
            Accept: ACCEPT,
            ...(kept?.etag ? { 'If-None-Match': kept.etag } : {}),
            ...(kept?.modified ? { 'If-Modified-Since': kept.modified } : {}),
          },
        }),
      )
      const location = response.headers.get('location')
      if (
        location &&
        redirects < 5 &&
        [301, 302, 303, 307, 308].includes(response.status)
      ) {
        await response.body?.cancel()
        target = downloadUrl(new URL(location, target).href)
        continue
      }
      const etag = response.headers.get('etag')
      const modified = response.headers.get('last-modified')
      const validators = {
        ...(etag && etag.length <= 1024 ? { etag } : {}),
        ...(modified && modified.length <= 1024 ? { modified } : {}),
      }
      if (response.status === 304 && kept) {
        await response.body?.cancel()
        const checked = { ...kept, ...validators, checked: Date.now() }
        await writeText(`${path}.json`, JSON.stringify(checked))
        return checked
      }
      const length = Number(response.headers.get('content-length'))
      if (!response.ok || !response.body || length > MAX_IMAGE_BYTES) {
        await response.body?.cancel()
        throw new Error(`The image host answered ${response.status}.`)
      }
      const declared = /^image\/[\w.+-]+$/i
        .exec(
          response.headers.get('content-type')?.split(';')[0]?.trim() ?? '',
        )?.[0]
        .toLowerCase()
      const reader = response.body.getReader()
      let size = 0
      let head = Buffer.alloc(0)
      let type = ''
      // The image replaces the kept one only once all of it is here.
      await writeText(
        path,
        (async function* () {
          for (;;) {
            const { done, value } = await wait(reader.read())
            if (done) break
            size += value.length
            if (size > MAX_IMAGE_BYTES)
              throw new Error('The image is too large to keep.')
            if (head.length < 4096)
              head = Buffer.concat([head, value.subarray(0, 4096)])
            yield value
          }
          type = imageMime(head) ?? declared ?? ''
          if (
            !type ||
            !size ||
            (length &&
              !response.headers.get('content-encoding') &&
              size !== length)
          )
            throw new Error('The image did not arrive.')
        })(),
      )
      const stored = {
        url: url.href,
        type,
        size,
        checked: Date.now(),
        ...validators,
      }
      await writeText(`${path}.json`, JSON.stringify(stored))
      return stored
    }
  } finally {
    clearTimeout(timer)
    quiet.abort()
  }
}

/** What the check of `image` returns, or the copy kept before once the check takes `STALE_MS`. */
async function checkedOrKept(
  image: { url: URL; path: string },
  fetch: typeof globalThis.fetch,
) {
  const checked = check(image, false, fetch)
  // Draws share their check's deadline, so one that comes when a check has
  // already run that long, such as after a reload, shows the copy at once.
  const started = checks.get(image.path)?.started ?? Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<Kept | null>((resolve) => {
    timer = setTimeout(
      () => resolve(readKept(image.path, image.url.href)),
      Math.max(0, started + STALE_MS - Date.now()),
    )
  })
  try {
    // Without a copy, only the check can answer.
    return await Promise.race([checked, late.then((kept) => kept ?? checked)])
  } finally {
    clearTimeout(timer)
  }
}

/** Each kept image's latest check, which concurrent draws of it share, its stop, and its start. */
const checks = new Map<
  string,
  { result: Promise<Kept | null>; stop: AbortController; started: number }
>()

/**
 * The kept copy at `path`, fetched again when it is a day old or `force`
 * asks. When the host can't be reached or refuses, the last copy stays.
 */
function check(
  { url, path }: { url: URL; path: string },
  force: boolean,
  fetch: typeof globalThis.fetch,
) {
  const running = checks.get(path)
  if (running && !force) return running.result
  const stop = new AbortController()
  const result: Promise<Kept | null> = (async () => {
    if (running) {
      // An image's first download is already its newest copy, and stopping
      // it would leave its draws with nothing: a refresh waits for it. Any
      // other running check, such as one a slow host holds, makes way.
      if (!(await readKept(path, url.href))) return running.result
      running.stop.abort()
      await running.result
    }
    const kept = await readKept(path, url.href)
    const age = Date.now() - (kept?.checked ?? 0)
    if (kept && !force && age >= 0 && age < 24 * HOUR) return kept
    try {
      const fetched = await download(
        path,
        url,
        force ? null : kept,
        fetch,
        stop.signal,
      )
      void prune(dirname(path), fetched.size - (kept?.size ?? 0))
      return fetched
    } catch {
      return kept
    }
  })().finally(() => {
    if (checks.get(path)?.result === result) checks.delete(path)
  })
  checks.set(path, { result, stop, started: Date.now() })
  return result
}

/** Each folder's last prune, and the bytes it held then plus what downloads added since. */
const pruned = new Map<string, { at: number; bytes: number }>()

/**
 * Deletes a folder's least recently checked images past its size, and what
 * interrupted downloads left: hourly, or at once when downloads since the last
 * prune would take the folder past its size.
 */
async function prune(directory: string, added: number) {
  const last = pruned.get(directory)
  if (last) last.bytes += added
  if (last && Date.now() - last.at < HOUR && last.bytes <= MAX_FOLDER_BYTES)
    return
  const current = { at: Date.now(), bytes: 0 }
  pruned.set(directory, current)
  try {
    const images: { name: string; size: number; checked: number }[] = []
    // One file at a time, so saves never wait behind the folder.
    for (const name of await readdir(directory)) {
      const stat = await lstat(join(directory, name)).catch(() => null)
      if (name.endsWith('.tmp') && stat && Date.now() - stat.mtimeMs > HOUR)
        await rm(join(directory, name), { force: true })
      if (!/^[\da-f]{64}$/.test(name)) continue
      const about = await lstat(join(directory, `${name}.json`)).catch(
        () => null,
      )
      images.push({
        name,
        size: stat?.size ?? 0,
        checked: about?.mtimeMs ?? 0,
      })
    }
    let total = images.reduce((sum, image) => sum + image.size, 0)
    images.sort((left, right) => left.checked - right.checked)
    for (const { name, size } of images) {
      if (total <= MAX_FOLDER_BYTES) break
      total -= size
      await rm(join(directory, `${name}.json`), { force: true })
      await rm(join(directory, name), { force: true })
    }
    // Downloads that ended during the count may count twice: an early prune.
    current.bytes += total
  } catch {
    /* A later download prunes again. */
  }
}

/**
 * A remote image for the app's pages: the kept copy while it is under a day
 * old, else what its host sends now, which is kept. Offline, or when the host
 * fails, the last copy shows; with none, the image fails to load.
 */
export async function remoteImageResponse(
  source: unknown,
  place: RemoteImagePlace,
  fetch: typeof globalThis.fetch,
): Promise<Response> {
  const image = await imagePath(source, place)
  const kept = image && (await checkedOrKept(image, fetch))
  const file =
    image &&
    kept &&
    (await open(image.path, READ | (constants.O_NONBLOCK ?? 0)).catch(
      () => null,
    ))
  const stat = file && (await file.stat().catch(() => null))
  if (!kept || !file || !stat?.isFile()) {
    await file?.close()
    return new Response(null, { status: 404 })
  }
  return new Response(
    Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>,
    {
      headers: {
        'Content-Type': kept.type,
        'Content-Length': String(stat.size),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      },
    },
  )
}

/** Fetches a remote image again now, whatever its age; a failure keeps the copy. */
export async function refreshRemoteImage(
  source: unknown,
  place: RemoteImagePlace,
  fetch: typeof globalThis.fetch,
) {
  const image = await imagePath(source, place)
  if (image) await check(image, true, fetch)
}
