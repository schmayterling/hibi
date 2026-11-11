import { readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import {
  autosaveDelays,
  readAutosavePreferences,
} from '../shared/autosave-preferences'
import { syncFolder, writeText } from './files'

let writing: Promise<unknown> = Promise.resolve()
let cleaned = false

/** The synchronous bridge replies only after the atomic setting write finishes. */
export function autosavePreferences(operation: unknown, value: unknown) {
  const next = writing
    .catch(() => {})
    .then(async () => {
      const folder = app.getPath('userData')
      const path = join(folder, 'autosave.json')
      if (!cleaned) {
        cleaned = true
        for (const name of await readdir(folder).catch(() => []))
          if (/^\.autosave\.json\.[0-9a-f-]{36}\.tmp$/.test(name))
            await unlink(join(folder, name)).catch(() => {})
      }
      const off = { enabled: false, delay: 2000 }
      const save = async (
        preferences: ReturnType<typeof readAutosavePreferences>,
      ) => {
        await writeText(path, JSON.stringify(preferences))
        await syncFolder(app.getPath('userData'))
        return preferences
      }
      if (
        operation === 'get' &&
        (value === null || typeof value === 'string')
      ) {
        try {
          return readAutosavePreferences(await readFile(path, 'utf8'))
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
            (value !== null && value.length > 1024)
          )
            return off
          const preferences = readAutosavePreferences(value)
          // Leave legacy storage intact if migration fails; retry next launch.
          try {
            return value === null ? preferences : await save(preferences)
          } catch {
            return off
          }
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
