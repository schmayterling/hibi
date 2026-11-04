import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  opendir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
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
/** A note missing this long lets go of its kept history. */
const MISSING_MS = 30 * 24 * 60 * 60 * 1000
/** No Hibi wrote an earlier time: it is a corrupt value or a clock that reset. */
const EARLIEST_MISSING = Date.UTC(2026, 0, 1)

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
/** A quit waits for queued writes, moves and removals. */
const tracked = <T>(task: Promise<T>) => {
  writing.add(task)
  void task.catch(() => {}).finally(() => writing.delete(task))
  return task
}

let swept: Promise<void> | undefined
/**
 * A write a crash cut short leaves its temporary copy, with deleted text: the
 * first read, write, move or removal of a launch removes them, in the queue,
 * while nothing is writing.
 */
const sweep = () =>
  (swept ??= (async () => {
    for (const name of await readdir(folder()).catch(() => []))
      if (name.endsWith('.tmp'))
        await unlink(join(folder(), name)).catch(() => {})
  })())

/** Kept files by name, measured once, then followed as they change. */
type Kept = { bytes: number; time: number; digest?: string }
let sizes: Map<string, Kept> | undefined
async function measure() {
  if (sizes) return sizes
  await sweep()
  const measured = new Map<string, Kept>()
  for (const name of await readdir(folder()).catch(() => [])) {
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
/** When a look first found a note missing, by file name; read for indexed notes. */
const missingSince = new Map<string, number>()
/** Removes a kept history; returns whether the index named it. */
async function remove(name: string) {
  await unlink(join(folder(), name)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  sizes?.delete(name)
  // Loaded here too: a launch's first read can find a stale history.
  return (await indexed()).delete(name)
}
const indexPath = () => join(app.getPath('userData'), 'undo-history-notes.json')
/** A crash mid-write leaves the index's temporary copy beside it. */
async function removeIndexCopies() {
  for (const name of await readdir(app.getPath('userData')).catch(() => []))
    if (name.startsWith('.undo-history-notes.json.') && name.endsWith('.tmp'))
      await unlink(join(app.getPath('userData'), name)).catch(() => {})
}
async function indexed() {
  if (notes) return notes
  await removeIndexCopies()
  const listed = await readFile(indexPath(), 'utf8')
    .then((text): unknown => JSON.parse(text))
    .catch(() => null)
  const found = new Map<string, string>()
  // An entry is a note's path, or that and when it was first found missing.
  for (const entry of Array.isArray(listed) ? listed : []) {
    const { path, missingSince: since } = (
      typeof entry === 'string' ? { path: entry } : (entry ?? {})
    ) as { path?: unknown; missingSince?: unknown }
    if (typeof path !== 'string') continue
    found.set(fileName(path), path)
    // Any other time starts the note's wait over, so it can't shorten it.
    if (
      typeof since === 'number' &&
      Number.isFinite(since) &&
      since >= EARLIEST_MISSING
    )
      missingSince.set(fileName(path), since)
  }
  notes = found
  return notes
}
const writeIndex = () =>
  writeText(
    indexPath(),
    JSON.stringify(
      [...(notes ?? [])].map(([name, path]) => {
        const since = missingSince.get(name)
        return since === undefined ? path : { path, missingSince: since }
      }),
    ),
  )

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
      if (await remove(name)) await writeIndex()
      return
    }
    const files = await measure()
    const digest = createHash('sha256').update(text).digest('base64')
    // A save that changed no kept step leaves the file as it is.
    if (files.get(name)?.digest !== digest) {
      await mkdir(folder(), { recursive: true, mode: 0o700 })
      await writeText(join(folder(), name), text)
    }
    files.set(name, {
      bytes: Buffer.byteLength(text),
      time: Date.now(),
      digest,
    })
    const known = await indexed()
    // A note saved is a note seen.
    if (missingSince.delete(name) || known.get(name) !== path) {
      known.set(name, path)
      await writeIndex()
    }
    let total = 0,
      evicted = false
    for (const file of files.values()) total += file.bytes
    for (const [other, file] of [...files].sort(
      ([, a], [, b]) => a.time - b.time,
    )) {
      if (total <= TOTAL_BYTES) break
      if (other === name) continue
      // An evicted history leaves the index too.
      if (await remove(other)) evicted = true
      total -= file.bytes
    }
    if (evicted) await writeIndex()
  })
  return tracked(task)
}

/**
 * A note's kept undo history if its file still holds the text it was kept
 * at. One changed outside Hibi, or unreadable, is removed without asking.
 */
export function readUndoHistory(
  path: string,
  saved: SourceSnapshot,
): Promise<UndoHistory | null> {
  // In the queue: a note moved just now has its history under its new name
  // first, and no store lands between finding a stale file and removing it.
  return serial(async () => {
    if (!(await keepsUndoHistory())) return null
    await sweep()
    const name = fileName(path)
    // A note opened is a note seen, and a failed write doesn't stop the read.
    // Loaded here too: the note can be gone again by a launch's first look.
    await indexed()
    if (missingSince.delete(name)) await writeIndex().catch(() => {})
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
    if (await remove(name)) await writeIndex()
    return null
  })
}

