import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, open, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { SourceSnapshot } from '../shared/source-buffer'
import { retryRename } from './atomic-rename.ts'

const fileAccess = new Map<string, Promise<void>>()

async function lockFileAccess(path: string) {
  const key = resolve(path)
  const previous = fileAccess.get(key)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  fileAccess.set(key, pending)
  await previous
  return () => {
    if (fileAccess.get(key) === pending) fileAccess.delete(key)
    release()
  }
}

export function validateMarkdown(value: unknown): asserts value is string {
  if (typeof value !== 'string')
    throw new Error('Choose a UTF-8 text document.')
}

export async function* readMarkdownChunks(
  path: string,
  maximumBytes = Infinity,
): AsyncGenerator<string> {
  const release = await lockFileAccess(path)
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  ).catch((error) => {
    release()
    throw error
  })
  try {
    const info = await file.stat()
    if (!info.isFile())
      throw new Error('Choose a text file, not a folder or device.')
    if (info.size > maximumBytes)
      throw new Error('This text is too large to read in one request.')
    const bytes = Buffer.allocUnsafe(65536),
      decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    let offset = 0
    while (offset < info.size) {
      const chunk = await file.read(
        bytes,
        0,
        Math.min(bytes.length, info.size - offset),
        offset,
      )
      if (!chunk.bytesRead)
        throw new Error('The file changed while opening. Try again.')
      offset += chunk.bytesRead
      const text = decoder.decode(bytes.subarray(0, chunk.bytesRead), {
        stream: true,
      })
      for (let from = 0; from < text.length; from += 65536)
        yield text.slice(from, from + 65536)
    }
    const extra = await file.read(bytes, 0, 1, offset),
      after = await file.stat()
    if (
      extra.bytesRead ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      throw new Error('The file changed while opening. Try again.')
    const tail = decoder.decode()
    if (tail) yield tail
  } finally {
    try {
      await file.close()
    } finally {
      release()
    }
  }
}

/** Compare an owned source directly with a stable UTF-8 read, without rebuilding a store. */
export async function matchesMarkdown(
  path: string,
  source: SourceSnapshot,
): Promise<boolean> {
  const reader = readMarkdownChunks(path)[Symbol.asyncIterator]()
  let text = '',
    offset = 0
  try {
    for (const expected of source.chunks()) {
      for (let from = 0; from < expected.length; ) {
        if (offset === text.length) {
          const next = await reader.next()
          if (next.done) return false
          text = next.value
          offset = 0
        }
        const size = Math.min(expected.length - from, text.length - offset)
        if (!text.startsWith(expected.slice(from, from + size), offset))
          return false
        from += size
        offset += size
      }
    }
    return offset === text.length && (await reader.next()).done === true
  } finally {
    await reader.return(undefined)
  }
}

export async function readMarkdown(
  path: string,
  maximumBytes: number,
): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of readMarkdownChunks(path, maximumBytes))
    chunks.push(chunk)
  return chunks.join('')
}

export async function writeMarkdown(
  path: string,
  markdown: string | SourceSnapshot,
  exclusive = false,
  canCommit?: () => boolean,
): Promise<void> {
  if (typeof markdown === 'string') validateMarkdown(markdown)
  return writeText(
    path,
    typeof markdown === 'string' ? markdown : markdown.encodedChunks(),
    exclusive,
    canCommit,
  )
}

async function* writeChunks(
  source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
) {
  let buffer = Buffer.allocUnsafe(1024 * 1024),
    used = 0
  for await (const part of source) {
    for (let from = 0; from < part.byteLength; ) {
      const size = Math.min(part.byteLength - from, buffer.length - used)
      buffer.set(part.subarray(from, from + size), used)
      used += size
      from += size
      if (used === buffer.length) {
        yield buffer
        buffer = Buffer.allocUnsafe(1024 * 1024)
        used = 0
      }
    }
  }
  if (used) yield buffer.subarray(0, used)
}

export async function writeText(
  path: string,
  text: string | Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  exclusive = false,
  canCommit?: () => boolean,
): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const existing = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  let release: (() => void) | undefined
  try {
    const file = await open(temp, 'wx', existing?.mode ?? 0o600)
    try {
      await file.writeFile(
        typeof text === 'string' || text instanceof Uint8Array
          ? text
          : writeChunks(text),
        'utf8',
      )
      await file.sync()
    } finally {
      await file.close()
    }
    // Fill the temporary file first; commit only after owned readers close.
    release = await lockFileAccess(path)
    const checkCommit = () => {
      if (canCommit && !canCommit())
        throw new Error('The save request is no longer current.')
    }
    if (exclusive) {
      checkCommit()
      try {
        await link(temp, path)
      } catch (error) {
        if (
          !['ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error
        await copyFile(temp, path, constants.COPYFILE_EXCL)
      }
    } else
      await retryRename(() => {
        checkCommit()
        return rename(temp, path)
      })
  } finally {
    try {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    } finally {
      release?.()
    }
  }
}
