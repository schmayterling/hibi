import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * Clone this checkout's production dependencies into `app`'s node_modules.
 * electron-builder 26 packs only the direct dependencies when an app's
 * node_modules links elsewhere, and that package cannot start.
 */
export async function cloneProductionModules(app) {
  const modules = resolve('node_modules')
  // npm reports problems such as extraneous packages with a failing status.
  const { stdout } = spawnSync(
    'npm',
    ['ls', '--omit=dev', '--all', '--parseable'],
    { encoding: 'utf8', maxBuffer: 1 << 26 },
  )
  const names = (stdout ?? '')
    .split('\n')
    .filter((path) => path.startsWith(`${modules}/`))
    .map((path) => relative(modules, path))
    // Nested modules come with the package that holds them.
    .filter((name) => !name.includes('/node_modules/'))
  if (!names.length) throw new Error('npm listed no production dependencies.')
  for (const name of names) {
    const target = join(app, 'node_modules', name)
    await mkdir(dirname(target), { recursive: true })
    // APFS clones the files instead of copying them.
    execFileSync('cp', ['-cR', join(modules, name), target])
  }
}
