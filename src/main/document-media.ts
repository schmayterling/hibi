import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
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
    const stat = await file.stat()
    if (!stat.isFile() || !stat.size || !Number.isSafeInteger(stat.size))
      throw new Error('Choose a supported image or video file.')
    signal?.throwIfAborted()
    const header = Buffer.alloc(Math.min(4096, stat.size))
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    signal?.throwIfAborted()
    const mime =
      imageMime(header.subarray(0, bytesRead)) ??
      videoMime(header.subarray(0, bytesRead))
    if (!mime) throw new Error('Choose a supported image or video file.')
    return { file, stat, mime }
  } catch (error) {
    await file.close()
    throw error
  }
}

type Scope = { note: string | null; revision: number; workspace: string | null }
type Entry = {
  source: string
  scope: Scope
  token: string
  controller: AbortController
  dependencies: Set<string>
  clients: Set<string>
  result: Promise<DocumentMediaResolution | null>
  path?: string
  mime?: string
  settled: boolean
}

/** One serial header-resolution queue shared by all display callers. */
export class DocumentMediaServer {
  private entries = new Map<string, Entry>()
  private tokens = new Map<string, Entry>()
  private requests = new Map<string, Entry>()
  private tail: Promise<unknown> = Promise.resolve()
  private scope = ''
  private current: () => Scope
  constructor(current: () => Scope) {
    this.current = current
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => undefined)
    return result
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

  private paths(entry: Entry) {
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

  private retire(entry: Entry) {
    entry.controller.abort()
    if (this.entries.get(entry.source) === entry)
      this.entries.delete(entry.source)
    this.tokens.delete(entry.token)
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
        token: randomUUID(),
        controller: new AbortController(),
        dependencies: new Set(),
        clients: new Set(),
        result: Promise.resolve(null),
        settled: false,
      }
      const pending = entry
      this.entries.set(source, entry)
      entry.result = this.enqueue(async () => {
        try {
          if (!this.live(pending)) return null
          const path = await resolveDocumentMediaPath(
            source,
            scope.note,
            scope.workspace,
            {
              paths: pending.dependencies,
              signal: pending.controller.signal,
            },
          )
          if (!this.live(pending)) return null
          if (path) {
            pending.path = await realpath(path)
            pending.dependencies.add(pending.path)
            if (!this.live(pending)) return null
            const { file, mime } = await openMedia(
              pending.path,
              pending.controller.signal,
            )
            await file.close()
            if (!this.live(pending)) return null
            pending.mime = mime
            this.tokens.set(pending.token, pending)
          }
          return {
            media: pending.mime
              ? {
                  kind: pending.mime.startsWith('image/') ? 'image' : 'video',
                  url: `app://hibi/document-media/${pending.token}`,
                }
              : null,
            paths: this.paths(pending),
          }
        } catch {
          return this.live(pending)
            ? { media: null, paths: this.paths(pending) }
            : null
        } finally {
          pending.settled = true
        }
      })
    }
    entry.clients.add(request)
    this.requests.set(request, entry)
    const pending = entry
    return entry.result
      .then((result) =>
        this.requests.get(request) === pending && this.live(pending)
          ? result
          : null,
      )
      .finally(() => {
        pending.clients.delete(request)
        if (this.requests.get(request) === pending)
          this.requests.delete(request)
      })
  }

  cancel(request: string) {
    const entry = this.requests.get(request)
    if (!entry) return
    this.requests.delete(request)
    entry.clients.delete(request)
    if (!entry.clients.size && !entry.settled) this.retire(entry)
  }

  invalidate(change?: { kind: string; paths: readonly string[] | null }) {
    for (const entry of this.entries.values())
      if (
        mediaPathsChanged(
          entry.dependencies.size ? this.paths(entry) : null,
          change,
        )
      )
        this.retire(entry)
  }

  async serve(request: Request): Promise<Response> {
    const entry = this.tokens.get(
      new URL(request.url).pathname.slice('/document-media/'.length),
    )
    if (request.method !== 'GET') return new Response(null, { status: 405 })
    if (!entry || !this.live(entry) || request.signal.aborted)
      return new Response(null, { status: 404 })
    const signal = AbortSignal.any([request.signal, entry.controller.signal])
    // Revalidate fallback containment and symlinks before opening an issued URL.
    const opened = await this.enqueue(async () => {
      if (!this.live(entry) || signal.aborted) return null
      const path = await resolveDocumentMediaPath(
        entry.source,
        entry.scope.note,
        entry.scope.workspace,
        { signal },
      )
      if (
        !path ||
        !this.live(entry) ||
        signal.aborted ||
        (await realpath(path)) !== entry.path
      )
        return null
      return openMedia(entry.path, signal)
    }).catch(() => null)
    if (!opened) return new Response(null, { status: 404 })
    const { file, stat, mime } = opened
    if (!this.live(entry) || signal.aborted || mime !== entry.mime) {
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
