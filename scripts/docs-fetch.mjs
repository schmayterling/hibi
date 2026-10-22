import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validAddonPath } from '../src/shared/addon-package.ts'

const repository = 'https://github.com/hibigarden/docs.git'
const maxFileBytes = 8 * 1024 * 1024
const maxBytes = 64 * 1024 * 1024
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const publicPath = (path) =>
  validAddonPath(path) &&
  path.startsWith('docs/') &&
  !/^docs\/(?:ai-agents|licenses)(?:\/|$)/i.test(path) &&
  !/^docs\/development\/addon-api-reference(?:\/|$)/i.test(path) &&
  /\.(md|png|jpe?g|gif|webp|avif|svg)$/i.test(path)

const git = (root, ...args) =>
  execFileSync('git', [`--git-dir=${root}`, ...args], {
    cwd: root,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
    ),
    maxBuffer: maxFileBytes,
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
async function stat(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

/** Check every parent, including docs itself; neither reads nor writes follow links. */
async function target(root, path) {
  let current = root
  const parts = path.split('/')
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const info = await stat(current)
    if (
      info &&
      (info.isSymbolicLink() ||
        (index < parts.length - 1 ? !info.isDirectory() : !info.isFile()))
    )
      throw new Error(
        `Documentation path is not a regular file or directory: ${path}`,
      )
  }
  return current
}

async function localFiles(source) {
  const files = new Map()
  let total = 0
  async function collect(path) {
    const absolute = join(source, path)
    const info = await lstat(absolute)
    if (info.isSymbolicLink())
      throw new Error(`Documentation cannot contain links: ${path}`)
    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort())
        await collect(`${path}/${name}`)
    } else {
      if (info.isFile() && /\/(?:\.DS_Store|Thumbs\.db)$/.test(path)) return
      if (!info.isFile() || !publicPath(path) || info.size > maxFileBytes)
        throw new Error(`Invalid public documentation file: ${path}`)
      total += info.size
      if (files.size >= 2000 || total > maxBytes)
        throw new Error('The documentation snapshot is too large.')
      files.set(path, await readFile(absolute))
    }
  }
  await collect('docs')
  return files
}

async function revisionFiles(root, revision) {
  const cache = join(root, '.cache/docs.git')
  await target(root, '.cache/docs.git/HEAD')
  if (!(await stat(join(cache, 'HEAD')))) {
    await mkdir(cache, { recursive: true })
    git(cache, 'init', '--bare', '--quiet')
  }
  try {
    git(cache, 'cat-file', '-e', `${revision}^{commit}`)
  } catch {
    git(
      cache,
      'fetch',
      '--no-write-fetch-head',
      '--depth=1',
      '--no-tags',
      repository,
      `${revision}:refs/hibi/docs/${revision}`,
    )
  }
  const files = new Map()
  let total = 0
  for (const row of git(cache, 'ls-tree', '-rlz', revision, '--', 'docs')
    .toString()
    .split('\0')
    .filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f\d]{40})\s+(\d+)\t(.+)$/s.exec(
      row,
    )
    if (match && /\/(?:\.DS_Store|Thumbs\.db)$/.test(match[4])) continue
    if (!match || !publicPath(match[4]) || Number(match[3]) > maxFileBytes)
      throw new Error(
        'The documentation snapshot contains an invalid or reserved path.',
      )
    total += Number(match[3])
    if (files.size >= 2000 || total > maxBytes)
      throw new Error('The documentation snapshot is too large.')
    files.set(match[4], git(cache, 'cat-file', 'blob', match[2]))
  }
  return files
}

async function savedSnapshot(root) {
  const path = await target(root, 'docs/.snapshot.json')
  if (!(await stat(path))) return null
  const saved = JSON.parse(await readFile(path, 'utf8'))
  if (
    !saved ||
    typeof saved.revision !== 'string' ||
    !saved.files ||
    Array.isArray(saved.files) ||
    !Object.entries(saved.files).every(
      ([path, hash]) => publicPath(path) && /^[a-f\d]{64}$/.test(hash),
    ) ||
    !saved.files['docs/README.md']
  )
    throw new Error('The documentation snapshot record is invalid.')
  return saved
}

function warnDrafts(paths) {
  if (paths.length)
    console.warn(
      `Using locally modified documentation: ${paths.slice(0, 5).join(', ')}. Move drafts into your docs checkout before changing docs-revision.`,
    )
}

