import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, open, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SourceSnapshot } from '../shared/source-buffer'
import { retryRename } from './atomic-rename'

export function validateMarkdown(value: unknown): asserts value is string {
  if (typeof value !== 'string')
    throw new Error('Choose a UTF-8 text document.')
}

export async function* readMarkdownChunks(
  path: string,
): AsyncGenerator<string> {
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const info = await file.stat()
    if (!info.isFile())
      throw new Error('Choose a text file, not a folder or device.')
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
    await file.close()
  }
}

export async function readMarkdown(path: string): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of readMarkdownChunks(path)) chunks.push(chunk)
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
  try {
    const file = await open(temp, 'wx', existing?.mode ?? 0o600)
    try {
      await file.writeFile(text, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
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
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}
