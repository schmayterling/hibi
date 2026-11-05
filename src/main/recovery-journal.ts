import { createHash } from 'node:crypto'
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { app } from 'electron'
import {
  parseRecoverySettings,
  type RecoveryCopy,
  type RecoverySettings,
  type RecoveryWaiting,
} from '../shared/recovery'
import type { SourceSnapshot } from '../shared/source-buffer'
import { syncFolder, writeChunks, writeText } from './files'
import { sourceHash } from './history'

// Unsaved text stays in app data, never beside notes. A copy is never renamed
// over another: each write makes a new file, and the older one goes only once
// the new one is on disk. A cut-off write hurts only itself, and on Windows no
// program holding a file can refuse it.
const folder = () => join(app.getPath('userData'), 'recovery')
const settingsPath = () =>
  join(app.getPath('userData'), 'recovery-settings.json')
const FILE_NAME = /^([0-9a-f-]{36})\.(\d+)(?:\.(\d+))?\.recovery$/
const FORMAT = 1
const HEADER_BYTES = 64 * 1024
/** A hash of the header and one of the text, then a line end. */
const TRAILER_BYTES = 129
const DAY = 24 * 60 * 60 * 1000
const MEBIBYTE = 1024 * 1024
const FIRST_GAP = 1000
const LONGEST_GAP = 30_000
/**
 * One more second to the next write for this much just written, so large notes
 * cost the app about the same as small ones. Counted in bytes, not in time: a
 * slow disk moment must not stretch how much typing a crash can lose.
 */
const BYTES_PER_GAP_SECOND = 8 * MEBIBYTE
const PREVIEW_UNITS = 120

export type UnsavedNote = Readonly<{
  tabId: string
  /** The note's file, or the planned file of one not created yet. */
  path: string | null
  named: boolean
  name: string
  text: SourceSnapshot
  saved: SourceSnapshot
}>
type Header = Readonly<{
  format: number
  path: string | null
  named: boolean
  name: string
  savedHash: string
  time: number
  bytes: number
}>
type Waiting = Header & {
  id: string
  file: string
  size: number
  offered: number | undefined
  textStart: number
  textHash: string
  preview: string
  state: RecoveryCopy['state']
}
/** A copy only a newer build can read, or one damaged past reading. */
type Unreadable = { file: string; size: number; time: number; newer: boolean }

let unsavedNotes: (() => UnsavedNote[]) | undefined
let notify: (message: string) => void = () => {}
/** This launch's copies, by tab. They are never another launch's to claim. */
const written = new Map<
  string,
  { key: string; file: string; size: number; name: string }
>()
let generation = 0
const waiting = new Map<string, Waiting>()
let unreadable: Unreadable[] = []
/** Files a program held when they were to go; each queue turn tries again. */
const leftover = new Set<string>()
let dismissed = false
let writeFailed = false
const tooLarge = new Set<string>()

let settingsRead: Promise<RecoverySettings> | undefined
export const recoverySettings = () =>
  (settingsRead ??= readFile(settingsPath(), 'utf8').then(
    (text) => {
      try {
        return parseRecoverySettings(JSON.parse(text))
      } catch {
        return parseRecoverySettings(null)
      }
    },
    () => parseRecoverySettings(null),
  ))

// Writes and removals run one at a time, in order.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(task: () => Promise<T>): Promise<T> => {
  const next = queue.catch(() => {}).then(task)
  queue = next
  return next
}
const running = new Set<Promise<unknown>>()
/** A quit waits for queued writes and removals. */
const tracked = <T>(task: Promise<T>) => {
  running.add(task)
  void task.catch(() => {}).finally(() => running.delete(task))
  return task
}

