import { constants, createWriteStream, type Stats } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { setImmediate } from 'node:timers/promises'
import type { ImportFile } from '../shared/imports'
import { isPathInside } from './workspace-paths.ts'
import { openBoundedZip, readZipEntry } from './zip-reader.ts'

export const IMPORT_LIMITS = {
  file: 32 * 1024 * 1024,
  // Archive bounds limit decompression and directory allocation, not folder imports.
  zipEntries: 10000,
  zipBytes: 256 * 1024 * 1024,
}
export function validImportPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length < 2048 &&
    !/[\\:*?"<>|]|\p{Cc}/u.test(path) &&
    !isAbsolute(path) &&
    path
      .split('/')
      .every(
        (part) =>
          !!part &&
          part !== '.' &&
          part !== '..' &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
}
const skipPath = (path: string) =>
  path
    .split('/')
    .some(
      (part) =>
        part.startsWith('.') || ['node_modules', '__MACOSX'].includes(part),
    )
export async function validateImportPaths(files: readonly { path: string }[]) {
  if (!Array.isArray(files))
    throw new Error('The import contains an invalid file list.')
  const seen = new Set<string>()
  for (const file of files) {
    if (!validImportPath(file.path) || skipPath(file.path))
      throw new Error('The import contains an unsafe file path.')
    const key = file.path.normalize('NFC').toLowerCase()
    if (seen.has(key))
      throw new Error(`The import contains duplicate file names: ${file.path}`)
    seen.add(key)
    if (seen.size % 64 === 0) await setImmediate()
  }
  let checked = 0
  for (const key of seen) {
    const parts = key.split('/')
    while (parts.length > 1) {
      parts.pop()
      if (seen.has(parts.join('/')))
        throw new Error('The import uses the same name for a file and folder.')
    }
    if (++checked % 64 === 0) await setImmediate()
  }
}
export async function validateImportFiles(files: readonly ImportFile[]) {
  await validateImportPaths(files)
  let checked = 0
  for (const file of files) {
    if (!(file.data instanceof Uint8Array))
      throw new Error('The import contains an unsafe file path.')
    if (file.data.byteLength > IMPORT_LIMITS.file)
      throw new Error('Import files must each be under 32 MiB.')
    if (++checked % 64 === 0) await setImmediate()
  }
}
export type ImportSourceFile = {
  path: string
  source: string
  root: string
  stat: Pick<Stats, 'size' | 'mtimeMs' | 'ino' | 'dev'>
}
function checkSource(file: ImportSourceFile, stat: Stats) {
  if (
    !stat.isFile() ||
    (['size', 'mtimeMs', 'ino', 'dev'] as const).some(
      (key) => stat[key] !== file.stat[key],
    )
  )
    throw new Error('An import file changed while being read. Try again.')
}
async function checkSourceParent(file: ImportSourceFile) {
  const parent = await realpath(dirname(file.source))
  if (parent !== dirname(file.source) || !isPathInside(file.root, parent))
    throw new Error('An import folder points outside the selected folder.')
}
async function boundedFile(
  path: string,
  limit: number,
  expected?: ImportSourceFile,
) {
  if (expected) await checkSourceParent(expected)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (expected) checkSource(expected, stat)
    if (!stat.isFile() || stat.size > limit)
      throw new Error('A file exceeds the import size limit.')
    // One extra byte catches files that grow while being read without unbounded allocation.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1))
    let size = 0
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size)
      if (!result.bytesRead) break
      size += result.bytesRead
    }
    if (size !== stat.size || (await handle.stat()).mtimeMs !== stat.mtimeMs)
      throw new Error('An import file changed while being read. Try again.')
    if (expected) checkSource(expected, await handle.stat())
    return bytes.subarray(0, size)
  } finally {
    await handle.close()
  }
}
export function readImportFile(file: ImportSourceFile) {
  return boundedFile(file.source, IMPORT_LIMITS.file, file)
}
export async function copyImportFile(file: ImportSourceFile, target: string) {
  await checkSourceParent(file)
  const handle = await open(
    file.source,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  try {
    checkSource(file, await handle.stat())
    let size = 0
    await pipeline(
      handle.createReadStream({
        autoClose: false,
        start: 0,
        end: file.stat.size,
      }),
      async function* (chunks) {
        for await (const chunk of chunks) {
          size += chunk.length
          yield chunk
        }
      },
      createWriteStream(target, { flags: 'wx' }),
    )
    if (size !== file.stat.size)
      throw new Error('An import file changed while being read. Try again.')
    checkSource(file, await handle.stat())
  } finally {
    await handle.close()
  }
}
export async function readImportFolder(root: string) {
  root = await realpath(root)
  const files: ImportSourceFile[] = [],
    warnings: string[] = []
  async function walk(directory: string) {
    const actual = await realpath(directory)
    if (!isPathInside(root, actual))
      throw new Error('An import folder points outside the selected folder.')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = relative(root, join(directory, entry.name))
        .split(sep)
        .join('/')
      if (skipPath(path)) continue
      if (!validImportPath(path))
        throw new Error(`This file name cannot be imported: ${path}`)
      const full = join(directory, entry.name),
        stat = await lstat(full)
      if (stat.isSymbolicLink()) {
        warnings.push(`Skipped symbolic link: ${path}`)
        continue
      }
      if (stat.isDirectory()) await walk(full)
      else if (stat.isFile()) {
        files.push({
          path,
          source: join(actual, entry.name),
          root,
          stat: {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ino: stat.ino,
            dev: stat.dev,
          },
        })
      }
    }
  }
  await walk(root)
  await validateImportPaths(files)
  return { files, warnings }
}
export async function readImportZip(path: string) {
  const zip = await boundedFile(path, IMPORT_LIMITS.zipBytes)
  const directory = await openBoundedZip(zip, IMPORT_LIMITS.zipEntries)
  const files: ImportFile[] = []
  let total = 0
  for (const entry of directory.files) {
    const path = entry.path.replace(/\/$/, '')
    const mode = (entry.externalFileAttributes >>> 16) & 0xf000
    if (
      !validImportPath(path) ||
      entry.flags & 1 ||
      ![0, 0x8000, 0x4000].includes(mode)
    )
      throw new Error(
        'The ZIP contains an unsafe path, symbolic link, special file, or encrypted file.',
      )
    if (skipPath(path) || entry.type === 'Directory') continue
    const data = await readZipEntry(
      entry,
      Math.min(IMPORT_LIMITS.file, IMPORT_LIMITS.zipBytes - total),
    )
    total += data.length
    files.push({ path, data })
  }
  await validateImportFiles(files)
  return { files, warnings: [] as string[] }
}
