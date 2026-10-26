import { randomUUID } from 'node:crypto'
import { type BigIntStats, constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { sameFileIdentity } from '../shared/file-identity.ts'
import { fileTimeMilliseconds } from '../shared/file-time.ts'
import {
  type DocumentMediaResolution,
  mediaPathsChanged,
} from '../shared/media.ts'
import { imageMime, resolveDocumentMediaPath } from './images.ts'

function videoMime(bytes: Buffer) {
  if (
    bytes.toString('ascii', 4, 8) === 'ftyp' &&
    /^(isom|iso[2-9]|mp4[12]|avc1|M4V |qt {2}|dash)/.test(
      bytes.toString('ascii', 8, 12),
    )
  )
    return 'video/mp4'
  if (
    bytes.subarray(0, 4).toString('hex') === '1a45dfa3' &&
    bytes.includes(Buffer.from('webm'))
  )
    return 'video/webm'
  if (
    bytes.toString('ascii', 0, 4) === 'OggS' &&
    bytes.includes(Buffer.from('theora'))
  )
    return 'video/ogg'
  return null
}

/** Sniff a small header; display bytes are streamed, never buffered in full. */
export async function openMedia(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  )
  try {
    signal?.throwIfAborted()
    const stat = await file.stat({ bigint: true })
    const size = Number(stat.size)
    if (!stat.isFile() || !size || !Number.isSafeInteger(size))
      throw new Error('Choose a supported image or video file.')
    signal?.throwIfAborted()
    const header = Buffer.alloc(Math.min(4096, size))
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    signal?.throwIfAborted()
    const mime =
      imageMime(header.subarray(0, bytesRead)) ??
      videoMime(header.subarray(0, bytesRead))
    if (!mime) throw new Error('Choose a supported image or video file.')
    return {
      file,
      stat: {
        dev: stat.dev,
        ino: stat.ino,
        mtimeNs: stat.mtimeNs,
        mtimeMs: fileTimeMilliseconds(stat.mtimeNs),
        size,
      },
      mime,
    }
  } catch (error) {
    await file.close()
    throw error
  }
}

type Scope = { note: string | null; revision: number; workspace: string | null }
type Version = {
  path: string
  mime: string
  stat: Pick<BigIntStats, 'dev' | 'ino' | 'mtimeNs'> & { size: number }
  token: string
  controller: AbortController
}
type Entry = {
  source: string
  scope: Scope
  controller: AbortController
  dependencies: Set<string>
  clients: Set<string>
  result: Promise<DocumentMediaResolution | null> | null
  running?: Promise<DocumentMediaResolution | null>
  resolution?: AbortController
  version?: Version
}

function sameFile(
  left: Pick<Version, 'path' | 'mime' | 'stat'>,
  right: Pick<Version, 'path' | 'mime' | 'stat'>,
) {
  return (
    left.path === right.path &&
    left.mime === right.mime &&
    sameFileIdentity(left.stat, right.stat) &&
    left.stat.size === right.stat.size &&
    left.stat.mtimeNs === right.stat.mtimeNs
  )
}

/** Share and admit resolution work; already-issued streams never wait behind it. */
export class DocumentMediaServer {
  private entries = new Map<string, Entry>()
  private tokens = new Map<string, { entry: Entry; version: Version }>()
  private requests = new Map<string, Entry>()
  private waiting = new Set<() => void>()
  private active = 0
  private slow = 0
  private scope = ''
  private current: () => Scope
  constructor(current: () => Scope) {
    this.current = current
  }

  private drain() {
    for (const start of this.waiting) {
      // Slow files can borrow one slot while leaving a libuv thread free for saves.
      if (this.active >= (this.slow ? 3 : 2)) break
      this.waiting.delete(start)
      start()
    }
  }

