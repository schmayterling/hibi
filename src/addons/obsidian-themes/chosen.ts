// The installed themes Hibi's light and dark colorschemes stand for, shared
// between the running addon and its Appearance section.
const listeners = new Set<() => void>()
let chosen: readonly string[] = []
export const chosenThemes = {
  get: () => chosen,
  set(next: readonly string[]) {
    if (next.join() === chosen.join()) return
    chosen = next
    for (const listener of listeners) listener()
  },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}
