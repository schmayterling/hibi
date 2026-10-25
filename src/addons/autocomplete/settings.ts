import { latinLangs } from '../dictionary/lookup.ts'
import type { Lang } from '../dictionary/providers.ts'

export type AutocompletePreferences = {
  suggest: boolean
  tabAccepts: boolean
  learning: boolean
  languages: Lang[]
  excludedDocuments: string[]
  excludedWorkspaces: string[]
}

const key = 'hibi:autocomplete'
const listeners = new Set<() => void>()
let cached: AutocompletePreferences | undefined
let unsaved = false

export const preferencesSaved = () => !unsaved

function saved(key: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

const ids = (value: unknown) =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (id): id is string => typeof id === 'string' && id.length <= 256,
          ),
        ),
      ]
    : []

/** Run before addon activation so existing suggestions survive the default-off split. */
export async function migrateDictionaryTyping(enable: () => Promise<void>) {
  const previous = saved('hibi:dictionary:typing')
  if (!previous) return
  const current = saved(key)
  if (!current && previous.suggest === true) await enable()
  cached = undefined
  const preferences = readPreferences()
  if (!current) localStorage.setItem(key, JSON.stringify(preferences))
  localStorage.removeItem('hibi:dictionary:typing')
}

export function readPreferences(): AutocompletePreferences {
  if (cached) return cached
  const previous = saved('hibi:dictionary:typing')
  const current = saved(key)
  const value = current ?? previous ?? {}
  cached = {
    suggest: value.suggest !== false,
    tabAccepts: (value.tabAccepts ?? value.acceptOnTab) !== false,
    learning: value.learning !== false,
    languages: Array.isArray(value.languages)
      ? [
          ...new Set(
            value.languages.filter((lang): lang is Lang =>
              latinLangs.includes(lang),
            ),
          ),
        ]
      : ['en'],
    excludedDocuments: ids(value.excludedDocuments),
    excludedWorkspaces: ids(value.excludedWorkspaces),
  }
  if (!cached.languages.length) cached.languages = ['en']
  return cached
}

export function writePreferences(next: AutocompletePreferences) {
  if (!next.languages.some((lang) => latinLangs.includes(lang))) return
  cached = next
  unsaved = true
  try {
    localStorage.setItem(key, JSON.stringify(next))
    unsaved = false
  } catch (error) {
    console.error('Could not save autocomplete preferences:', error)
  }
  for (const listener of listeners) listener()
}

function changedInAnotherWindow(event: StorageEvent) {
  if (
    event.storageArea !== localStorage ||
    (event.key !== key && event.key !== null)
  )
    return
  if (!unsaved) cached = undefined
  for (const listener of listeners) listener()
}

export function onPreferencesChange(listener: () => void) {
  if (!listeners.size) {
    if (!unsaved) cached = undefined
    if (typeof window !== 'undefined')
      window.addEventListener('storage', changedInAnotherWindow)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size && typeof window !== 'undefined')
      window.removeEventListener('storage', changedInAnotherWindow)
  }
}
