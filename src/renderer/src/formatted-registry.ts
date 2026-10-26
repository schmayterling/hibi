import type { FormattedContribution } from './formatted-contributions.ts'

/**
 * Formatted view features register here. Entries load their contribution only
 * when a formatted view needs it, so registering at startup loads no editor
 * code.
 */
export type FormattedEntry = {
  id: string
  load: () => FormattedContribution | Promise<FormattedContribution>
}

const entries = new Map<string, FormattedEntry>()
const listeners = new Set<() => void>()
let version = 0

function changed() {
  version++
  for (const listener of listeners) listener()
}

export const formattedRegistry = {
  /** Add a feature; returns its removal. */
  register(entry: FormattedEntry) {
    if (entries.has(entry.id)) {
      console.error(`duplicate formatted contribution: ${entry.id}`)
      return () => {}
    }
    entries.set(entry.id, entry)
    changed()
    return () => {
      if (entries.get(entry.id) !== entry) return
      entries.delete(entry.id)
      changed()
    }
  },
  entries: () => [...entries.values()],
  version: () => version,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}
