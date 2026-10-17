import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import ignore from 'ignore'
import type { WorkspaceManifest } from '../shared/workspace-settings'
import { retryRename } from './atomic-rename.ts'

export const WORKSPACE_MANIFEST = '.hibi/workspace.json'
export const WORKSPACE_IGNORE = '.hibi/ignore'
export const WORKSPACE_LAYOUT = '.hibi/layout.json'
const legacyNames = {
  [WORKSPACE_MANIFEST]: '.hibi.json',
  [WORKSPACE_IGNORE]: '.hibiignore',
}
type MetadataFile = keyof typeof legacyNames | typeof WORKSPACE_LAYOUT

async function metadataDirectory(root: string, create = false) {
  const directory = join(root, '.hibi')
  if (create)
    await mkdir(directory, { mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      },
    )
  try {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Use a regular folder for .hibi, not a symbolic link.')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function readText(root: string, name: string, limit = 65536) {
  const path = join(root, name)
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
      throw new Error(
        `Cannot read ${name}. Use a text file smaller than ${limit / 1024} KiB.`,
      )
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
export async function readWorkspaceText(
  root: string,
  name: keyof typeof legacyNames,
) {
  const current = (await metadataDirectory(root))
    ? await readText(root, name)
    : null
  return current ?? (await readText(root, legacyNames[name])) ?? ''
}
export const WORKSPACE_LAYOUT_LIMIT = 1048576
// Oversized layout files already reported, by path, until they change.
const oversized = new Map<string, string>()
export async function readWorkspaceLayoutText(root: string) {
  if (!(await metadataDirectory(root))) return null
  const path = join(root, WORKSPACE_LAYOUT)
  const info = await lstat(path).catch(() => null)
  // Sizes are disposable; an oversized file must not block every later write.
  if (info?.isFile() && info.size > WORKSPACE_LAYOUT_LIMIT) {
    const version = `${info.size}:${info.mtimeMs}`
    if (oversized.get(path) !== version)
      console.warn(`${WORKSPACE_LAYOUT} is too large; table sizes were reset.`)
    oversized.set(path, version)
    return null
  }
  return await readText(root, WORKSPACE_LAYOUT, WORKSPACE_LAYOUT_LIMIT)
}
export function validateManifest(input: unknown): WorkspaceManifest {
  const value = input as WorkspaceManifest | null
  if (
    !value ||
    value.version !== 1 ||
    !['name', 'description', 'icon', 'defaultFile'].every(
      (key) => typeof value[key as keyof WorkspaceManifest] === 'string',
    )
  )
    throw new Error('The workspace manifest is invalid.')
  if (
    !value.name.trim() ||
    value.name.length > 120 ||
    value.description.length > 2000 ||
    !/^[a-zA-Z0-9._:-]{0,100}$/.test(value.icon) ||
    value.defaultFile.length > 1024 ||
    Array.from(value.name + value.defaultFile).some(
      (character) => character.charCodeAt(0) < 32,
    ) ||
    value.defaultFile.includes('\\') ||
    isAbsolute(value.defaultFile) ||
    (value.defaultFile &&
      value.defaultFile
        .split('/')
        .some((part) => !part || part === '.' || part === '..'))
  )
    throw new Error('Check the workspace name, icon, and default file path.')
  return {
    version: 1,
    name: value.name.trim(),
    description: value.description,
    icon: value.icon,
    defaultFile: value.defaultFile,
  }
}
export async function workspaceMetadata(root: string) {
  const [source, rules] = await Promise.all([
    readWorkspaceText(root, WORKSPACE_MANIFEST),
    readWorkspaceText(root, WORKSPACE_IGNORE),
  ])
  return {
    manifest: source ? validateManifest(JSON.parse(source)) : null,
    manifestRevision: createHash('sha256')
      .update(source)
      .update('\0')
      .update(rules)
      .digest('hex'),
    ignore: rules,
  }
}
export async function workspaceIgnore(root: string) {
  return ignore().add(await readWorkspaceText(root, WORKSPACE_IGNORE))
}
export async function writeWorkspaceText(
  root: string,
  name: MetadataFile,
  content: string,
  exclusive = false,
) {
  await metadataDirectory(root, true)
  const path = join(root, name)
  if (exclusive) {
    await writeFile(path, content, { flag: 'wx', mode: 0o600 })
    return
  }
  // Metadata is never written through symlinks, including abandoned temporary files.
  const temporary = join(
    dirname(path),
    `.${basename(name)}.${crypto.randomUUID()}.tmp`,
  )
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
  try {
    await retryRename(() => rename(temporary, path))
  } catch (error) {
    await import('node:fs/promises').then((fs) =>
      fs.rm(temporary, { force: true }),
    )
    throw error
  }
}
