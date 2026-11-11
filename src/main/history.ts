import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { type DocumentVersion, HISTORY_PREVIEW_BYTES } from '../shared/history'
import type { SourceSnapshot } from '../shared/source-buffer'
import {
  readMarkdown,
  readMarkdownChunks,
  syncFolder,
  writeText,
} from './files'

type Version = DocumentVersion & { hash: string }
const AUTOSAVE_GAP = 3 * 60 * 1000
const hashes = new WeakMap<SourceSnapshot, { hash: string; bytes: number }>()
const directory = (path: string) =>
  join(
    app.getPath('userData'),
    'history',
    createHash('sha256').update(path).digest('hex'),
  )
const opened = new Map<string, Promise<void>>()
const rebuilding = new Map<string, Promise<Version[]>>()
/** The index's text, or null when there is none; other read errors reach the caller. */
async function readIndex(folder: string): Promise<string | null> {
  try {
    return await readFile(join(folder, 'index.json'), 'utf8')
  } catch (error) {
    // Other read errors may pass; they leave the index for the next try.
    const { code } = error as NodeJS.ErrnoException
    if (code === 'ENOENT') return null
    throw Object.assign(
      new Error('Hibi could not read the saved version history.', {
        cause: error,
      }),
      { code },
    )
  }
}
const readable = (v: unknown): v is Version =>
  !!v &&
  typeof v === 'object' &&
  validId((v as Version).id) &&
  typeof (v as Version).savedAt === 'number' &&
  typeof (v as Version).bytes === 'number' &&
  typeof (v as Version).hash === 'string'
/** Entries of an intact index, or null when it is damaged. */
function parse(text: string): Version[] | null {
  try {
    const data: unknown = JSON.parse(text)
    return Array.isArray(data) && data.every(readable) ? data : null
  } catch {
    return null
  }
}
async function versions(path: string): Promise<Version[]> {
  const folder = directory(path)
  let opening = opened.get(folder)
  if (!opening) {
    opening = open(folder)
    // Later callers wait too, so cleanup cannot race a new copy in this run.
    opened.set(folder, opening)
  }
  await opening
  const text = await readIndex(folder)
  if (text === null) return []
  return parse(text) ?? rebuild(folder, text)
}
/** Before this run writes anything, tidies what an earlier run left behind. */
async function open(folder: string) {
  const files = await readdir(folder).catch(() => [])
  await Promise.all(
    files
      .filter((file) =>
        /^\.(?:index\.json|[0-9a-f-]{36}\.md)\.[0-9a-f-]{36}\.tmp$/.test(file),
      )
      .map((file) => unlink(join(folder, file)).catch(() => {})),
  )
  // Copies an intact index does not list (an older or restored index, or a
  // crash before a pruned copy's unlink) are listed again as autosaves, so the
  // usual budget decides what goes. Nothing here deletes a copy.
  const text = await readIndex(folder).catch(() => null)
  const entries = text === null ? null : parse(text)
  if (!entries) return
  const listed = new Set(entries.map(({ id }) => id))
  // A copy that cannot be read now is tried again at the next launch.
  const adopted = (
    await inBatches(
      files.filter((name) => isCopy(name) && !listed.has(name.slice(0, -3))),
      (name) => copyVersion(folder, name).catch(() => null),
    )
  ).filter((version) => version !== null)
  if (!adopted.length) return
  const next = [...entries, ...adopted].sort((a, b) => a.savedAt - b.savedAt)
  try {
    await writeText(join(folder, 'index.json'), JSON.stringify(next))
    await syncFolder(folder)
  } catch {
    // The index stays as it was; the next launch tries again.
  }
}
/** Reads a few copies at once: many in a row are slow, all at once run out of files. */
async function inBatches<T, R>(items: T[], each: (item: T) => Promise<R>) {
  const results: R[] = []
  for (let at = 0; at < items.length; at += 32)
    results.push(...(await Promise.all(items.slice(at, at + 32).map(each))))
  return results
}
const isCopy = (file: string) =>
  file.endsWith('.md') && validId(file.slice(0, -3))
