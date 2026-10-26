import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const sweeps = new Map<string, Promise<void>>()

/** A profile owns its export scratch; another running profile is never swept. */
export function sweepSiteScratch(profile: string) {
  const directory = join(profile, 'site-exports')
  let sweep = sweeps.get(directory)
  if (!sweep) {
    sweep = (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if (!(await lstat(directory)).isDirectory())
        throw new Error('Could not prepare the documentation export.')
      for (const entry of await readdir(directory, { withFileTypes: true }))
        if (entry.isDirectory() && entry.name.startsWith('hibi-site-'))
          await rm(join(directory, entry.name), {
            recursive: true,
            force: true,
          })
    })().finally(() => sweeps.delete(directory))
    sweeps.set(directory, sweep)
  }
  return sweep
}

export async function createSiteScratch(profile: string) {
  await sweepSiteScratch(profile)
  return mkdtemp(join(profile, 'site-exports', 'hibi-site-'))
}
