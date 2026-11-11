export const AUTOSAVE_PREFERENCES_CHANNEL = 'settings:autosave'
export const autosaveDelays = [1000, 2000, 5000, 10000, 30000] as const
export type AutosavePreferences = { enabled: boolean; delay: number }

/** Missing means on; a damaged stored choice cannot authorize writing notes. */
export function readAutosavePreferences(
  text: string | null,
): AutosavePreferences {
  try {
    const value = JSON.parse(text ?? '{}')
    return {
      enabled:
        value.enabled === undefined &&
        typeof value === 'object' &&
        !Array.isArray(value)
          ? true
          : value.enabled === true,
      delay: autosaveDelays.includes(value.delay) ? value.delay : 2000,
    }
  } catch {
    return { enabled: false, delay: 2000 }
  }
}
