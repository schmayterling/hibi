import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { writeText } from './files'

let hidden = false
let preference = false
let writing: Promise<void> = Promise.resolve()
const path = () => join(app.getPath('userData'), 'window-controls.json')

/** Keep every window consistent until the next app launch. */
export const windowControlsHidden = () => hidden
export const getHideWindowControls = () => preference

function readPreference(value: unknown): boolean {
  if (
    value !== null &&
    typeof value === 'object' &&
    'hidden' in value &&
    typeof value.hidden === 'boolean'
  )
    return value.hidden
  throw new TypeError('Expected a boolean hidden preference.')
}

export async function loadWindowControls() {
  if (process.platform !== 'linux') return
  const location = path()
  try {
    preference = readPreference(JSON.parse(await readFile(location, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error(
        'Could not load window controls preferences:',
        location,
        error,
      )
  }
  hidden = preference
}

export function saveHideWindowControls(input: unknown) {
  if (process.platform !== 'linux' || typeof input !== 'boolean')
    throw new Error('Invalid window controls setting.')
  writing = writing
    .catch(() => {})
    .then(async () => {
      const location = path()
      try {
        await writeText(location, JSON.stringify({ hidden: input }))
      } catch (error) {
        console.error(
          'Could not save window controls preferences:',
          location,
          error,
        )
        throw new Error(
          'Could not save your window controls preference. Try again.',
          {
            cause: error,
          },
        )
      }
      preference = input
    })
  return writing
}
