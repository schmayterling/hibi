import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { type DocumentVersion, HISTORY_PREVIEW_BYTES } from '../shared/history'
import type { SourceSnapshot } from '../shared/source-buffer'
import { readMarkdown, readMarkdownChunks, writeText } from './files'

type Version = DocumentVersion & { hash: string }
const hashes = new WeakMap<SourceSnapshot, { hash: string; bytes: number }>()
const directory = (path: string) =>
  join(
    app.getPath('userData'),
    'history',
    createHash('sha256').update(path).digest('hex'),
  )
async function versions(path: string): Promise<Version[]> {
  try {
    const data: unknown = JSON.parse(
      await readFile(join(directory(path), 'index.json'), 'utf8'),
    )
    if (
      !Array.isArray(data) ||
      data.some(
        (v) =>
          !v ||
          !validId(v.id) ||
          typeof v.savedAt !== 'number' ||
          typeof v.bytes !== 'number' ||
          typeof v.hash !== 'string',
      )
    )
      throw new Error('Hibi could not read the saved version history.')
    return data as Version[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
const validId = (id: unknown): id is string =>
  typeof id === 'string' &&
  id.length === 36 &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
export async function listVersions(
  path: string | null,
): Promise<DocumentVersion[]> {
  return path
    ? (await versions(path))
        .map(({ hash: _hash, ...version }) => version)
        .reverse()
    : []
}
async function versionPath(path: string | null, id: unknown): Promise<string> {
  if (
    !path ||
    !validId(id) ||
    !(await versions(path)).some((version) => version.id === id)
  )
    throw new Error('This saved version is no longer available.')
  return join(directory(path), `${id}.md`)
}
export async function previewVersion(
  path: string | null,
  id: unknown,
): Promise<string> {
  const file = await versionPath(path, id)
  if ((await stat(file)).size > HISTORY_PREVIEW_BYTES)
    throw new Error(
      'This saved version is too large to preview. You can still restore it to the editor.',
    )
  return readMarkdown(file, HISTORY_PREVIEW_BYTES)
}
export async function* readVersionChunks(
  path: string | null,
  id: unknown,
): AsyncGenerator<string> {
  yield* readMarkdownChunks(await versionPath(path, id))
}
export async function recordVersions(
  path: string,
  markdowns: (string | SourceSnapshot)[],
): Promise<void> {
  const current = await versions(path)
  const folder = directory(path)
  const next = [...current]
  let copyFailure: { error: unknown } | undefined
  try {
    for (const markdown of markdowns) {
      const cached =
        typeof markdown === 'string' ? undefined : hashes.get(markdown)
      const digest = cached ? null : createHash('sha256')
      let bytes = cached?.bytes ?? 0
      if (typeof markdown === 'string') {
        digest!.update(markdown)
        bytes = Buffer.byteLength(markdown)
      } else if (!cached) {
        let started = performance.now(),
          scanned = 0
        for (const chunk of markdown.encodedChunks()) {
          digest!.update(chunk)
          bytes += chunk.byteLength
          scanned += chunk.byteLength
          if (scanned >= 65536 || performance.now() - started >= 1) {
            await new Promise<void>((resolve) => setImmediate(resolve))
            scanned = 0
            started = performance.now()
          }
        }
      }
      const hash = cached?.hash ?? digest!.digest('hex')
      if (typeof markdown !== 'string' && !cached)
        hashes.set(markdown, { hash, bytes })
      if (next.at(-1)?.hash === hash) continue
      if (next.length === current.length)
        await mkdir(folder, { recursive: true, mode: 0o700 })
      const id = randomUUID()
      await writeText(
        join(folder, `${id}.md`),
        typeof markdown === 'string' ? markdown : markdown.encodedChunks(),
      )
      next.push({
        id,
        hash,
        savedAt: Date.now(),
        bytes,
      })
    }
  } catch (error) {
    if (next.length === current.length) throw error
    copyFailure = { error }
  }
  if (next.length === current.length) return
  const added = next.slice(current.length)
  let bytes = next.reduce((sum, version) => sum + version.bytes, 0)
  const expired: Version[] = []
  while (next.length > 2 && (next.length > 100 || bytes > 20 * 1024 * 1024)) {
    const version = next.shift()
    if (version) {
      expired.push(version)
      bytes -= version.bytes
    }
  }
  try {
    await writeText(join(folder, 'index.json'), JSON.stringify(next))
  } catch (error) {
    const published = await versions(path).catch(() => null)
    if (published) {
      const indexed = new Set(published.map(({ id }) => id))
      await Promise.all(
        added
          .filter(({ id }) => !indexed.has(id))
          .map(({ id }) => unlink(join(folder, `${id}.md`)).catch(() => {})),
      )
    }
    throw error
  }
  await Promise.all(
    expired.map((version) =>
      unlink(join(folder, `${version.id}.md`)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        },
      ),
    ),
  )
  if (copyFailure) throw copyFailure.error
}