async function verifySnapshot(root, saved, hashes, unchanged) {
  const incoming = new Map(
    Object.entries(hashes).map(([path, hash]) => [path.toLowerCase(), hash]),
  )
  const drafts = []
  for (const [path, hash] of Object.entries(saved?.files ?? {})) {
    const file = await target(root, path)
    const info = await stat(file)
    if (!info) continue
    const current =
      info.size <= maxFileBytes ? digest(await readFile(file)) : null
    if (
      current === null ||
      (!unchanged &&
        current !== hash &&
        current !== incoming.get(path.toLowerCase()))
    )
      throw new Error(
        `Documentation has local changes: ${path}. Move this file into your docs checkout or aside, then rerun npm run docs.`,
      )
    if (unchanged && current !== hash) drafts.push(path)
  }
  warnDrafts(drafts)
}

async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.hibi-${randomUUID()}`
  try {
    await writeFile(temporary, bytes)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Restore authored docs only; licenses, internal notes, and generated references remain app-owned. */
export async function prepareDocumentation(
  root = process.cwd(),
  source = process.env.HIBI_DOCS_SOURCE,
) {
  root = resolve(root)
  if (source && !isAbsolute(source))
    throw new Error('HIBI_DOCS_SOURCE must be an absolute docs checkout path.')
  const saved = await savedSnapshot(root)
  const revision = source
    ? `local:${resolve(source)}`
    : (await readFile(join(root, 'docs-revision'), 'utf8')).trim()
  if (!source && !/^[a-f\d]{40}$/.test(revision))
    throw new Error(
      'docs-revision must contain a full documentation commit SHA.',
    )
  if (!source && saved?.revision === revision) {
    let complete = true
    const drafts = []
    for (const path of Object.keys(saved.files)) {
      const info = await stat(await target(root, path))
      if (!info) complete = false
      else if (info.size > maxFileBytes)
        throw new Error(`Documentation file is too large: ${path}`)
      else if (digest(await readFile(join(root, path))) !== saved.files[path])
        drafts.push(path)
    }
    if (complete) {
      warnDrafts(drafts)
      return
    }
  }

  const files = source
    ? await localFiles(source)
    : await revisionFiles(root, revision)
  if (!files.has('docs/README.md'))
    throw new Error('The documentation snapshot is missing docs/README.md.')
  const hashes = Object.fromEntries(
    [...files].map(([path, bytes]) => [path, digest(bytes)]),
  )
  const unchanged =
    saved?.revision === revision &&
    Object.keys(saved.files).length === files.size &&
    Object.entries(hashes).every(([path, hash]) => saved.files[path] === hash)
  await verifySnapshot(root, saved, hashes, unchanged)
  const incomingNames = [...files.keys()]
  if (
    new Set(incomingNames.map((name) => name.toLowerCase())).size !==
    incomingNames.length
  )
    throw new Error('The documentation snapshot has conflicting paths.')
  const previousNames = Object.keys(saved?.files ?? {})
  const owned = new Map(
    previousNames.map((name) => [name.toLowerCase(), saved.files[name]]),
  )
  const names = [
    ...previousNames.filter((name) => !files.has(name)),
    ...incomingNames,
  ]

  const backups = new Map()
  const updates = new Map()
  for (const path of names) {
    const file = await target(root, path)
    const info = await stat(file)
    if (info && info.size > maxFileBytes)
      throw new Error(`Documentation file is too large: ${path}`)
    const previous = info ? await readFile(file) : null
    const next = files.get(path) ?? null
    if (previous === null && next === null) continue
    if (
      previous &&
      !saved?.files[path] &&
      (!next || !previous.equals(next)) &&
      digest(previous) !== owned.get(path.toLowerCase())
    )
      throw new Error(`Documentation would overwrite an existing file: ${path}`)
    if (
      previous &&
      next &&
      (saved?.files[path] || !owned.has(path.toLowerCase())) &&
      (previous.equals(next) || (unchanged && saved?.files[path]))
    )
      continue
    backups.set(path, previous)
    updates.set(path, next)
  }
  const record = `${JSON.stringify(
    {
      revision,
      files: hashes,
    },
    null,
    2,
  )}\n`
  const applied = []
  try {
    for (const [path, bytes] of updates) {
      const file = await target(root, path)
      applied.push(path)
      if (bytes) await atomicWrite(file, bytes)
      else await rm(file)
    }
    await atomicWrite(join(root, 'docs/.snapshot.json'), record)
  } catch (error) {
    for (const path of applied.reverse()) {
      const bytes = backups.get(path)
      if (bytes) await atomicWrite(join(root, path), bytes)
      else await rm(join(root, path), { force: true })
    }
    throw error
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await prepareDocumentation()
