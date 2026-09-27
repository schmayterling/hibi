import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, open, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { MAX_DOCUMENT_BYTES } from '../shared/desktop'
import { exceedsUtf8Limit } from '../shared/text-size'

// ponytail: cap documents at 2 MiB; move parsing off-thread before raising this.

export function validateMarkdown(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    exceedsUtf8Limit(value, MAX_DOCUMENT_BYTES)
  ) {
    throw new Error('Use a UTF-8 text document no larger than 2 MiB.')
  }
}

export async function readMarkdown(path: string): Promise<string> {
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const info = await file.stat()
    if (!info.isFile())
      throw new Error('Choose a text file, not a folder or device.')
    if (info.size > MAX_DOCUMENT_BYTES)
      throw new Error(
        'This document exceeds the 2 MiB limit. Open a smaller file.',
      )
    const bytes = Buffer.alloc(info.size + 1)
    let bytesRead = 0
    while (bytesRead < bytes.length) {
      const chunk = await file.read(
        bytes,
        bytesRead,
        bytes.length - bytesRead,
        bytesRead,
      )
      if (!chunk.bytesRead) break
      bytesRead += chunk.bytesRead
    }
    if (bytesRead !== info.size)
      throw new Error('The file changed while opening. Try again.')
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, bytesRead),
    )
  } finally {
    await file.close()
  }
}

export async function writeMarkdown(
  path: string,
  markdown: string,
  exclusive = false,
  canCommit?: () => boolean,
): Promise<void> {
  validateMarkdown(markdown)
  return writeText(path, markdown, exclusive, canCommit)
}

export async function writeText(
  path: string,
  text: string | Uint8Array,
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
    if (canCommit && !canCommit())
      throw new Error('The save request is no longer current.')
    if (exclusive) {
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
    } else await rename(temp, path)
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}