async function drop(file: string) {
  try {
    await unlink(file)
    leftover.delete(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      leftover.delete(file)
    else leftover.add(file)
  }
}
async function dropLeftovers() {
  for (const file of [...leftover]) await drop(file)
}

async function readAt(file: FileHandle, position: number, length: number) {
  const bytes = Buffer.allocUnsafe(length)
  let read = 0
  while (read < length) {
    const { bytesRead } = await file.read(
      bytes,
      read,
      length - read,
      position + read,
    )
    if (!bytesRead) break
    read += bytesRead
  }
  return bytes.subarray(0, read)
}
/** A copy's header if it is whole; `newer` if a later format; null if damaged. */
async function inspect(path: string) {
  let file: FileHandle
  try {
    file = await open(path, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await file.stat()
    const start = await readAt(file, 0, Math.min(size, HEADER_BYTES))
    const end = start.indexOf(10)
    if (end < 0) return null
    const line = start.subarray(0, end)
    const header = JSON.parse(line.toString('utf8')) as Header
    if (typeof header?.format !== 'number') return null
    if (header.format > FORMAT) return 'newer' as const
    if (
      header.format !== FORMAT ||
      (typeof header.path !== 'string' && header.path !== null) ||
      typeof header.named !== 'boolean' ||
      typeof header.name !== 'string' ||
      typeof header.savedHash !== 'string' ||
      !Number.isSafeInteger(header.time) ||
      !Number.isSafeInteger(header.bytes) ||
      header.bytes < 0 ||
      size !== end + 1 + header.bytes + TRAILER_BYTES
    )
      return null
    const trailer = (
      await readAt(file, size - TRAILER_BYTES, TRAILER_BYTES)
    ).toString('latin1')
    const textHash = trailer.slice(64, 128)
    if (
      trailer.slice(0, 64) !== createHash('sha256').update(line).digest('hex')
    )
      return null
    const digest = createHash('sha256')
    const textStart = end + 1
    for (let at = textStart; at < textStart + header.bytes; ) {
      const part = await readAt(
        file,
        at,
        Math.min(MEBIBYTE, textStart + header.bytes - at),
      )
      if (!part.length) return null
      digest.update(part)
      at += part.length
    }
    if (digest.digest('hex') !== textHash) return null
    const opening = start.subarray(textStart, textStart + header.bytes)
    return {
      header,
      size,
      textStart,
      textHash,
      preview: new TextDecoder('utf-8', { ignoreBOM: true })
        .decode(opening.subarray(0, PREVIEW_UNITS * 4))
        .slice(0, PREVIEW_UNITS),
    }
  } catch {
    return null
  } finally {
    await file.close().catch(() => {})
  }
}
/** The hash of a file's bytes, or null if it is gone. Any other failure counts as changed. */
async function fileHash(path: string) {
  let file: FileHandle
  try {
    file = await open(path, 'r')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : ''
  }
  try {
    const digest = createHash('sha256')
    for (let at = 0; ; ) {
      const part = await readAt(file, at, MEBIBYTE)
      if (!part.length) return digest.digest('hex')
      digest.update(part)
      at += part.length
    }
  } catch {
    return ''
  } finally {
    await file.close().catch(() => {})
  }
}
const expired = (time: number | undefined, days: number, now = Date.now()) =>
  days > 0 && time !== undefined && now - time >= days * DAY

let loaded: Promise<void> | undefined
/**
 * Everything in the folder at a launch's first look came from an earlier run:
 * a second instance quits before it starts. One older copy stands in for a
 * newer one that was cut off, and the older files of a whole one go. A copy
 * that can't be read stays out of the prompt, untouched, for a newer build or
 * for someone rescuing it by hand; the time limit, the size limit and turning
 * copies off still reach it.
 */
const load = () =>
  (loaded ??= (async () => {
    const settings = await recoverySettings()
    if (!settings.keep) {
      await rm(folder(), { recursive: true, force: true })
      return
    }
    const tabs = new Map<string, { file: string; generation: number }[]>()
    for (const name of await readdir(folder()).catch(() => [])) {
      const match = FILE_NAME.exec(name)
      if (!match || written.has(match[1]!)) continue
      const files = tabs.get(match[1]!) ?? []
      tabs.set(match[1]!, files)
      files.push({ file: join(folder(), name), generation: Number(match[2]) })
    }
    for (const [id, files] of tabs) {
      files.sort((a, b) => b.generation - a.generation)
      let found = false
      for (const { file } of files) {
        if (found) {
          await drop(file)
          continue
        }
        const copy = await inspect(file)
        if (copy && copy !== 'newer') {
          found = true
          const offered = FILE_NAME.exec(basename(file))?.[3]
          const time = offered === undefined ? undefined : Number(offered)
          if (expired(time, settings.days)) {
            await drop(file)
            continue
          }
          const { header } = copy
          const hash =
            header.named && header.path !== null
              ? await fileHash(header.path)
              : undefined
          // The text reached the note after all, as a crash after a save leaves it.
          if (hash === copy.textHash) {
            await drop(file)
            continue
          }
          waiting.set(id, {
            ...copy.header,
            id,
            file,
            size: copy.size,
            offered: time,
            textStart: copy.textStart,
            textHash: copy.textHash,
            preview: copy.preview,
            state:
              hash === undefined
                ? 'untitled'
                : hash === null
                  ? 'missing'
                  : hash === header.savedHash
                    ? 'unchanged'
                    : 'changed',
          })
          continue
        }
        const info = await stat(file).catch(() => null)
        unreadable.push({
          file,
          size: info?.size ?? 0,
          time: info?.mtimeMs ?? Date.now(),
          newer: copy === 'newer',
        })
      }
      // A whole copy replaces the damaged files of its tab.
      if (found) {
        const damaged = unreadable.filter(
          ({ file, newer }) => !newer && basename(file).startsWith(id),
        )
        for (const { file } of damaged) await drop(file)
        unreadable = unreadable.filter((item) => !damaged.includes(item))
      }
    }
    for (const item of [...unreadable])
      if (!item.newer && expired(item.time, settings.days)) {
        unreadable = unreadable.filter((other) => other !== item)
        await drop(item.file)
      }
  })())

const total = () => {
  let bytes = 0
  for (const { size } of written.values()) bytes += size
  for (const { size } of waiting.values()) bytes += size
  for (const { size } of unreadable) bytes += size
  return bytes
}
/** Copies no open tab holds, oldest first. */
const unclaimed = () =>
  [
    ...[...waiting.values()].map((copy) => ({
      name: copy.name as string | null,
      size: copy.size,
      time: copy.time,
      offered: copy.offered,
      go: async () => {
        waiting.delete(copy.id)
        await drop(copy.file)
      },
    })),
    ...unreadable.map((item) => ({
      name: null as string | null,
      size: item.size,
      time: item.time,
      offered: undefined as number | undefined,
      go: async () => {
        unreadable = unreadable.filter((other) => other !== item)
        await drop(item.file)
      },
    })),
  ].sort((a, b) => a.time - b.time)

/** What settings would remove now: past the time limit, then oldest past the size limit. */
function goingWith(next: RecoverySettings) {
  const items = unclaimed()
  if (!next.keep) return items
  const going = items.filter((item) => expired(item.offered, next.days))
  let bytes = total() - going.reduce((sum, item) => sum + item.size, 0)
  for (const item of items) {
    if (bytes <= next.megabytes * MEBIBYTE) break
    if (going.includes(item)) continue
    going.push(item)
    bytes -= item.size
  }
  return going
}

async function writeCopy(note: UnsavedNote, key: string) {
  await load()
  const settings = await recoverySettings()
  const previous = written.get(note.tabId)
  const { hash: savedHash } = await sourceHash(note.saved)
  const header = Buffer.from(
    `${JSON.stringify({
      format: FORMAT,
      path: note.path,
      named: note.named,
      name: note.name,
      savedHash,
      time: Date.now(),
      bytes: note.text.utf8Bytes,
    } satisfies Header)}\n`,
  )
  const size = header.length + note.text.utf8Bytes + TRAILER_BYTES
  const limit = settings.megabytes * MEBIBYTE
  // A note past the limit can't have a copy; one it already has stays.
  if (size > limit) {
    if (!tooLarge.has(note.tabId))
      notify(
        `${note.name} is too large for a recovery copy. Save it to keep your changes, or raise the limit in Settings.`,
      )
    tooLarge.add(note.tabId)
    return
  }
  tooLarge.delete(note.tabId)
  let bytes = total() - (previous?.size ?? 0) + size
  let removed = 0
  for (const item of unclaimed()) {
    if (bytes <= limit) break
    await item.go()
    bytes -= item.size
    removed++
  }
  if (removed)
    notify(
      removed === 1
        ? 'Hibi removed an older recovery copy to stay under its size limit.'
        : `Hibi removed ${removed} older recovery copies to stay under their size limit.`,
    )
  if (bytes > limit) {
    if (!tooLarge.has(note.tabId))
      notify(
        `Open notes leave no room for a recovery copy of ${note.name}. Save them to keep your changes, or raise the limit in Settings.`,
      )
    tooLarge.add(note.tabId)
    return
  }
  await mkdir(folder(), { recursive: true, mode: 0o700 })
  const file = join(folder(), `${note.tabId}.${++generation}.recovery`)
  const handle = await open(file, 'wx', 0o600)
  try {
    const textDigest = createHash('sha256')
    const { text } = note
    async function* parts() {
      yield header
      for (const chunk of text.encodedChunks()) {
        textDigest.update(chunk)
        yield chunk
      }
      yield Buffer.from(
        `${createHash('sha256')
          .update(header.subarray(0, header.length - 1))
          .digest('hex')}${textDigest.digest('hex')}\n`,
      )
    }
    await handle.writeFile(writeChunks(parts()))
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await drop(file)
    throw error
  }
  await handle.close()
  await syncFolder(folder())
  written.set(note.tabId, { key, file, size, name: note.name })
  if (previous) await drop(previous.file)
}
const noteKey = (note: UnsavedNote) =>
  `${note.text.version}:${note.saved.version}:${note.named}:${note.path}:${note.name}`

/** This launch's copies of notes that are saved, discarded or closed go. */
async function removeSettled() {
  await dropLeftovers()
  if (!written.size) return
  const open = new Set(unsavedNotes?.().map(({ tabId }) => tabId))
  for (const [tabId, copy] of [...written])
    if (!open.has(tabId)) {
      written.delete(tabId)
      tooLarge.delete(tabId)
      await drop(copy.file)
    }
}
/** Writes what changed; returns how many bytes that took. */
async function writeDue(only?: string) {
  await removeSettled()
  let bytes = 0
  if (!(await recoverySettings()).keep) return bytes
  for (const note of unsavedNotes?.() ?? []) {
    if (only && note.tabId !== only) continue
    const key = noteKey(note)
    if (written.get(note.tabId)?.key === key) continue
    await writeCopy(note, key)
    bytes += note.text.utf8Bytes
    writeFailed = false
  }
  return bytes
}

let timer: ReturnType<typeof setTimeout> | undefined
let ticking = false
let changedAgain = false
let gap = FIRST_GAP
function schedule(wait: number) {
  timer = setTimeout(() => void tick(), wait)
  timer.unref?.()
}
async function tick() {
  timer = undefined
  ticking = true
  changedAgain = false
  let wait: number | undefined
  try {
    const bytes = await tracked(serial(() => writeDue()))
    gap = Math.min(
      LONGEST_GAP,
      Math.max(FIRST_GAP, (bytes / BYTES_PER_GAP_SECOND) * 1000),
    )
  } catch (error) {
    console.error('Could not write a recovery copy:', error)
    if (!writeFailed)
      notify(
        'Hibi could not keep a recovery copy of your unsaved text. Save your notes to keep your changes.',
      )
    writeFailed = true
    wait = LONGEST_GAP
  } finally {
    ticking = false
  }
  if (wait !== undefined) schedule(wait)
  else if (changedAgain) schedule(gap)
}

/**
 * A note's text changed. The first change starts the clock and later ones
 * don't push it back, so typing without a pause is still kept.
 */
export function recoveryChanged() {
  if (!unsavedNotes) return
  if (ticking) changedAgain = true
  else if (!timer) schedule(gap)
}
/** A file operation ended: anything it saved or closed loses its copy now, not at the next write. */
export function recoverySettled() {
  if (!unsavedNotes) return
  if (written.size || leftover.size)
    void tracked(serial(removeSettled)).catch((error: unknown) =>
      console.error('Could not remove a recovery copy:', error),
    )
  if (unsavedNotes().length) recoveryChanged()
}
export function startRecoveryJournal(
  notes: () => UnsavedNote[],
  say: (message: string) => void,
) {
  unsavedNotes = notes
  notify = say
}
/** Waits for queued writes and removals, as a quit must, for 5 seconds at most. */
export async function recoveryWritten() {
  let bound: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled(running),
    new Promise((resolve) => {
      bound = setTimeout(resolve, 5000)
    }),
  ])
  clearTimeout(bound)
}

