import type { AddonNoteReader, AddonSlashCommand } from '../../addons/api'
import type { DocumentState } from '../../shared/desktop'
import { documentSnapshot } from './document-transfer.ts'

const readers = new WeakMap<Readonly<DocumentState>, AddonNoteReader>()
const documents = new WeakMap<AddonNoteReader, Readonly<DocumentState>>()

/** The document version a note reader reads, for checks that keep what they learned about it. */
export const noteDocument = (note: AddonNoteReader) =>
  documents.get(note) ?? null

/** A note read in parts from its source: one reader per document version. */
export function noteReader(
  document: Readonly<DocumentState> | null,
): AddonNoteReader {
  const known = document && readers.get(document)
  if (known) return known
  const source = document && documentSnapshot(document)
  const length = source ? source.utf16Length : (document?.markdown.length ?? 0)
  const at = (position: number) =>
    Math.min(length, Math.max(0, Math.trunc(position) || 0))
  const reader: AddonNoteReader = {
    length,
    slice(from, to) {
      const start = at(from),
        end = Math.max(start, at(to))
      return source
        ? source.sliceRaw(start, end)
        : (document?.markdown.slice(start, end) ?? '')
    },
  }
  if (document) {
    readers.set(document, reader)
    documents.set(reader, document)
  }
  return reader
}

/**
 * The slash commands a note offers, their checks and transforms false or
 * cancelled once their command stops and when they throw, which `report`
 * receives. `available` reads only the parts of the note it asks for; the
 * complete note is read once, and only for `when`.
 */
export function availableSlashCommands(
  commands: Iterable<{
    id: string
    slash?: AddonSlashCommand
    live?: () => boolean
  }>,
  document: Readonly<DocumentState> | null,
  report: (error: unknown) => void,
) {
  const note = noteReader(document)
  let source: string | undefined
  const whole = () => {
    source ??= document?.markdown ?? ''
    return source
  }
  return [...commands].flatMap(({ id, slash, live = () => true }) => {
    if (!slash || !live()) return []
    const guard =
      <T, R>(run: (input: T) => R, fallback: R) =>
      (input: T) => {
        if (!live()) return fallback
        try {
          return run(input)
        } catch (error) {
          report(error)
          return fallback
        }
      }
    const available = slash.available && guard(slash.available, false)
    const when = slash.when && guard(slash.when, false)
    if (available ? !available(note) : when && !when(whole())) return []
    return [
      {
        ...slash,
        ...(available && { available }),
        ...(when && { when }),
        transform: guard(slash.transform, null),
        id,
      },
    ]
  })
}