/** A copy's entry from its own bytes and time; null when it is not a file. */
async function copyVersion(
  folder: string,
  name: string,
  entry?: Version,
): Promise<Version | null> {
  const file = join(folder, name)
  const [body, info] = await Promise.all([readFile(file), stat(file)])
  if (!info.isFile()) return null
  return {
    id: name.slice(0, -3),
    hash: createHash('sha256').update(body).digest('hex'),
    savedAt: entry?.savedAt ?? Math.round(info.mtimeMs),
    bytes: body.byteLength,
    // Nobody knows which save kept a copy without an entry: it makes room first.
    ...(!entry || entry.automatic ? { automatic: true as const } : {}),
  }
}
/** One rebuild at a time per note, so a second cannot overwrite a save made after the first. */
function rebuild(folder: string, damaged: string): Promise<Version[]> {
  let running = rebuilding.get(folder)
  if (!running) {
    running = relist(folder, damaged).finally(() => rebuilding.delete(folder))
    rebuilding.set(folder, running)
  }
  return running
}
/**
 * Keeps damaged metadata aside and lists again every copy still on disk, so
 * none is left outside the index and its budget. Entries the damaged index
 * still reads keep their time and kind. If a copy cannot be read, nothing is
 * written: the damaged index stays for the next try rather than one that
 * leaves the copy out.
 */
async function relist(folder: string, damaged: string): Promise<Version[]> {
  const current = await readIndex(folder)
  // An earlier rebuild already replaced this index.
  if (current !== damaged) return current === null ? [] : (parse(current) ?? [])
  const index = join(folder, 'index.json')
  let known: Version[] = []
  try {
    const data: unknown = JSON.parse(damaged)
    if (Array.isArray(data)) known = data.filter(readable)
  } catch {
    // Text that does not parse names nothing: every copy is listed again.
  }
  const byId = new Map(known.map((version) => [version.id, version]))
  let found: Version[]
  try {
    found = (
      await inBatches((await readdir(folder)).filter(isCopy), (name) =>
        copyVersion(folder, name, byId.get(name.slice(0, -3))),
      )
    ).filter((version) => version !== null)
  } catch (error) {
    throw Object.assign(
      new Error('Hibi could not read the saved version history.', {
        cause: error,
      }),
      { code: (error as NodeJS.ErrnoException).code },
    )
  }
  found.sort((a, b) => a.savedAt - b.savedAt)
  await writeText(`${index}.corrupt-${Date.now()}-${randomUUID()}`, damaged)
  await writeText(index, JSON.stringify(found))
  await syncFolder(folder)
  return found
}
const validId = (id: unknown): id is string =>
  typeof id === 'string' &&
  id.length === 36 &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
/** Why a save stopped to keep the previous version: what failed, and what to do. */
export function historyProtectionError(error: unknown): Error {
  const { code } = error as NodeJS.ErrnoException
  const failure =
    code === 'ENOSPC' || code === 'EDQUOT'
      ? new Error(
          'Hibi could not keep the previous version in history. The storage for Hibi’s app data is full. Your file is unchanged and your edits are still here. Save manually to choose whether to save without this version.',
          { cause: error },
        )
      : code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
        ? new Error(
            'Hibi could not keep the previous version in history. Hibi does not have permission to use history in its app data folder, or that folder is read-only. Your file is unchanged and your edits are still here. Save manually to choose whether to save without this version.',
            { cause: error },
          )
        : new Error(
            'Hibi could not keep the previous version in history. Hibi could not read or write version history in its app data folder. Your file is unchanged and your edits are still here. Save manually to choose whether to save without this version.',
            { cause: error },
          )
  return Object.assign(failure, { code: 'EHISTORY' })
}
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
/** `previous` protects bytes already on disk without changing how their save was requested. */
export async function recordVersions(
  path: string,
  markdowns: (string | SourceSnapshot)[],
  automatic: boolean | 'previous' = false,
): Promise<void> {
  const current = await versions(path)
  const folder = directory(path)
  const next = [...current]
  let copyFailure: { error: unknown } | undefined
  let reflagged = false
  try {
    for (const markdown of markdowns) {
      const { hash, bytes } = await sourceHash(markdown)
      if (automatic === 'previous') {
        const existing = next.findLast((version) => version.hash === hash)
        if (existing) {
          const file = join(folder, `${existing.id}.md`)
          const stored = await stat(file).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error
              return null
            },
          )
          if (stored?.size !== bytes) {
            await writeText(
              file,
              typeof markdown === 'string'
                ? markdown
                : markdown.encodedChunks(),
            )
            await syncFolder(folder)
          }
          continue
        }
      }
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
        ...(automatic === true && markdown === markdowns.at(-1)
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
    await syncFolder(folder)
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