/** What an earlier run left, once a launch; the first offer starts a copy's time limit. */
export function waitingRecovery(): Promise<RecoveryWaiting> {
  return serial(async () => {
    await load()
    const settings = await recoverySettings()
    const copies: RecoveryCopy[] = []
    if (!dismissed)
      for (const copy of waiting.values()) {
        if (copy.offered === undefined) {
          const now = Date.now()
          const marked = join(
            folder(),
            `${copy.id}.${FILE_NAME.exec(basename(copy.file))![2]}.${now}.recovery`,
          )
          // A held file keeps its name and is first offered again next time.
          if (
            await rename(copy.file, marked).then(
              () => true,
              () => false,
            )
          ) {
            copy.file = marked
            copy.offered = now
          }
        }
        copies.push({
          id: copy.id,
          name: copy.name,
          folder: copy.path === null ? null : dirname(copy.path),
          time: copy.time,
          bytes: copy.bytes,
          state: copy.state,
          preview: copy.preview,
        })
      }
    return {
      copies: copies.sort((a, b) => b.time - a.time),
      newer: dismissed ? 0 : unreadable.filter(({ newer }) => newer).length,
      openAtLaunch: settings.openAtLaunch,
    }
  })
}
/** The prompt was answered with later: it asks again next launch. */
export function dismissRecovery() {
  dismissed = true
}
export function waitingCopy(id: unknown) {
  return serial(async () => {
    await load()
    return typeof id === 'string' ? waiting.get(id) : undefined
  })
}
export function discardRecovery(id: unknown) {
  return tracked(
    serial(async () => {
      await load()
      const copy = typeof id === 'string' ? waiting.get(id) : undefined
      if (!copy) return
      waiting.delete(copy.id)
      await drop(copy.file)
    }),
  )
}
/** A waiting copy's text, as `SourceStore.load` reads it. */
export async function* recoveryText(copy: Waiting): AsyncGenerator<string> {
  const file = await open(copy.file, 'r')
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    for (let at = 0; at < copy.bytes; ) {
      const part = await readAt(
        file,
        copy.textStart + at,
        Math.min(65536, copy.bytes - at),
      )
      if (!part.length) throw new Error('The recovery copy changed.')
      at += part.length
      const text = decoder.decode(part, { stream: true })
      if (text) yield text
    }
    const tail = decoder.decode()
    if (tail) yield tail
  } finally {
    await file.close().catch(() => {})
  }
}
/**
 * An opened copy goes only once its tab has a copy of its own, so a crash right
 * after opening it loses nothing. A failed write leaves the old one waiting.
 */
export function recoveryOpened(id: string, tabId: string) {
  return tracked(
    serial(async () => {
      await writeDue(tabId)
      const copy = waiting.get(id)
      if (!copy || !written.has(tabId)) return
      waiting.delete(id)
      await drop(copy.file)
    }),
  )
}

const settingsOf = (value: unknown) => {
  const next = parseRecoverySettings(value)
  if (JSON.stringify(next) !== JSON.stringify(value))
    throw new Error('Invalid recovery setting.')
  return next
}
/** The copies these settings would remove, so the choice can say so first. */
export function previewRecoverySettings(value: unknown) {
  const next = settingsOf(value)
  return serial(async () => {
    await load()
    return goingWith(next).map(({ name }) => name)
  })
}
export function setRecoverySettings(value: unknown) {
  const next = settingsOf(value)
  return tracked(
    serial(async () => {
      await load()
      await writeText(settingsPath(), JSON.stringify(next))
      settingsRead = Promise.resolve(next)
      for (const item of goingWith(next)) await item.go()
      if (!next.keep) {
        for (const copy of written.values()) await drop(copy.file)
        written.clear()
      } else if (unsavedNotes?.().length) recoveryChanged()
    }),
  )
}
