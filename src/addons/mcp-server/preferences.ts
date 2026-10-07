import {
  DEFAULT_PORT,
  newToken,
  type Preferences,
  parsePreferences,
} from './types'

export { newToken, validPort } from './types'
export const settingsEvent = 'hibi:mcp-server-settings'
const storageKey = 'mcp-server:preferences'

export function getPreferences(): Preferences {
  try {
    return parsePreferences(
      JSON.parse(localStorage.getItem(storageKey) ?? 'null'),
    )
  } catch {
    // Persist the first token so connected clients keep working across launches.
    const preferences = { port: DEFAULT_PORT, token: newToken() }
    localStorage.setItem(storageKey, JSON.stringify(preferences))
    return preferences
  }
}

export function setPreferences(changes: Partial<Preferences>) {
  const next = parsePreferences({ ...getPreferences(), ...changes })
  localStorage.setItem(storageKey, JSON.stringify(next))
  window.dispatchEvent(new Event(settingsEvent))
  return next
}