  private enqueue<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
    previous?: Promise<unknown>,
  ): Promise<T | null> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (result: T | null) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        this.waiting.delete(start)
        resolve(result)
      }
      const abort = () => finish(null)
      const start = () => {
        if (settled) return
        this.active++
        let slow = false
        const timer = setTimeout(() => {
          slow = true
          this.slow++
          this.drain()
        }, 1000)
        timer.unref()
        void operation()
          .then(finish, () => finish(null))
          .finally(() => {
            // Aborting the caller cannot interrupt a running filesystem call.
            clearTimeout(timer)
            if (slow) this.slow--
            this.active--
            this.drain()
          })
      }
      const admit = () => {
        if (settled) return
        this.waiting.add(start)
        queueMicrotask(() => this.drain())
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else if (previous) void previous.then(admit, admit)
      else admit()
    })
  }

  private live(entry: Entry) {
    const current = this.current()
    return (
      !entry.controller.signal.aborted &&
      entry.scope.note === current.note &&
      entry.scope.revision === current.revision &&
      entry.scope.workspace === current.workspace
    )
  }

  private paths(entry: Entry): string[] | null {
    if (!entry.dependencies.size) return null
    const root = entry.scope.workspace
    return root
      ? [...entry.dependencies].flatMap((path) => {
          const value = relative(root, path).split(sep).join('/')
          return value &&
            value !== '..' &&
            !value.startsWith('../') &&
            !isAbsolute(value)
            ? [value]
            : []
        })
      : []
  }

  private revoke(entry: Entry) {
    if (!entry.version) return
    entry.version.controller.abort()
    this.tokens.delete(entry.version.token)
    delete entry.version
  }

  private retire(entry: Entry) {
    entry.controller.abort()
    this.revoke(entry)
    for (const client of entry.clients)
      if (this.requests.get(client) === entry) this.requests.delete(client)
    entry.clients.clear()
    if (this.entries.get(entry.source) === entry)
      this.entries.delete(entry.source)
  }

  private async load(entry: Entry, signal: AbortSignal, paths?: Set<string>) {
    signal.throwIfAborted()
    if (!this.live(entry)) return null
    const source = await resolveDocumentMediaPath(
      entry.source,
      entry.scope.note,
      entry.scope.workspace,
      paths ? { paths, signal } : { signal },
    )
    if (!source || !this.live(entry) || signal.aborted) return null
    const path = await realpath(source)
    paths?.add(path)
    signal.throwIfAborted()
    const expected = await stat(path, { bigint: true })
    signal.throwIfAborted()
    const opened = await openMedia(path, signal)
    try {
      // Bind validation to the opened inode, including a symlink replaced during open.
      if (
        !sameFileIdentity(opened.stat, expected) ||
        (await realpath(source)) !== path ||
        !this.live(entry) ||
        signal.aborted
      ) {
        await opened.file.close()
        return null
      }
      return { ...opened, path }
    } catch (error) {
      await opened.file.close()
      throw error
    }
  }

  private async inspect(
    entry: Entry,
    signal: AbortSignal,
  ): Promise<DocumentMediaResolution | null> {
    const dependencies = new Set<string>()
    const opened = await this.load(entry, signal, dependencies).catch(
      () => null,
    )
    try {
      if (!this.live(entry) || signal.aborted) return null
      entry.dependencies = dependencies
      if (!opened) this.revoke(entry)
      else if (!entry.version || !sameFile(entry.version, opened)) {
        this.revoke(entry)
        entry.version = {
          path: opened.path,
          mime: opened.mime,
          stat: opened.stat,
          token: randomUUID(),
          controller: new AbortController(),
        }
        this.tokens.set(entry.version.token, { entry, version: entry.version })
      }
      return {
        media: entry.version
          ? {
              kind: entry.version.mime.startsWith('image/') ? 'image' : 'video',
              url: `app://hibi/document-media/${entry.version.token}`,
            }
          : null,
        paths: this.paths(entry),
      }
    } finally {
      await opened?.file.close()
    }
  }

  resolve(
    source: string,
    revision: number,
    request: string,
  ): Promise<DocumentMediaResolution | null> {
    const scope = { ...this.current() }
    if (revision !== scope.revision || !source || source.length > 8192)
      return Promise.resolve(null)
    const key = JSON.stringify(scope)
    if (key !== this.scope) {
      for (const entry of this.entries.values()) this.retire(entry)
      this.scope = key
    }
    let entry = this.entries.get(source)
    if (!entry) {
      entry = {
        source,
        scope,
        controller: new AbortController(),
        dependencies: new Set(),
        clients: new Set(),
        result: null,
      }
      this.entries.set(source, entry)
    }
    entry.clients.add(request)
    this.requests.set(request, entry)
    if (!entry.result) {
      const controller = new AbortController()
      entry.resolution = controller
      const pending = entry
      const signal = AbortSignal.any([
        entry.controller.signal,
        controller.signal,
      ])
      entry.result = this.enqueue(
        () => {
          const running = this.inspect(pending, signal).finally(() => {
            delete pending.running
          })
          pending.running = running
          return running
        },
        signal,
        pending.running,
      ).finally(() => {
        if (pending.resolution === controller) delete pending.resolution
      })
    }
    const pending = entry
    return entry.result.then((result) =>
      this.requests.get(request) === pending && this.live(pending)
        ? result
        : null,
    )
  }

  cancel(request: string) {
    const entry = this.requests.get(request)
    if (!entry) return
    this.requests.delete(request)
    entry.clients.delete(request)
    if (!entry.clients.size) this.retire(entry)
  }

  invalidate(change?: { kind: string; paths: readonly string[] | null }) {
    for (const entry of this.entries.values()) {
      if (!this.live(entry)) this.retire(entry)
      else if (mediaPathsChanged(this.paths(entry), change)) {
        entry.resolution?.abort()
        entry.result = null
      }
    }
  }

  async serve(request: Request): Promise<Response> {
    const issued = this.tokens.get(
      new URL(request.url).pathname.slice('/document-media/'.length),
    )
    if (request.method !== 'GET') return new Response(null, { status: 405 })
    if (!issued || !this.live(issued.entry) || request.signal.aborted)
      return new Response(null, { status: 404 })
    const { entry, version } = issued
    const signal = AbortSignal.any([
      request.signal,
      entry.controller.signal,
      version.controller.signal,
    ])
    const opened = await this.load(entry, signal).catch(() => null)
    if (!opened) return new Response(null, { status: 404 })
    const { file, stat, mime } = opened
    if (!this.live(entry) || signal.aborted || !sameFile(version, opened)) {
      await file.close()
      return new Response(null, { status: 404 })
    }
    let start = 0,
      end = stat.size - 1
    const range = request.headers.get('range')
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (match && (match[1] || match[2])) {
        start = match[1]
          ? Number(match[1])
          : Math.max(0, stat.size - Number(match[2]))
        end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end
      }
      if (
        !match ||
        !(match[1] || match[2]) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= stat.size
      ) {
        await file.close()
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${stat.size}` },
        })
      }
    }
    const headers = new Headers({
      'Content-Type': mime,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    })
    if (range)
      headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`)
    return new Response(
      Readable.toWeb(file.createReadStream({ start, end, signal }), {
        strategy: {
          highWaterMark: 64 * 1024,
          size: (chunk: Uint8Array) => chunk.byteLength,
        },
      }) as ReadableStream<Uint8Array>,
      { status: range ? 206 : 200, headers },
    )
  }
}
