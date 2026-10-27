import { documentSnapshot } from '../../renderer/src/document-transfer.ts'
import { noteDocument } from '../../renderer/src/slash-availability.ts'
import type { DocumentState } from '../../shared/desktop'
import {
  type FrontmatterRead,
  keepUnclosedFrontmatterRead,
  readSourceFrontmatter,
  reuseFrontmatterRead,
} from '../../shared/source-frontmatter.ts'
import type { RawEdit } from '../../shared/source-operations'
import type { AddonNoteReader } from '../api'

/** A note version's frontmatter read, finished or under way. */
type Reading = {
  read?: FrontmatterRead
  work?: Generator<void, FrontmatterRead> | undefined
  idle?: number
}
const readings = new WeakMap<object, Reading>()
/** Each tab's latest finished read, for the version it is true of; edits that cannot change it carry it forward. */
const finished = new Map<
  string,
  { revision: number; contentVersion: number; read: FrontmatterRead }
>()
/** Each tab's latest version, which alone reads on in idle time. */
const latest = new Map<string, number>()

/** Carry a tab's finished read through an edit of the document, or drop it. */
export function carryFrontmatterRead(
  document: Readonly<DocumentState> | null,
  changes: readonly RawEdit[] | null,
) {
  if (!document) return
  latest.set(document.tabId, document.contentVersion)
  const entry = finished.get(document.tabId)
  if (!entry) return
  const source = documentSnapshot(document)
  const read =
    changes &&
    source &&
    entry.revision === document.revision &&
    entry.contentVersion + 1 === document.contentVersion
      ? reuseFrontmatterRead(entry.read, changes)
        ? entry.read
        : keepUnclosedFrontmatterRead(entry.read, changes, source)
      : null
  if (read)
    finished.set(document.tabId, {
      revision: document.revision,
      contentVersion: document.contentVersion,
      read,
    })
  else finished.delete(document.tabId)
}

/** A note read in pieces, as the frontmatter reader reads a source. */
const pieces = (note: AddonNoteReader) => ({
  utf16Length: note.length,
  sliceRaw: (from: number, to: number) => note.slice(from, to),
})

/** Read on a few pieces; a finished read is kept for the version it read. */
function advance(
  reading: Reading,
  document: Readonly<DocumentState> | null,
  steps: number,
) {
  for (let step = 0; step < steps && reading.work; step++) {
    const next = reading.work.next()
    if (!next.done) continue
    reading.read = next.value
    reading.work = undefined
    if (document)
      finished.set(document.tabId, {
        revision: document.revision,
        contentVersion: document.contentVersion,
        read: next.value,
      })
  }
}

/** Finish a read in idle time, until a later version of its tab replaces it. */
function readWhenIdle(
  reading: Reading,
  document: Readonly<DocumentState> | null,
) {
  if (reading.idle || typeof requestIdleCallback !== 'function') return
  reading.idle = requestIdleCallback((deadline) => {
    reading.idle = 0
    const version = document && latest.get(document.tabId)
    if (
      document &&
      version !== undefined &&
      version !== document.contentVersion
    )
      return
    while (reading.work && deadline.timeRemaining() > 1)
      advance(reading, document, 1)
    if (reading.work) readWhenIdle(reading, document)
  })
}

/**
 * Whether frontmatter is present or its read is unfinished. A check reads a
 * few pieces of the note; idle time reads on, and a finished read lasts through edits that
 * cannot change it. Until a read finishes, withhold the add action.
 */
export function hasFrontmatter(note: AddonNoteReader) {
  const document = noteDocument(note)
  const entry = document && finished.get(document.tabId)
  if (
    document &&
    entry?.revision === document.revision &&
    entry.contentVersion === document.contentVersion
  )
    return entry.read.oversized || !!entry.read.bounds
  const key = document ?? note
  let reading = readings.get(key)
  if (!reading) {
    reading = {}
    readings.set(key, reading)
  }
  if (!reading.read) {
    reading.work ??= readSourceFrontmatter(
      (document && documentSnapshot(document)) || pieces(note),
    )
    advance(reading, document, 2)
    if (!reading.read) readWhenIdle(reading, document)
  }
  return !reading.read || reading.read.oversized || !!reading.read.bounds
}
