import {
  type BigIntStats,
  constants,
  createWriteStream,
  type Stats,
} from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { setImmediate } from 'node:timers/promises'
import { sameFileIdentity } from '../shared/file-identity.ts'
import { fileTimeMilliseconds } from '../shared/file-time.ts'
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
export async function validateImportPaths(
  files: readonly { path: string }[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  if (!Array.isArray(files))
    throw new Error('The import contains an invalid file list.')
  const seen = new Set<string>()
  for (const file of files) {
    signal?.throwIfAborted()
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
    signal?.throwIfAborted()
    const parts = key.split('/')
    while (parts.length > 1) {
      parts.pop()
      if (seen.has(parts.join('/')))
        throw new Error('The import uses the same name for a file and folder.')
    }
    if (++checked % 64 === 0) await setImmediate()
  }
}
export async function validateImportFiles(
  files: readonly ImportFile[],
  signal?: AbortSignal,
) {
  await validateImportPaths(files, signal)
  let checked = 0
  for (const file of files) {
    signal?.throwIfAborted()
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
  stat: Pick<Stats, 'size' | 'mtimeMs'> & Pick<BigIntStats, 'ino' | 'dev'>
}
function checkSource(file: ImportSourceFile, stat: BigIntStats) {
  if (
    !stat.isFile() ||
    !sameFileIdentity(stat, file.stat) ||
    stat.size !== BigInt(file.stat.size) ||
    fileTimeMilliseconds(stat.mtimeNs) !== file.stat.mtimeMs
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
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  if (expected) await checkSourceParent(expected)
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const stat = await handle.stat({ bigint: true })
    if (expected) checkSource(expected, stat)
    if (!stat.isFile() || stat.size > limit)
      throw new Error('A file exceeds the import size limit.')
    // One extra byte catches files that grow while being read without unbounded allocation.
    const bytes = Buffer.alloc(Math.min(Number(stat.size) + 1, limit + 1))
    let size = 0
    while (size < bytes.length) {
      signal?.throwIfAborted()
      const result = await handle.read(bytes, size, bytes.length - size, size)
      if (!result.bytesRead) break
      size += result.bytesRead
    }
    signal?.throwIfAborted()
    if (
      BigInt(size) !== stat.size ||
      (await handle.stat({ bigint: true })).mtimeNs !== stat.mtimeNs
    )
      throw new Error('An import file changed while being read. Try again.')
    if (expected) checkSource(expected, await handle.stat({ bigint: true }))
    return bytes.subarray(0, size)
  } finally {
    await handle.close()
  }
}
export function readImportFile(file: ImportSourceFile, signal?: AbortSignal) {
  return boundedFile(file.source, IMPORT_LIMITS.file, file, signal)
}
export async function copyImportFile(
  file: ImportSourceFile,
  target: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  await checkSourceParent(file)
  const handle = await open(
    file.source,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
  )
  try {
    checkSource(file, await handle.stat({ bigint: true }))
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
      { signal },
    )
    if (size !== file.stat.size)
      throw new Error('An import file changed while being read. Try again.')
    checkSource(file, await handle.stat({ bigint: true }))
  } finally {
    await handle.close()
  }
}
export async function readImportFolder(root: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  root = await realpath(root)
  const files: ImportSourceFile[] = [],
    warnings: string[] = []
  async function walk(directory: string) {
    signal?.throwIfAborted()
    const actual = await realpath(directory)
    if (!isPathInside(root, actual))
      throw new Error('An import folder points outside the selected folder.')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted()
      const path = relative(root, join(directory, entry.name))
        .split(sep)
        .join('/')
      if (skipPath(path)) continue
      if (!validImportPath(path))
        throw new Error(`This file name cannot be imported: ${path}`)
      const full = join(directory, entry.name),
        stat = await lstat(full, { bigint: true })
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
            size: Number(stat.size),
            mtimeMs: fileTimeMilliseconds(stat.mtimeNs),
            ino: stat.ino,
            dev: stat.dev,
          },
        })
      }
    }
  }
  await walk(root)
  await validateImportPaths(files, signal)
  return { files, warnings }
}
export async function readImportZip(path: string, signal?: AbortSignal) {
  const zip = await boundedFile(path, IMPORT_LIMITS.zipBytes, undefined, signal)
  const directory = await openBoundedZip(zip, IMPORT_LIMITS.zipEntries)
  const files: ImportFile[] = []
  let total = 0
  for (const entry of directory.files) {
    signal?.throwIfAborted()
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
      signal,
    )
    total += data.length
    files.push({ path, data })
  }
  await validateImportFiles(files, signal)
  return { files, warnings: [] as string[] }
}
