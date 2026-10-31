import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * Clone this checkout's production dependencies into `app`'s node_modules.
 * electron-builder 26 packs only the direct dependencies when an app's
 * node_modules links elsewhere, and that package cannot start.
 */
export async function cloneProductionModules(app) {
  const modules = resolve('node_modules')
  // The lockfile, not `npm ls`: through a linked node_modules npm reports
  // most of the tree missing or extraneous, development packages included.
  const { packages } = JSON.parse(await readFile('package-lock.json', 'utf8'))
  let copied = 0
  for (const [path, entry] of Object.entries(packages)) {
    const name = path.slice('node_modules/'.length)
    // Nested modules come with the package that holds them.
    if (!path.startsWith('node_modules/') || name.includes('/node_modules/'))
      continue
    if (entry.dev || entry.devOptional) continue
    const source = join(modules, name)
    if (!existsSync(source)) {
      // Optional packages for other platforms are never installed.
      if (entry.optional) continue
      throw new Error(`The production dependency ${name} is not installed.`)
    }
    const target = join(app, 'node_modules', name)
    await mkdir(dirname(target), { recursive: true })
    // APFS clones the files instead of copying them.
    execFileSync('cp', ['-cR', source, target])
    copied++
  }
  if (!copied) throw new Error('The lockfile lists no production dependencies.')
}
