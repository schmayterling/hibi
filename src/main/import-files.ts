import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { ImportFile } from '../shared/imports'
import { isPathInside } from './workspace-paths.ts'
import { openBoundedZip, readZipEntry } from './zip-reader.ts'

export const IMPORT_LIMITS = {
  files: 10000,
  file: 32 * 1024 * 1024,
  total: 256 * 1024 * 1024,
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
export function validateImportFiles(files: readonly ImportFile[]) {
  if (!Array.isArray(files) || files.length > IMPORT_LIMITS.files)
    throw new Error('Import at most 10,000 files at a time.')
  const seen = new Set<string>()
  let total = 0
  for (const file of files) {
    if (
      !validImportPath(file.path) ||
      skipPath(file.path) ||
      !(file.data instanceof Uint8Array)
    )
      throw new Error('The import contains an unsafe file path.')
    const key = file.path.normalize('NFC').toLowerCase()
    if (seen.has(key))
      throw new Error(`The import contains duplicate file names: ${file.path}`)
    seen.add(key)
    total += file.data.byteLength
    if (
      file.data.byteLength > IMPORT_LIMITS.file ||
      total > IMPORT_LIMITS.total
    )
      throw new Error(
        'Import at most 256 MiB at a time, with each file under 32 MiB.',
      )
  }
  for (const key of seen) {
    const parts = key.split('/')
    while (parts.length > 1) {
      parts.pop()
      if (seen.has(parts.join('/')))
        throw new Error('The import uses the same name for a file and folder.')
    }
  }
}
async function boundedFile(path: string, limit: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
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
    return bytes.subarray(0, size)
  } finally {
    await handle.close()
  }
}
export async function readImportFolder(root: string) {
  root = await realpath(root)
  const files: ImportFile[] = [],
    warnings: string[] = []
  let total = 0,
    entries = 0
  async function walk(directory: string) {
    const actual = await realpath(directory)
    if (!isPathInside(root, actual))
      throw new Error('An import folder points outside the selected folder.')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = relative(root, join(directory, entry.name))
        .split(sep)
        .join('/')
      if (skipPath(path)) continue
      if (++entries > IMPORT_LIMITS.files)
        throw new Error('Import at most 10,000 files and folders at a time.')
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
        const data = await boundedFile(
          full,
          Math.min(IMPORT_LIMITS.file, IMPORT_LIMITS.total - total),
        )
        total += data.length
        files.push({ path, data })
      }
    }
  }
  await walk(root)
  validateImportFiles(files)
  return { files, warnings }
}
export async function readImportZip(path: string) {
  const zip = await boundedFile(path, IMPORT_LIMITS.total)
  const directory = await openBoundedZip(zip, IMPORT_LIMITS.files)
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
      Math.min(IMPORT_LIMITS.file, IMPORT_LIMITS.total - total),
    )
    total += data.length
    files.push({ path, data })
  }
  validateImportFiles(files)
  return { files, warnings: [] as string[] }
}
