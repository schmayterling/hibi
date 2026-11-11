import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import {
  autosaveDelays,
  readAutosavePreferences,
} from '../shared/autosave-preferences'
import { syncFolder, writeText } from './files'

let writing: Promise<unknown> = Promise.resolve()

/** The synchronous bridge replies only after the atomic setting write finishes. */
export function autosavePreferences(operation: unknown, value: unknown) {
  const next = writing
    .catch(() => {})
    .then(async () => {
      const path = join(app.getPath('userData'), 'autosave.json')
      const save = async (
        preferences: ReturnType<typeof readAutosavePreferences>,
      ) => {
        await writeText(path, JSON.stringify(preferences))
        await syncFolder(app.getPath('userData'))
        return preferences
      }
      if (
        operation === 'get' &&
        (value === null || (typeof value === 'string' && value.length <= 1024))
      ) {
        try {
          return readAutosavePreferences(await readFile(path, 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            return readAutosavePreferences('null')
          const preferences = readAutosavePreferences(value)
          // Migrate an existing off before the renderer can use the preference.
          return value === null ? preferences : save(preferences)
        }
      }
      if (
        operation === 'set' &&
        value &&
        typeof value === 'object' &&
        'enabled' in value &&
        typeof value.enabled === 'boolean' &&
        'delay' in value &&
        autosaveDelays.some((delay) => delay === value.delay)
      ) {
        return save({ enabled: value.enabled, delay: value.delay as number })
      }
      throw new Error('Invalid autosave settings.')
    })
  writing = next
  return next
}
