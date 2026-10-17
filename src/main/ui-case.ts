import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { UiCase } from '../shared/ui-case'
import { retryRename } from './atomic-rename'

let value: UiCase = 'sentence'
let writing: Promise<void> = Promise.resolve()
const path = () => join(app.getPath('userData'), 'ui-case.json')
export const getUiCase = () => value
export async function loadUiCase() {
  try {
    value =
      JSON.parse(await readFile(path(), 'utf8')) === 'lowercase'
        ? 'lowercase'
        : 'sentence'
  } catch {
    value = 'sentence'
  }
}
export function saveUiCase(input: unknown) {
  if (input !== 'sentence' && input !== 'lowercase')
    throw new Error('Invalid interface casing.')
  value = input
  writing = writing
    .catch(() => {})
    .then(async () => {
      await writeFile(`${path()}.tmp`, JSON.stringify(input), { mode: 0o600 })
      await retryRename(() => rename(`${path()}.tmp`, path()))
    })
  return writing
}
