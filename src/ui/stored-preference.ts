const refresh = new Map<string, () => void>()
const storageHost = globalThis as {
  addEventListener?: (
    type: string,
    listener: (event: { key: string | null }) => void,
  ) => void
}
// Addon editor windows share this origin's storage, so changes in one window reach the others.
storageHost.addEventListener?.('storage', (event) => {
  if (event.key === null) for (const update of refresh.values()) update()
  else refresh.get(event.key)?.()
})

export function stored<T>(
  key: string,
  read: () => T,
  write: (value: T) => string,
) {
  let value = read()
  const listeners = new Set<() => void>()
  const publish = () => {
    for (const listener of listeners) listener()
  }
  refresh.set(key, () => {
    value = read()
    publish()
  })
  return {
    get: () => value,
    set(next: T) {
      value = next
      localStorage.setItem(key, write(next))
      publish()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
