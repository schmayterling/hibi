import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { addonPackageUrl, MAX_ADDON_BYTES } from '../shared/addon-package.ts'

const execute = promisify(execFile)
export function repositoryUrl(value: unknown) {
  const url = addonPackageUrl(value)
  return (
    /\.git\/?$/i.test(url.pathname) ||
    (['github.com', 'codeberg.org'].includes(url.hostname) &&
      /^\/[^/]+\/[^/]+\/?$/.test(url.pathname)) ||
    (url.hostname === 'gitlab.com' &&
      !url.pathname.includes('/-/') &&
      !/\.zip$/i.test(url.pathname))
  )
}

/** Bare clone + archive: no checkout filters, hooks, submodules, or build scripts. */
export async function downloadRepository(
  value: unknown,
  temporary: string,
  run = execute,
  path?: string,
) {
  if (path !== undefined && !/^addons\/[a-z][a-z0-9-]*$/.test(path))
    throw new Error('The garden addon path is invalid.')
  const url = addonPackageUrl(value)
  if (['github.com', 'gitlab.com', 'codeberg.org'].includes(url.hostname))
    url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\.git$/, '')}.git`
  const repository = join(temporary, 'repository.git')
  const empty = join(temporary, 'empty')
  await mkdir(empty, { mode: 0o700 })
  const emptyConfig = join(temporary, 'git-config')
  await writeFile(emptyConfig, '', { mode: 0o600 })
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  )
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  })
  const config = [
    `core.hooksPath=${empty}`,
    `init.templateDir=${empty}`,
    'core.fsmonitor=false',
    'credential.helper=',
    'core.askPass=',
    'gc.auto=0',
    'maintenance.auto=false',
    'submodule.recurse=false',
    'fetch.recurseSubmodules=false',
    'protocol.allow=never',
    'protocol.https.allow=always',
    'http.followRedirects=false',
  ].flatMap((setting) => ['-c', setting])
  const abort = new AbortController()
  let oversized = false,
    checking = false
  async function checkSize() {
    let size = 0,
      entries = 0
    async function walk(path: string) {
      for (const entry of await readdir(path, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return []
        },
      )) {
        const file = join(path, entry.name)
        const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return null
        })
        if (!stat) continue
        size += stat.size
        if (
          ++entries > 5000 ||
          size > 64 * 1024 * 1024 ||
          stat.isSymbolicLink()
        ) {
          oversized = true
          throw new Error(
            'This repository exceeds the limit of 5,000 entries or 64 MiB, or contains a symbolic link.',
          )
        }
        if (stat.isDirectory()) await walk(file)
      }
    }
    await walk(repository)
  }
  const monitor = setInterval(() => {
    if (checking) return
    checking = true
    void checkSize()
      .catch(() => abort.abort())
      .finally(() => {
        checking = false
      })
  }, 200)
  try {
    await run(
      'git',
      [
        ...config,
        'clone',
        '--bare',
        '--depth=1',
        '--single-branch',
        '--no-tags',
        '--',
        url.href,
        repository,
      ],
      {
        cwd: temporary,
        env,
        windowsHide: true,
        timeout: 30000,
        signal: abort.signal,
        maxBuffer: 1024 * 1024,
      },
    )
    clearInterval(monitor)
    await checkSize()
    const { stdout } = await run(
      'git',
      [
        ...config,
        '-C',
        repository,
        'archive',
        '--format=zip',
        path ? `HEAD:${path}` : 'HEAD',
      ],
      {
        env,
        windowsHide: true,
        timeout: 20000,
        maxBuffer: MAX_ADDON_BYTES,
        encoding: 'buffer',
      },
    )
    return { zip: stdout, host: url.host }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('Install Git to add addons from repositories.')
    if (oversized)
      throw new Error(
        'This repository exceeds the limit of 5,000 entries or 64 MiB, or contains a symbolic link.',
      )
    throw new Error(
      'Could not read this Git repository. Use a public HTTPS repository containing a ready-to-install addon.',
      { cause: error },
    )
  } finally {
    clearInterval(monitor)
  }
}
