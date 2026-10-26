import type { AddonNoteReader, AddonSlashCommand } from '../../addons/api'
import type { DocumentState } from '../../shared/desktop'
import { documentSnapshot } from './document-transfer.ts'

/** A note read in parts from its source, without reading the whole note. */
export function noteReader(
  document: Readonly<DocumentState> | null,
): AddonNoteReader {
  const source = document && documentSnapshot(document)
  const length = source ? source.utf16Length : (document?.markdown.length ?? 0)
  const at = (position: number) =>
    Math.min(length, Math.max(0, Math.trunc(position) || 0))
  return {
    length,
    slice(from, to) {
      const start = at(from),
        end = Math.max(start, at(to))
      return source
        ? source.sliceRaw(start, end)
        : (document?.markdown.slice(start, end) ?? '')
    },
  }
}

/**
 * The slash commands a note offers. `available` reads only the parts of the
 * note it asks for; the complete note is read once, and only for `when`.
 */
export function availableSlashCommands(
  commands: Iterable<{ id: string; slash?: AddonSlashCommand }>,
  document: Readonly<DocumentState> | null,
) {
  const note = noteReader(document)
  let source: string | undefined
  const whole = () => {
    source ??= document?.markdown ?? ''
    return source
  }
  return [...commands].flatMap(({ id, slash }) =>
    slash &&
    (slash.available
      ? slash.available(note)
      : !slash.when || slash.when(whole()))
      ? [{ ...slash, id }]
      : [],
  )
}
