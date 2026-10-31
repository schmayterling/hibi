import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import { join, relative } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import type { SourceSnapshot } from '../shared/source-buffer'
import {
  parseUndoHistory,
  UNDO_HISTORY_CHANNELS,
  type UndoHistory,
} from '../shared/undo-history'
import { writeText } from './files'
import { sourceHash } from './history'
import { isPathInside } from './workspace-paths'

// Undo history holds deleted text, so it stays in app data, never beside notes.
const folder = () => join(app.getPath('userData'), 'undo-history')
const settingsPath = () =>
  join(app.getPath('userData'), 'undo-history-settings.json')
const fileName = (path: string) =>
  `${createHash('sha256').update(path).digest('hex')}.json`
/** An editor keeps at most 8 MiB of steps per note, so a larger file is not one it wrote. */
const FILE_BYTES = 32 * 1024 * 1024
/** Notes saved longest ago lose their kept history first past this. */
const TOTAL_BYTES = 64 * 1024 * 1024

let keeping: Promise<boolean> | undefined
/** Whether notes keep their undo history after closing; on unless turned off. */
export const keepsUndoHistory = () =>
  (keeping ??= readFile(settingsPath(), 'utf8').then(
    (text) => {
      try {
        return (JSON.parse(text) as { keep?: unknown }).keep !== false
      } catch {
        // An unreadable setting keeps nothing until it is set again.
        return false
      }
    },
    () => true,
  ))

// Writes and removals run one at a time, in order.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(task: () => Promise<T>): Promise<T> => {
  const next = queue.catch(() => {}).then(task)
  queue = next
  return next
}
const writing = new Set<Promise<unknown>>()

