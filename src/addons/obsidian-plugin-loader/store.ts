import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import {
  type InstalledObsidianPlugin,
  type ObsidianPluginManifest,
  parseObsidianManifest,
  wrapObsidianPlugin,
} from './package.ts'

const limits = {
  'manifest.json': 64 * 1024,
  'main.js': 5 * 1024 * 1024,
  'styles.css': 1024 * 1024,
  'data.json': 1024 * 1024,
} as const

async function writeText(path: string, content: string) {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temp, 'wx', 0o600)
    try {
      await file.writeFile(content, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temp, path)
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

type RecordFile = {
  manifest: ObsidianPluginManifest
  hash: string
  enabled: boolean
  hasStyles: boolean
}

async function regularFile(path: string, limit: number) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw new Error('This Obsidian plugin contains an unsupported file.')
  const bytes = await readFile(path)
  if (bytes.byteLength > limit)
    throw new Error('This Obsidian plugin contains an oversized file.')
  return bytes
}

async function record(root: string, id: string): Promise<RecordFile> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))
    throw new Error('Invalid Obsidian plugin ID.')
  const folder = join(root, id)
  const stat = await lstat(folder)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('This Obsidian plugin folder is invalid.')
  const value = JSON.parse(
    (
      await regularFile(join(folder, 'package.json'), limits['manifest.json'])
    ).toString('utf8'),
  ) as RecordFile
  const manifest = parseObsidianManifest(value.manifest)
  if (
    manifest.id !== id ||
    !/^[a-f\d]{64}$/.test(value.hash) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.hasStyles !== 'boolean'
  )
    throw new Error('This Obsidian plugin package is invalid.')
  return { ...value, manifest }
}

function descriptor(value: RecordFile): InstalledObsidianPlugin {
  const base = `app://hibi/obsidian-plugins/${value.manifest.id}/${value.hash}`
  return {
    manifest: value.manifest,
    hash: value.hash,
    enabled: value.enabled,
    url: `${base}/main.js`,
    styleUrl: value.hasStyles ? `${base}/styles.css` : null,
  }
}

export async function listObsidianPlugins(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const entries = await readdir(root, { withFileTypes: true })
  const installed: InstalledObsidianPlugin[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    installed.push(descriptor(await record(root, entry.name)))
  }
  return installed.sort((a, b) =>
    a.manifest.name.localeCompare(b.manifest.name),
  )
}

export async function readObsidianPackage(source: string) {
  const directory = await lstat(source)
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error('Choose a regular Obsidian plugin folder.')
  const manifestBytes = await regularFile(
    join(source, 'manifest.json'),
    limits['manifest.json'],
  )
  let manifest: ObsidianPluginManifest
  try {
    manifest = parseObsidianManifest(JSON.parse(manifestBytes.toString('utf8')))
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error('This folder has no valid Obsidian plugin manifest.')
    throw error
  }
  const main = await regularFile(join(source, 'main.js'), limits['main.js'])
  new TextDecoder('utf-8', { fatal: true }).decode(main)
  const styles = await regularFile(
    join(source, 'styles.css'),
    limits['styles.css'],
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  const hash = createHash('sha256')
    .update(manifestBytes)
    .update(main)
    .update(styles ?? '')
    .digest('hex')
  return { manifest, main, styles, hash }
}

export async function installObsidianPlugin(
  root: string,
  source: Awaited<ReturnType<typeof readObsidianPackage>>,
) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const destination = join(root, source.manifest.id)
  const staging = join(root, `.staging-${randomUUID()}`)
  const backup = join(root, `.backup-${randomUUID()}`)
  await mkdir(staging, { mode: 0o700 })
  let moved = false
  try {
    const previous = await record(root, source.manifest.id).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      },
    )
    const next: RecordFile = {
      manifest: source.manifest,
      hash: source.hash,
      enabled: false,
      hasStyles: Boolean(source.styles),
    }
    await writeFile(join(staging, 'package.json'), JSON.stringify(next), {
      mode: 0o600,
    })
    await writeFile(join(staging, 'main.js'), source.main, { mode: 0o600 })
    if (source.styles)
      await writeFile(join(staging, 'styles.css'), source.styles, {
        mode: 0o600,
      })
    if (previous) {
      const data = await regularFile(
        join(destination, 'data.json'),
        limits['data.json'],
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (data)
        await writeFile(join(staging, 'data.json'), data, { mode: 0o600 })
      await rename(destination, backup)
      moved = true
    }
    try {
      await rename(staging, destination)
    } catch (error) {
      if (moved) await rename(backup, destination)
      throw error
    }
    return { plugin: descriptor(next), backup: moved ? backup : null }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

export async function setObsidianPluginEnabled(
  root: string,
  id: string,
  enabled: boolean,
) {
  const current = await record(root, id)
  await writeText(
    join(root, id, 'package.json'),
    JSON.stringify({ ...current, enabled }),
  )
  return descriptor({ ...current, enabled })
}

export async function readObsidianPluginData(root: string, id: string) {
  await record(root, id)
  const bytes = await regularFile(
    join(root, id, 'data.json'),
    limits['data.json'],
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  return bytes ? JSON.parse(bytes.toString('utf8')) : null
}

export async function installedObsidianPluginPath(root: string, id: string) {
  await record(root, id)
  return join(root, id)
}

export async function writeObsidianPluginData(
  root: string,
  id: string,
  value: unknown,
) {
  await record(root, id)
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded) > limits['data.json'])
    throw new Error('Plugin data must be JSON under 1 MiB.')
  await writeText(join(root, id, 'data.json'), encoded)
}

export async function obsidianPluginAsset(root: string, url: string) {
  const parsed = new URL(url)
  const match =
    /^\/obsidian-plugins\/([a-z0-9][a-z0-9_-]{0,63})\/([a-f\d]{64})\/(main\.js|styles\.css)$/.exec(
      parsed.pathname,
    )
  if (parsed.protocol !== 'app:' || parsed.host !== 'hibi' || !match)
    return null
  const [, id, hash, name] = match
  if (!id || !hash || (name !== 'main.js' && name !== 'styles.css')) return null
  const current = await record(root, id)
  if (
    !current.enabled ||
    current.hash !== hash ||
    (name === 'styles.css' && !current.hasStyles)
  )
    return null
  const bytes = await regularFile(join(root, id, name), limits[name])
  return name === 'main.js'
    ? wrapObsidianPlugin(bytes.toString('utf8'), `${id}:${hash}`)
    : bytes.toString('utf8')
}
