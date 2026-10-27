/** Compatibility follows live addon registrations while source editing remains available. */
const entries = new Map<string, { rich: number; formatted: number }>()
const listeners = new Set<() => void>()
let snapshot: readonly string[] = []

function publish() {
  const next = [...entries]
    .filter(([, value]) => value.rich > 0 && value.formatted === 0)
    .map(([id]) => id)
    .sort()
  if (
    next.length === snapshot.length &&
    next.every((id, index) => id === snapshot[index])
  )
    return
  snapshot = next
  for (const listener of listeners) listener()
}

export const formattedCompatibility = {
  snapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  register(id: string, kind: 'rich' | 'formatted') {
    const entry = entries.get(id) ?? { rich: 0, formatted: 0 }
    entries.set(id, entry)
    entry[kind]++
    publish()
    let active = true
    return () => {
      if (!active) return
      active = false
      entry[kind]--
      if (!entry.rich && !entry.formatted) entries.delete(id)
      publish()
    }
  },
}