/** Kept files by name, measured once, then followed as they change. */
let sizes: Map<string, { bytes: number; time: number }> | undefined
async function measure() {
  if (sizes) return sizes
  const measured = new Map<string, { bytes: number; time: number }>()
  for (const name of await readdir(folder()).catch(() => [])) {
    // A write a crash cut short leaves its temporary copy, with deleted text.
    // Nothing is writing while this runs in the queue.
    if (name.endsWith('.tmp')) {
      await unlink(join(folder(), name)).catch(() => {})
      continue
    }
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue
    const info = await stat(join(folder(), name)).catch(() => null)
    if (info?.isFile())
      measured.set(name, { bytes: info.size, time: info.mtimeMs })
  }
  sizes = measured
  return measured
}
/** The note each kept history belongs to, by file name, so moves inside Hibi can follow it. */
let notes: Map<string, string> | undefined
async function remove(name: string) {
  await unlink(join(folder(), name)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  sizes?.delete(name)
  notes?.delete(name)
}
const indexPath = () => join(app.getPath('userData'), 'undo-history-notes.json')
async function indexed() {
  if (notes) return notes
  const listed = await readFile(indexPath(), 'utf8')
    .then((text): unknown => JSON.parse(text))
    .catch(() => null)
  notes = new Map(
    (Array.isArray(listed) ? listed : [])
      .filter((path): path is string => typeof path === 'string')
      .map((path) => [fileName(path), path]),
  )
  return notes
}
const writeIndex = () =>
  writeText(indexPath(), JSON.stringify([...(notes?.values() ?? [])]))

/**
 * Keeps a note's undo history, anchored at the text last saved to its file.
 * An editor's history for an older save, or for a tab whose text was
 * replaced, is skipped.
 */
export async function storeUndoHistory(
  path: string,
  saved: SourceSnapshot,
  value: unknown,
) {
  const history = parseUndoHistory(value)
  if (history.version !== saved.version || history.units !== saved.utf16Length)
    return
  const task = serial(async () => {
    if (!(await keepsUndoHistory())) return
    const { hash, bytes } = await sourceHash(saved)
    const text = JSON.stringify({ format: 1, hash, bytes, history })
    const name = fileName(path)
    if (Buffer.byteLength(text) > FILE_BYTES) {
      await remove(name)
      return
    }
    const files = await measure()
    await mkdir(folder(), { recursive: true, mode: 0o700 })
    await writeText(join(folder(), name), text)
    files.set(name, { bytes: Buffer.byteLength(text), time: Date.now() })
    const known = await indexed()
    if (known.get(name) !== path) {
      known.set(name, path)
      await writeIndex()
    }
    let total = 0
    for (const file of files.values()) total += file.bytes
    for (const [other, file] of [...files].sort(
      ([, a], [, b]) => a.time - b.time,
    )) {
      if (total <= TOTAL_BYTES) break
      if (other === name) continue
      await remove(other)
      total -= file.bytes
    }
  })
  writing.add(task)
  void task.catch(() => {}).finally(() => writing.delete(task))
  return task
}

/**
 * A note's kept undo history if its file still holds the text it was kept
 * at. One changed outside Hibi, or unreadable, is removed without asking.
 */
export async function readUndoHistory(
  path: string,
  saved: SourceSnapshot,
): Promise<UndoHistory | null> {
  // A note moved just now has its history under its new name first.
  await queue.catch(() => {})
  if (!(await keepsUndoHistory())) return null
  const name = fileName(path)
  let text: string
  try {
    if ((await stat(join(folder(), name))).size > FILE_BYTES)
      throw new RangeError()
    text = await readFile(join(folder(), name), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    text = ''
  }
  try {
    const kept = JSON.parse(text) as Record<string, unknown>
    const history = parseUndoHistory(kept.history)
    if (
      kept.format === 1 &&
      history.units === saved.utf16Length &&
      kept.bytes === saved.utf8Bytes &&
      kept.hash === (await sourceHash(saved)).hash
    )
      return history
  } catch {
    // Unreadable history starts over.
  }
  await serial(() => remove(name))
  return null
}

/**
 * Kept histories follow notes renamed or moved inside Hibi: the note at
 * `from`, or every note under `from` when a folder moved. Moves apply in the
 * order they were made, from the notes' paths alone, so a later move or an
 * unreadable folder can't strand a history under an old name.
 */
export function relocateUndoHistory(from: string, to: string) {
  return serial(async () => {
    const files = await measure()
    if (!files.size) return
    const known = await indexed()
    let changed = false
    for (const [before, path] of [...known]) {
      if (!isPathInside(from, path)) continue
      const moved = join(to, relative(from, path))
      known.delete(before)
      changed = true
      const file = files.get(before)
      if (!file) continue
      const after = fileName(moved)
      await rename(join(folder(), before), join(folder(), after))
      files.delete(before)
      files.set(after, file)
      known.set(after, moved)
    }
    if (changed) await writeIndex()
  })
}

export async function setKeepUndoHistory(keep: unknown) {
  if (typeof keep !== 'boolean')
    throw new Error('Invalid undo history setting.')
  await serial(() => writeText(settingsPath(), JSON.stringify({ keep })))
  keeping = Promise.resolve(keep)
  if (!keep) await clearUndoHistory()
}

/** Removes every note's kept undo history. */
export function clearUndoHistory() {
  return serial(async () => {
    await rm(folder(), { recursive: true, force: true })
    await rm(indexPath(), { force: true })
    sizes = new Map()
    notes = new Map()
  })
}

const flushes = new Map<string, () => void>()
export function acceptUndoHistoryFlushed(token: unknown) {
  if (typeof token === 'string') flushes.get(token)?.()
}
/**
 * Asks the editor for the undo histories of saves it has not sent yet, as
 * a save prompt's, and waits until they are written. An editor that does not
 * answer in 5 seconds keeps them.
 */
export async function flushUndoHistory(window: BrowserWindow) {
  if (window.isDestroyed()) return
  const token = randomUUID()
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      flushes.delete(token)
      resolve()
    }
    const timer = setTimeout(done, 5000)
    flushes.set(token, done)
    window.webContents.send(UNDO_HISTORY_CHANNELS.flush, token)
  })
  await Promise.allSettled(writing)
}
