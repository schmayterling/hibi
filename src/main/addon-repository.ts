import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  addonPackageUrl,
  MAX_ADDON_BYTES,
  validAddonInventoryPath,
} from '../shared/addon-package.ts'

const execute = promisify(execFile)
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const githubError = () =>
  new Error(
    'Use a GitHub repository URL, or the URL of a folder in a GitHub repository.',
  )
const refPart = (part: string) =>
  validAddonInventoryPath(part) && !/^[-.]|[\s^~[]|@\{|\.\.|\.lock$/.test(part)

/** Parse github.com/OWNER/REPO[/tree/REF[/PATH]]; null for other GitHub pages. */
function githubSource(page: URL) {
  if (page.host !== 'github.com' && page.host !== 'www.github.com') return null
  const [owner = '', name = '', view, ...rest] = page.pathname
    .replace(/\/$/, '')
    .split('/')
    .slice(1)
  const repository = name.replace(/\.git$/i, '')
  if (view !== undefined && view !== 'tree') return null
  if (
    !/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(owner) ||
    !/^[\w.-]{1,100}$/.test(repository) ||
    /^\.+$/.test(repository)
  )
    throw githubError()
  const url = `https://github.com/${owner}/${repository}.git`
  if (!view) return { url, targets: [] }
  let tree: string[]
  try {
    tree = decodeURIComponent(rest.join('/')).split('/')
  } catch {
    throw githubError()
  }
  // Refs may contain slashes, so keep every valid REF/PATH split for one ls-remote.
  const targets = tree
    .map((_, index) => ({
      ref: tree.slice(0, index + 1).join('/'),
      path: tree.slice(index + 1).join('/'),
    }))
    .filter(
      ({ path }, index) =>
        tree.slice(0, index + 1).every(refPart) &&
        (!path || validAddonInventoryPath(path)),
    )
  const commit =
    COMMIT.test(tree[0] ?? '') && targets[0]?.ref === tree[0]
      ? targets[0]
      : undefined
  if (
    tree.length > 32 ||
    !targets.length ||
    (COMMIT.test(tree[0] ?? '') && !commit)
  )
    throw githubError()
  return commit ? { url, commit, targets: [] } : { url, targets }
}

export function repositoryUrl(value: unknown) {
  const url = addonPackageUrl(value)
  if (url.hostname === 'github.com' || url.hostname === 'www.github.com')
    return !!githubSource(url)
  return (
    /\.git\/?$/i.test(url.pathname) ||
    (url.hostname === 'codeberg.org' &&
      /^\/[^/]+\/[^/]+\/?$/.test(url.pathname)) ||
    (url.hostname === 'gitlab.com' &&
      !url.pathname.includes('/-/') &&
      !/\.zip$/i.test(url.pathname))
  )
}

/** Shallow fetch + archive: no checkout filters, attributes, hooks, submodules, or build scripts. */
export async function downloadRepository(
  value: unknown,
  temporary: string,
  run = execute,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const url = addonPackageUrl(value)
  const github = githubSource(url)
  if (
    !github &&
    (url.hostname === 'github.com' || url.hostname === 'www.github.com')
  )
    throw githubError()
  if (['gitlab.com', 'codeberg.org'].includes(url.hostname))
    url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\.git$/, '')}.git`
  const remote = github?.url ?? url.href
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
    GIT_LITERAL_PATHSPECS: '1',
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
  const options = { cwd: temporary, env, windowsHide: true, signal }
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
  let monitor: ReturnType<typeof setInterval> | undefined
  let failure: Error | undefined
  try {
    await run('git', [...config, 'init', '--bare', '-q', repository], {
      ...options,
      timeout: 10000,
      maxBuffer: 64 * 1024,
    })
    let ref = 'HEAD',
      path = ''
    const targets = github?.targets ?? []
    if (github?.commit) ({ ref, path } = github.commit)
    else if (targets.length) {
      const { stdout } = await run(
        'git',
        [
          ...config,
          'ls-remote',
          '--',
          remote,
          ...targets.flatMap((target) => [
            `refs/heads/${target.ref}`,
            `refs/tags/${target.ref}`,
          ]),
        ],
        { ...options, timeout: 20000, maxBuffer: 1024 * 1024 },
      )
      const refs = new Set(
        String(stdout)
          .split('\n')
          .map((line) => line.split('\t')[1]),
      )
      const found = targets
        .flatMap((target) =>
          [`refs/heads/${target.ref}`, `refs/tags/${target.ref}`]
            .filter((name) => refs.has(name))
            .map((name) => ({ ref: name, path: target.path })),
        )
        .at(-1)
      if (!found) {
        failure = new Error(
          'Could not find this branch or tag in the GitHub repository.',
        )
        throw failure
      }
      ;({ ref, path } = found)
    }
    monitor = setInterval(() => {
      if (checking) return
      checking = true
      void checkSize()
        .catch(() => abort.abort())
        .finally(() => {
          checking = false
        })
    }, 200)
    await run(
      'git',
      [
        ...config,
        '-C',
        repository,
        'fetch',
        '--depth=1',
        '--no-tags',
        '--',
        remote,
        ref,
      ],
      {
        ...options,
        timeout: 30000,
        signal: signal ? AbortSignal.any([abort.signal, signal]) : abort.signal,
        maxBuffer: 1024 * 1024,
      },
    )
    clearInterval(monitor)
    await checkSize()
    const commit = (
      await readFile(join(repository, 'FETCH_HEAD'), 'utf8').catch(() => '')
    ).split('\t')[0]
    // A requested commit is binding: never archive anything else.
    if (
      !commit ||
      !COMMIT.test(commit) ||
      (COMMIT.test(ref) && commit !== ref)
    ) {
      failure = new Error('The repository returned an unexpected commit.')
      throw failure
    }
    // The highest-priority attributes keep archived bytes and files identical to the commit.
    await mkdir(join(repository, 'info'), { recursive: true })
    await writeFile(
      join(repository, 'info', 'attributes'),
      '* -text !eol -filter -ident -export-subst -export-ignore !working-tree-encoding\n',
    )
    const { stdout } = await run(
      'git',
      [
        ...config,
        '-C',
        repository,
        'archive',
        '--format=zip',
        commit,
        ...(path ? ['--', path] : []),
      ],
      {
        ...options,
        timeout: 20000,
        maxBuffer: MAX_ADDON_BYTES,
        encoding: 'buffer',
      },
    )
    return {
      zip: stdout as Buffer,
      host: url.host,
      commit,
      ...(path ? { path } : {}),
    }
  } catch (error) {
    signal?.throwIfAborted()
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('Install Git to add addons from repositories.')
    if (oversized)
      throw new Error(
        'This repository exceeds the limit of 5,000 entries or 64 MiB, or contains a symbolic link.',
      )
    if (failure) throw failure
    throw new Error(
      'Could not read this Git repository. Use a public HTTPS repository containing a ready-to-install addon.',
      { cause: error },
    )
  } finally {
    clearInterval(monitor)
  }
}
