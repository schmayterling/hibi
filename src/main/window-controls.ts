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

export async function loadWindowControls() {
  if (process.platform !== 'linux') return
  try {
    preference = JSON.parse(await readFile(path(), 'utf8')) === true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('Could not load window controls:', error)
  }
  hidden = preference
}

export function saveHideWindowControls(input: unknown) {
  if (process.platform !== 'linux' || typeof input !== 'boolean')
    throw new Error('Invalid window controls setting.')
  writing = writing
    .catch(() => {})
    .then(async () => {
      await writeText(path(), JSON.stringify(input))
      preference = input
    })
  return writing
}
