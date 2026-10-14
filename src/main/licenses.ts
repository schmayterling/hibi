import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { LicenseInfo } from '../shared/about'
import { getAddonLicenses } from './addons'

let catalog: Promise<(LicenseInfo & { text: string })[]> | undefined
function load() {
  catalog ??= readFile(join(app.getAppPath(), 'out/licenses.json'), 'utf8')
    .then((text) => JSON.parse(text) as (LicenseInfo & { text: string })[])
    .catch((error) => {
      catalog = undefined
      throw error
    })
  return catalog.then(async (entries) => [
    ...entries,
    ...(await getAddonLicenses()),
  ])
}
export async function listLicenses(): Promise<LicenseInfo[]> {
  return (await load()).map(({ text: _text, ...info }) => info)
}
export async function readLicense(id: unknown): Promise<string> {
  if (typeof id !== 'string') throw new Error('Choose a license to view.')
  const license = (await load()).find((entry) => entry.id === id)
  if (!license) throw new Error('This license is no longer available.')
  return license.text
}
