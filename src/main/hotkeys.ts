import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import {
  defaultHotkeys,
  HOTKEYS_VERSION,
  type Hotkeys,
  restoreHotkeys,
  validateHotkeys,
} from '../shared/hotkeys'
import { retryRename } from './atomic-rename'

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
    await writeFile(
      `${path}.tmp`,
      JSON.stringify({ ...next, _version: HOTKEYS_VERSION }),
      { mode: 0o600 },
    )
    await retryRename(() => rename(`${path}.tmp`, path))
    hotkeys = next
    return hotkeys
  } finally {
    saving = false
  }
}
