import type { SettingsCategory, SettingsPage } from '../../addons/api'

export const coreSettingsCategories = [
  { id: 'editing', label: 'Editing' },
  { id: 'interface', label: 'Interface' },
  { id: 'addons', label: 'Addons' },
  { id: 'general', label: 'Others' },
] as const

export function settingsCategory(owner: string, category = 'addons') {
  return coreSettingsCategories.some((entry) => entry.id === category)
    ? category
    : `${owner}.${category}`
}
type Owned<T> = T & { owner: string }
const categories = new Map<string, Owned<SettingsCategory>>()
const pages = new Map<string, Owned<SettingsPage>>()
const listeners = new Set<() => void>()
let snapshot = {
  categories: [...categories.values()],
  pages: [...pages.values()],
}
function publish() {
  snapshot = {
    categories: [...categories.values()],
    pages: [...pages.values()],
  }
  for (const listener of listeners) listener()
}
function register<T extends { id: string; label: string }>(
  map: Map<string, Owned<T>>,
  owner: string,
  value: T,
  id: string,
) {
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(value.id) ||
    typeof value.label !== 'string' ||
    !value.label.trim() ||
    value.label.length > 100 ||
    map.has(id)
  )
    throw new Error('This addon supplied duplicate or invalid settings.')
  const entry = { ...value, id, owner }
  map.set(id, entry)
  publish()
  return () => {
    if (map.get(id) !== entry) return
    map.delete(id)
    publish()
  }
}
export const settingsPages = {
  snapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  registerCategory(owner: string, category: SettingsCategory) {
    if (coreSettingsCategories.some((entry) => entry.id === category.id))
      throw new Error('Choose a category ID that is not reserved by Hibi.')
    return register(categories, owner, category, `${owner}.${category.id}`)
  },
  register(owner: string, page: SettingsPage) {
    if (
      !page.Content ||
      (typeof page.Content !== 'function' && typeof page.Content !== 'object')
    )
      throw new Error('This addon supplied an invalid settings page.')
    if (
      page.category !== undefined &&
      !/^[a-z][a-z0-9-]{0,63}$/.test(page.category)
    )
      throw new Error('This addon supplied an invalid settings category.')
    return register(
      pages,
      owner,
      { ...page, category: settingsCategory(owner, page.category) },
      `addon-${owner}.${page.id}`,
    )
  },
}
