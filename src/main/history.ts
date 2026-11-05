import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { type DocumentVersion, HISTORY_PREVIEW_BYTES } from '../shared/history'
import type { SourceSnapshot } from '../shared/source-buffer'
import { readMarkdown, readMarkdownChunks, writeText } from './files'

type Version = DocumentVersion & { hash: string }
const AUTOSAVE_GAP = 3 * 60 * 1000
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
/** The SHA-256 of a source's saved bytes, hashed between other work and kept per snapshot. */
export async function sourceHash(markdown: string | SourceSnapshot) {
  const cached = typeof markdown === 'string' ? undefined : hashes.get(markdown)
  if (cached) return cached
  const digest = createHash('sha256')
  let bytes = 0
  if (typeof markdown === 'string') {
    digest.update(markdown)
    bytes = Buffer.byteLength(markdown)
  } else {
    let started = performance.now(),
      scanned = 0
    for (const chunk of markdown.encodedChunks()) {
      digest.update(chunk)
      bytes += chunk.byteLength
      scanned += chunk.byteLength
      if (scanned >= 65536 || performance.now() - started >= 1) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        scanned = 0
        started = performance.now()
      }
    }
  }
  const hashed = { hash: digest.digest('hex'), bytes }
  if (typeof markdown !== 'string') hashes.set(markdown, hashed)
  return hashed
}
/** `automatic`: autosave wrote the last of `markdowns`. */
export async function recordVersions(
  path: string,
  markdowns: (string | SourceSnapshot)[],
  automatic = false,
): Promise<void> {
  const current = await versions(path)
  const folder = directory(path)
  const next = [...current]
  let copyFailure: { error: unknown } | undefined
  let reflagged = false
  try {
    for (const markdown of markdowns) {
      const { hash, bytes } = await sourceHash(markdown)
      const last = next.at(-1)
      if (last?.hash === hash) {
        // Asked for now, whoever wrote this text first.
        if (!automatic && last.automatic && markdown === markdowns.at(-1)) {
          const { automatic: _written, ...asked } = last
          next[next.length - 1] = asked
          reflagged = true
        }
        continue
      }
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
        ...(automatic && markdown === markdowns.at(-1)
          ? { automatic: true as const }
          : {}),
      })
    }
  } catch (error) {
    if (next.length === current.length) throw error
    copyFailure = { error }
  }
  if (next.length === current.length && !reflagged) return
  const added = next.slice(current.length)
  let bytes = next.reduce((sum, version) => sum + version.bytes, 0)
  const expired: Version[] = []
  while (next.length > 2 && (next.length > 100 || bytes > 20 * 1024 * 1024)) {
    // Autosaves come far more often: they make room before saves asked for,
    // first those it leaves no gap to miss, as the list shows them minutes
    // apart. The text a save asked for replaced goes last of all.
    const spare = next.slice(0, next.at(-1)?.automatic ? -1 : -2)
    const crowded = spare.findIndex(
      (version, index) =>
        version.automatic &&
        index > 0 &&
        next[index + 1]!.savedAt - next[index - 1]!.savedAt < AUTOSAVE_GAP,
    )
    const autosave =
      crowded >= 0 ? crowded : spare.findIndex((version) => version.automatic)
    const [version] = next.splice(Math.max(autosave, 0), 1)
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
