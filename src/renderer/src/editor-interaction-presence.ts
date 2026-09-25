let providers = 0
const listeners = new Set<() => void>()

export const hasEditorInteractionProviders = () => providers > 0

export function onEditorInteractionProvidersChanged(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function countEditorInteractionProvider() {
  const wasActive = providers > 0
  providers++
  if (!wasActive) for (const listener of listeners) listener()
  let removed = false
  return () => {
    if (removed) return
    removed = true
    providers--
    if (!providers) for (const listener of listeners) listener()
  }
}
