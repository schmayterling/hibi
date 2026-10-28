/** Compatibility follows live addon features while source editing remains available. */
type Features = { rich: readonly string[]; formatted: readonly string[] }
const entries = new Set<{ id: string; features: () => Features }>()
const listeners = new Set<() => void>()
let snapshot: readonly string[] = []
let missing: readonly string[] = []

function publish() {
  const active = [...entries].map(({ id, features }) => ({ id, ...features() }))
  const formatted = new Set(
    active.flatMap(({ id, formatted }) =>
      formatted.map((feature) => `${id}.${feature}`),
    ),
  )
  const next = [
    ...new Set(
      active.flatMap(({ id, rich }) =>
        rich.map((feature) => `${id}.${feature}`),
      ),
    ),
  ]
    .filter((feature) => !formatted.has(feature))
    .sort()
  if (
    next.length === missing.length &&
    next.every((feature, index) => feature === missing[index])
  )
    return
  missing = next
  const owners = [
    ...new Set(next.map((feature) => feature.slice(0, feature.indexOf('.')))),
  ]
  if (
    owners.length !== snapshot.length ||
    owners.some((id, index) => id !== snapshot[index])
  )
    snapshot = owners
  for (const listener of listeners) listener()
}

function registerFeatures(id: string, features: () => Features) {
  const entry = { id, features }
  entries.add(entry)
  publish()
  return () => {
    if (entries.delete(entry)) publish()
  }
}

export const formattedCompatibility = {
  snapshot: () => snapshot,
  features: () => missing,
  refresh: publish,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  register(id: string, kind: 'rich' | 'formatted', feature: string) {
    return registerFeatures(id, () => ({
      rich: kind === 'rich' ? [feature] : [],
      formatted: kind === 'formatted' ? [feature] : [],
    }))
  },
  registerFeatures,
}
