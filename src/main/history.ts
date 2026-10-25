import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { DocumentVersion } from '../shared/history'
import { readMarkdown, writeText } from './files'

type Version = DocumentVersion & { hash: string }
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
  typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
export async function listVersions(
  path: string | null,
): Promise<DocumentVersion[]> {
  return path
    ? (await versions(path))
        .map(({ hash: _hash, ...version }) => version)
        .reverse()
    : []
}
export async function previewVersion(
  path: string | null,
  id: unknown,
): Promise<string> {
  if (
    !path ||
    !validId(id) ||
    !(await versions(path)).some((version) => version.id === id)
  )
    throw new Error('This saved version is no longer available.')
  return readMarkdown(join(directory(path), `${id}.md`))
}
export async function recordVersions(
  path: string,
  markdowns: string[],
): Promise<void> {
  const current = await versions(path)
  const folder = directory(path)
  const next = [...current]
  let copyFailure: { error: unknown } | undefined
  try {
    for (const markdown of markdowns) {
      const hash = createHash('sha256').update(markdown).digest('hex')
      if (next.at(-1)?.hash === hash) continue
      if (next.length === current.length)
        await mkdir(folder, { recursive: true, mode: 0o700 })
      const id = randomUUID()
      await writeText(join(folder, `${id}.md`), markdown)
      next.push({
        id,
        hash,
        savedAt: Date.now(),
        bytes: Buffer.byteLength(markdown),
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
  while (next.length > 1 && (next.length > 100 || bytes > 20 * 1024 * 1024)) {
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
