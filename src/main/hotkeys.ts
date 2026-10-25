import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import {
  defaultHotkeys,
  HOTKEYS_VERSION,
  type Hotkeys,
  restoreHotkeys,
  validateHotkeys,
} from '../shared/hotkeys'
import { writeText } from './files'

export let hotkeys = defaultHotkeys(process.platform)
let saving = false

export async function loadHotkeys(): Promise<void> {
  try {
    const stored = JSON.parse(
      await readFile(join(app.getPath('userData'), 'hotkeys.json'), 'utf8'),
    ) as Record<string, unknown>
    hotkeys = restoreHotkeys(stored, process.platform)
    if (stored._version !== HOTKEYS_VERSION) await saveHotkeys(hotkeys)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('could not load hotkeys:', error)
  }
}

export async function saveHotkeys(value: unknown): Promise<Hotkeys> {
  const next = validateHotkeys(value, process.platform)
  if (saving)
    throw new Error(
      'Shortcuts are still saving. Wait a moment, then try again.',
    )
  saving = true
  try {
    const path = join(app.getPath('userData'), 'hotkeys.json')
    await writeText(
      path,
      JSON.stringify({ ...next, _version: HOTKEYS_VERSION }),
    )
    hotkeys = next
    return hotkeys
  } finally {
    saving = false
  }
}
