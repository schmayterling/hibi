import { createContext } from 'react'

export const SettingsDiscovery = createContext(false)
/** False while discovery or search keeps a hidden settings page mounted. */
export const SettingsPageVisible = createContext(true)
type Setting = { id: string; label: string; category: string; keywords: string }
const rows = new Map<string, Setting>()
const listeners = new Set<() => void>()
let snapshot: Setting[] = []
let stale = false
let scheduled = false
// A page mounting k rows copies the index once and notifies once, not k times.
const publish = () => {
  stale = true
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    for (const listener of listeners) listener()
  })
}
/** Shared SettingRow controls register only inside a settings discovery scope. */
export const settingsIndex = {
  snapshot: () => {
    if (stale) {
      snapshot = [...rows.values()]
      stale = false
    }
    return snapshot
  },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  register(element: HTMLElement, id: string, label: string) {
    const panel = element.closest('section[role="tabpanel"]')
    const category = panel?.id.replace(/^settings-/, '')
    if (!category) return () => {}
    const key = `${category}.${id}`
    rows.set(key, {
      id,
      label,
      category,
      keywords: element.textContent ?? label,
    })
    publish()
    return () => {
      rows.delete(key)
      publish()
    }
  },
}