/**
 * Kept histories of notes missing for 30 days go, as a note on another Git
 * branch comes back with its history. A note is missing when it isn't in a
 * folder that holds something, at two looks `wait` ms apart, so a note Hibi
 * moved has its history moved before the second. The first launch to find it
 * so records the time, and seeing the note again clears that. A folder that is
 * missing or empty, as on a drive that isn't mounted, and any lookup that fails
 * leave a note's history and record as they are. A time ahead of the clock
 * waits for the clock, so a clock set back and restored doesn't shorten a wait.
 */
export async function pruneUndoHistory(wait = 10_000) {
  /** Whether a path is there, or null when the lookup can't tell. */
  const there = (path: string) =>
    stat(path).then(
      () => true,
      (error: NodeJS.ErrnoException) =>
        error.code === 'ENOENT' ? false : null,
    )
  const holds = (path: string) =>
    opendir(path)
      .then(async (entries) => {
        try {
          return (await entries.read()) !== null
        } finally {
          await entries.close()
        }
      })
      .catch(() => false)
  /** Whether a note is there, not there, or null when a look can't tell. */
  const look = async (path: string) => {
    const note = await there(path)
    if (note !== false) return note
    // iCloud Drive before macOS 14 swaps a note it evicts for `.name.icloud`.
    const evicted = await there(
      join(dirname(path), `.${basename(path)}.icloud`),
    )
    if (evicted !== false) return evicted
    return (await holds(dirname(path))) ? false : null
  }
  const listed = await serial(async () => {
    await sweep()
    return [...(await indexed())]
  })
  const back: string[] = []
  const missing: [string, string][] = []
  for (const [name, path] of listed) {
    const found = await look(path)
    const since = missingSince.get(name)
    if (found && since !== undefined) back.push(name)
    // A note still waiting out its time needs no second look.
    else if (
      found === false &&
      (since === undefined || Date.now() - since >= MISSING_MS)
    )
      missing.push([name, path])
  }
  // Before the wait: a quit during it doesn't lose what this look saw.
  if (back.length)
    await tracked(
      serial(async () => {
        let changed = false
        for (const name of back) if (missingSince.delete(name)) changed = true
        if (changed) await writeIndex()
      }),
    )
  if (!missing.length) return
  await new Promise((resolve) => setTimeout(resolve, wait))
  await tracked(
    serial(async () => {
      let changed = false
      const known = await indexed()
      for (const [name, path] of missing) {
        // Moved, trashed or cleared since the first look.
        if (!known.has(name)) continue
        const found = await look(path)
        if (found) {
          if (missingSince.delete(name)) changed = true
        } else if (found === false) {
          if (missingSince.has(name)) await remove(name)
          else missingSince.set(name, Date.now())
          changed = true
        }
      }
      if (changed) await writeIndex()
    }),
  )
}

/**
 * Kept histories follow notes renamed or moved inside Hibi: the note at
 * `from`, or every note under `from` when a folder moved. Moves apply in the
 * order they were made, from the notes' paths alone, so a later move or an
 * unreadable folder can't strand a history under an old name.
 */
export function relocateUndoHistory(from: string, to: string) {
  return tracked(
    serial(async () => {
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
        missingSince.delete(after)
      }
      if (changed) await writeIndex()
    }),
  )
}

/**
 * Kept histories go with notes Hibi moves to the trash: the note at `path`,
 * or every note under `path` when a folder went.
 */
export function removeUndoHistory(path: string) {
  return tracked(
    serial(async () => {
      const files = await measure()
      const known = await indexed()
      let changed = false
      for (const [name, note] of [...known])
        if (isPathInside(path, note)) {
          await remove(name)
          changed = true
        }
      // A history kept before its note joined the index goes by its name.
      if (files.has(fileName(path))) await remove(fileName(path))
      if (changed) await writeIndex()
    }),
  )
}

export async function setKeepUndoHistory(keep: unknown) {
  if (typeof keep !== 'boolean')
    throw new Error('Invalid undo history setting.')
  // A quit waits for the setting and for the clear turning it off asks for.
  await tracked(
    (async () => {
      await serial(() => writeText(settingsPath(), JSON.stringify({ keep })))
      keeping = Promise.resolve(keep)
      if (!keep) await clearUndoHistory()
    })(),
  )
}

/** Removes every note's kept undo history; a quit waits for it. */
export function clearUndoHistory() {
  return tracked(
    serial(async () => {
      await rm(folder(), { recursive: true, force: true })
      await rm(indexPath(), { force: true })
      await removeIndexCopies()
      sizes = new Map()
      notes = new Map()
      missingSince.clear()
    }),
  )
}

const flushes = new Map<string, () => void>()
export function acceptUndoHistoryFlushed(token: unknown) {
  if (typeof token === 'string') flushes.get(token)?.()
}
/**
 * Asks the editor for the undo histories of saves it has not sent yet, as
 * a save prompt's, and waits until they are queued, so a closing tab doesn't
 * wait on other notes' writes. An editor that does not answer in 5 seconds
 * keeps them.
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
}
/**
 * Waits for queued writes, moves and removals, as a quit must, for 5 seconds
 * at most: a disk that stops answering doesn't keep Hibi from quitting.
 */
export async function undoHistoryWritten() {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled(writing),
    new Promise((resolve) => {
      timer = setTimeout(resolve, 5000)
    }),
  ])
  clearTimeout(timer)
}
