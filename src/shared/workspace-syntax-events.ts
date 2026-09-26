const listeners = new Set<() => void>()
let revision = 0

/** Renderer-local invalidation for visible workspace metadata consumers. */
export const workspaceSyntaxEvents = {
  snapshot: () => revision,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  publish() {
    revision++
    for (const listener of listeners) listener()
  },
}

const storageHost = globalThis as {
  addEventListener?: (
    type: string,
    listener: (event: { key: string | null }) => void,
  ) => void
}
storageHost.addEventListener?.('storage', (event) => {
  if (
    event.key === null ||
    event.key?.startsWith('hibi:flavor:') ||
    event.key === 'hibi:markdown-syntax-disabled'
  )
    workspaceSyntaxEvents.publish()
})
