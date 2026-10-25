import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { UiCase } from '../shared/ui-case'
import { writeText } from './files'

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
      await writeText(path(), JSON.stringify(input))
    })
  return writing
}
