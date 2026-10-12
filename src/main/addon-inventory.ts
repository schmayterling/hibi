import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { dirname, extname, join, sep } from 'node:path'
import { Readable } from 'node:stream'
import { crc32, createInflateRaw } from 'node:zlib'
import type { File } from 'unzipper'
import {
  excludedAddonPath,
  MAX_ADDON_BYTES,
  MAX_ADDON_ENTRIES,
  MAX_ADDON_FILE_BYTES,
  MAX_ADDON_MANIFEST_BYTES,
  validAddonInventoryPath,
  validAddonPath,
} from '../shared/addon-package.ts'

const MAX_INVENTORY_ENTRIES = 5000
const MAX_INVENTORY_BYTES = 64 * 1024 * 1024
const MAX_DEPTH = 12
const MAX_CANDIDATES = 64
const MANIFEST = 'hibi-addon.json'
const extensions = new Set([
  '.js',
  '.mjs',
  '.json',
  '.css',
  '.woff',
  '.woff2',
  '.ttf',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.mp3',
  '.ogg',
  '.wav',
  '.md',
  '.txt',
])

export type AddonInventory = {
  entries: { path: string; directory: boolean; size: number }[]
  read(path: string): Promise<Buffer>
}

const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const manifestPath = (path: string) => path.split('/').at(-1) === MANIFEST
const damaged = () =>
  new Error('The addon ZIP file is damaged. Download it again.')

/** Sorted neighbors expose collisions in implicit parents without retaining every prefix. */
function pathRegistry() {
  const paths = new Map<string, { path: string; directory: boolean }>()
  const folded = (path: string) =>
    path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')
  const conflict = () =>
    new Error('The addon repository contains duplicate or conflicting paths.')
  return {
    add(path: string, directory: boolean) {
      if (!validAddonInventoryPath(path))
        throw new Error('The addon repository contains an invalid path.')
      const key = folded(path)
      if (paths.has(key)) throw conflict()
      paths.set(key, { path, directory })
    },
    check() {
      const entries = [...paths]
        .map(([key, value]) => [key.replaceAll('/', '\0'), value] as const)
        .sort(([a], [b]) => lexical(a, b))
      for (let index = 1; index < entries.length; index++) {
        const previous = entries[index - 1]
        const current = entries[index]
        if (!previous || !current) continue
        if (!previous[1].directory && current[0].startsWith(`${previous[0]}\0`))
          throw conflict()
        const before = previous[1].path.split('/')
        const after = current[1].path.split('/')
        for (
          let part = 0;
          part < Math.min(before.length, after.length);
          part++
        ) {
          if (folded(before[part] ?? '') !== folded(after[part] ?? '')) break
          if (before[part] !== after[part]) throw conflict()
        }
      }
    },
  }
}

function inventoryLimits(count: number, bytes: number, size: number) {
  if (count > MAX_INVENTORY_ENTRIES)
    throw new Error('An addon repository can contain up to 5,000 entries.')
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ADDON_FILE_BYTES)
    throw new Error('Each addon file must be no larger than 5 MiB.')
  if (bytes > MAX_INVENTORY_BYTES)
    throw new Error('The addon repository exceeds the 64 MiB limit.')
}

function depthLimit(path: string, directory: boolean) {
  if (path.split('/').length - (directory ? 0 : 1) > MAX_DEPTH)
    throw new Error('Addon repository traversal exceeds 12 directory levels.')
}

function finishInventory(
  entries: AddonInventory['entries'],
  read: AddonInventory['read'],
) {
  entries.sort((a, b) => lexical(a.path, b.path))
  const inventory = { entries, read }
  addonCandidatePaths(inventory)
  return inventory
}

export function addonCandidatePaths(inventory: AddonInventory): string[] {
  const folders = inventory.entries
    .filter(
      (entry) =>
        !entry.directory &&
        !excludedAddonPath(entry.path) &&
        manifestPath(entry.path),
    )
    .map((entry) => {
      depthLimit(entry.path, false)
      return entry.path === MANIFEST
        ? ''
        : entry.path.slice(0, -MANIFEST.length - 1)
    })
    .sort(lexical)
  if (folders.length > MAX_CANDIDATES)
    throw new Error(
      'An addon repository can contain up to 64 candidate manifests.',
    )
  return folders
}

/** Validate local headers too; never let an inflater interpret unreviewed names or sizes. */
function packedEntry(zip: Buffer, file: File, directoryOffset: number): Buffer {
  const offset = file.offsetToLocalFileHeader
  if (
    file.signature !== 0x02014b50 ||
    file.diskNumber ||
    offset < 0 ||
    offset + 30 > directoryOffset ||
    zip.readUInt32LE(offset) !== 0x04034b50 ||
    zip.readUInt16LE(offset + 6) !== file.flags ||
    zip.readUInt16LE(offset + 8) !== file.compressionMethod
  )
    throw damaged()
  const nameEnd = offset + 30 + zip.readUInt16LE(offset + 26)
  const start = nameEnd + zip.readUInt16LE(offset + 28)
  const end = start + file.compressedSize
  if (
    end > directoryOffset ||
    start > end ||
    !zip.subarray(offset + 30, nameEnd).equals(file.pathBuffer) ||
    !Buffer.from(file.path).equals(file.pathBuffer) ||
    (!(file.flags & 8) &&
      (zip.readUInt32LE(offset + 14) !== file.crc32 ||
        zip.readUInt32LE(offset + 18) !== file.compressedSize ||
        zip.readUInt32LE(offset + 22) !== file.uncompressedSize))
  )
    throw damaged()
  return zip.subarray(start, end)
}

async function inflateEntry(
  packed: Buffer,
  file: File,
  retain: boolean,
  signal?: AbortSignal,
  countBytes?: (size: number) => void,
): Promise<Buffer> {
  signal?.throwIfAborted()
  const source = Readable.from([packed])
  const stream =
    file.compressionMethod === 8 ? source.pipe(createInflateRaw()) : source
  const abort = () =>
    stream.destroy(new Error('Addon preparation was canceled.'))
  signal?.addEventListener('abort', abort, { once: true })
  const parts: Buffer[] = []
  let size = 0,
    checksum = 0
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted()
      const part = Buffer.from(chunk)
      size += part.length
      inventoryLimits(0, 0, size)
      countBytes?.(part.length)
      checksum = crc32(part, checksum)
      if (retain) parts.push(part)
    }
    signal?.throwIfAborted()
    if (size !== file.uncompressedSize || checksum !== file.crc32)
      throw damaged()
    return Buffer.concat(parts)
  } finally {
    signal?.removeEventListener('abort', abort)
    source.destroy()
    stream.destroy()
  }
}

/** Reject truncated central headers before the ZIP parser waits for missing bytes. */
function checkCentralHeaders(zip: Buffer) {
  let end = zip.length - 22
  const minimum = Math.max(0, end - 65535)
  while (end >= minimum) {
    if (
      zip.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + zip.readUInt16LE(end + 20) === zip.length
    )
      break
    end--
  }
  if (end < minimum) throw damaged()
  const count = zip.readUInt16LE(end + 10)
  if (count > MAX_INVENTORY_ENTRIES) return
  let offset = zip.readUInt32LE(end + 16)
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || zip.readUInt32LE(offset) !== 0x02014b50)
      throw damaged()
    offset +=
      46 +
      zip.readUInt16LE(offset + 28) +
      zip.readUInt16LE(offset + 30) +
      zip.readUInt16LE(offset + 32)
    if (offset > end) throw damaged()
  }
  if (offset !== end) throw damaged()
}

/** Inspect every archive entry; retain only small, inert candidate manifests. */
export async function inventoryAddonArchive(
  zip: Buffer,
  signal?: AbortSignal,
): Promise<AddonInventory> {
  signal?.throwIfAborted()
  if (zip.length > MAX_ADDON_BYTES || zip.length < 22)
    throw new Error('This is not a valid addon ZIP file.')
  zip = Buffer.from(zip)
  checkCentralHeaders(zip)
  const { openBoundedZip } = await import('./zip-reader.ts')
  const directory = await openBoundedZip(zip, MAX_INVENTORY_ENTRIES)
  const register = pathRegistry()
  const entries: AddonInventory['entries'] = []
  const files = new Map<
    string,
    { file: File; packed: Buffer; manifest?: Buffer }
  >()
  let declared = 0,
    actual = 0,
    centralSize = 0
  for (const file of directory.files) {
    signal?.throwIfAborted()
    const path = file.path.replace(/\/$/, '')
    const folder = file.path.endsWith('/')
    const mode = (file.externalFileAttributes >>> 16) & 0xf000
    if (
      file.flags & 1 ||
      file.externalFileAttributes & 0x400 ||
      ![0, 0x8000, 0x4000].includes(mode) ||
      (mode === 0x4000 && !folder) ||
      (mode === 0x8000 && folder) ||
      ![0, 8].includes(file.compressionMethod) ||
      (folder && file.uncompressedSize)
    )
      throw new Error(
        'Addon ZIP files cannot contain symbolic links, special files, encrypted files, or invalid modes.',
      )
    register.add(path, folder)
    declared += file.uncompressedSize
    inventoryLimits(directory.files.length, declared, file.uncompressedSize)
    centralSize +=
      46 + file.fileNameLength + file.extraFieldLength + file.fileCommentLength
    const packed = packedEntry(
      zip,
      file,
      directory.offsetToStartOfCentralDirectory,
    )
    if (excludedAddonPath(path)) continue
    depthLimit(path, folder)
    entries.push({ path, directory: folder, size: file.uncompressedSize })
    if (!folder) files.set(path, { file, packed })
  }
  register.check()
  if (centralSize !== directory.sizeOfCentralDirectory) throw damaged()
  addonCandidatePaths({
    entries,
    read: async () => {
      throw damaged()
    },
  })
  for (const file of directory.files) {
    const path = file.path.replace(/\/$/, '')
    const saved = files.get(path)
    const retain =
      !!saved &&
      manifestPath(path) &&
      file.uncompressedSize <= MAX_ADDON_MANIFEST_BYTES
    const content = await inflateEntry(
      packedEntry(zip, file, directory.offsetToStartOfCentralDirectory),
      file,
      retain,
      signal,
      (size) => {
        actual += size
        inventoryLimits(0, actual, 0)
      },
    )
    if (retain && saved) saved.manifest = content
  }
  return finishInventory(entries, async (path) => {
    signal?.throwIfAborted()
    const saved = files.get(path)
    if (!saved)
      throw new Error('The requested addon file is absent from the inventory.')
    if (
      manifestPath(path) &&
      saved.file.uncompressedSize > MAX_ADDON_MANIFEST_BYTES
    )
      throw new Error(
        'hibi-addon.json must be a JSON file no larger than 64 KiB.',
      )
    return saved.manifest
      ? Buffer.from(saved.manifest)
      : inflateEntry(saved.packed, saved.file, true, signal)
  })
}

function sameFile(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  )
}

/** Resolve parent aliases while refusing a link at the chosen boundary. */
async function canonicalRoot(root: string): Promise<string> {
  const stat = await lstat(root)
  if (stat.isSymbolicLink())
    throw new Error('Addon folders cannot contain symbolic links or junctions.')
  if (!stat.isDirectory())
    throw new Error('The addon root must be a directory.')
  return realpath(root)
}

export async function inventoryAddonDirectory(
  root: string,
  signal?: AbortSignal,
): Promise<AddonInventory> {
  signal?.throwIfAborted()
  root = await canonicalRoot(root)
  const directories = new Map<string, Stats>()
  const files = new Map<string, Stats>()
  const register = pathRegistry()
  const entries: AddonInventory['entries'] = []
  let count = 0,
    declared = 0

  async function checked(path: string, folder: boolean, expected?: Stats) {
    signal?.throwIfAborted()
    const target = path ? join(root, path) : root
    const stat = await lstat(target)
    if (stat.isSymbolicLink())
      throw new Error(
        'Addon folders cannot contain symbolic links or invalid paths.',
      )
    if (folder ? !stat.isDirectory() : !stat.isFile())
      throw new Error(
        'The addon files changed or contain links or special files.',
      )
    const canonical = await realpath(target)
    if (
      (canonical !== root && !canonical.startsWith(root + sep)) ||
      (expected &&
        (expected.dev !== stat.dev ||
          expected.ino !== stat.ino ||
          (!folder && !sameFile(expected, stat))))
    )
      throw new Error(
        'The addon files changed or contain links or special files.',
      )
    return stat
  }

  async function checkParents(path: string) {
    await checked('', true, directories.get(''))
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/')
      await checked(parent, true, directories.get(parent))
    }
  }

  async function read(path: string): Promise<Buffer> {
    const expected = files.get(path)
    if (!expected)
      throw new Error('The requested addon file is absent from the inventory.')
    await checkParents(path)
    await checked(path, false, expected)
    if (manifestPath(path) && expected.size > MAX_ADDON_MANIFEST_BYTES)
      throw new Error(
        'hibi-addon.json must be a JSON file no larger than 64 KiB.',
      )
    const handle = await open(
      join(root, path),
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    )
    try {
      const before = await handle.stat()
      if (!before.isFile() || !sameFile(expected, before))
        throw new Error('The addon files changed during preparation.')
      const parts: Buffer[] = []
      let size = 0
      for (;;) {
        signal?.throwIfAborted()
        const chunk = Buffer.alloc(
          Math.min(64 * 1024, MAX_ADDON_FILE_BYTES + 1 - size),
        )
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, size)
        if (!bytesRead) break
        size += bytesRead
        inventoryLimits(0, 0, size)
        parts.push(chunk.subarray(0, bytesRead))
      }
      if (size !== expected.size || !sameFile(before, await handle.stat()))
        throw new Error('The addon files changed during preparation.')
      await checkParents(path)
      await checked(path, false, expected)
      signal?.throwIfAborted()
      return Buffer.concat(parts)
    } finally {
      await handle.close()
    }
  }

  async function walk(path: string) {
    directories.set(path, await checked(path, true))
    await checkParents(path)
    const directory = await opendir(path ? join(root, path) : root)
    for await (const entry of directory) {
      signal?.throwIfAborted()
      const relative = path ? `${path}/${entry.name}` : entry.name
      const stat = await checked(relative, entry.isDirectory())
      count++
      declared += stat.isFile() ? stat.size : 0
      inventoryLimits(count, declared, stat.isFile() ? stat.size : 0)
      register.add(relative, stat.isDirectory())
      if (excludedAddonPath(relative)) continue
      depthLimit(relative, stat.isDirectory())
      entries.push({
        path: relative,
        directory: stat.isDirectory(),
        size: stat.isFile() ? stat.size : 0,
      })
      if (stat.isDirectory()) await walk(relative)
      else files.set(relative, stat)
    }
    await checked(path, true, directories.get(path))
  }
  await walk('')
  register.check()
  return finishInventory(entries, read)
}

/** Validate the admitted subtree without parsing or executing its metadata. */
export function addonPackageFiles(
  inventory: AddonInventory,
  folder: string,
): string[] {
  if (folder && !validAddonInventoryPath(folder))
    throw new Error('The selected addon folder is invalid.')
  const prefix = folder ? `${folder}/` : ''
  const files: string[] = []
  const register = pathRegistry()
  const paths = new Set<string>()
  let bytes = 0
  for (const entry of inventory.entries) {
    if (!entry.path.startsWith(prefix) || entry.path === folder) continue
    const path = entry.path.slice(prefix.length)
    if (excludedAddonPath(path)) continue
    if (!validAddonPath(path))
      throw new Error('The addon repository contains an invalid path.')
    register.add(path, entry.directory)
    const parts = path.split('/')
    for (let index = 1; index <= parts.length; index++)
      paths.add(parts.slice(0, index).join('/'))
    if (paths.size > MAX_ADDON_ENTRIES)
      throw new Error('An addon can contain up to 1,000 entries.')
    if (entry.directory) continue
    bytes += entry.size
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > MAX_ADDON_FILE_BYTES ||
      bytes > MAX_ADDON_BYTES
    )
      throw new Error(
        'The addon exceeds the limit of 5 MiB per file or 25 MiB in total.',
      )
    if (!extensions.has(extname(path).toLowerCase()))
      throw new Error(`This file type is not allowed in addons: ${path}`)
    files.push(path)
  }
  register.check()
  if (!files.includes('README.md') || !files.includes(MANIFEST))
    throw new Error('The addon needs README.md and hibi-addon.json.')
  return files.sort(lexical)
}

/** Copy only a reviewed package into an existing host-owned staging directory. */
export async function copyAddonPackage(
  inventory: AddonInventory,
  folder: string,
  destination: string,
): Promise<{ files: string[]; hash: string }> {
  const files = addonPackageFiles(inventory, folder)
  const stat = await lstat(destination)
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('The addon destination must be an owned directory.')
  const root = await realpath(destination)
  const hash = createHash('sha256')
  let bytes = 0,
    count = 0
  for (const path of files) {
    const content = await inventory.read(folder ? `${folder}/${path}` : path)
    bytes += content.length
    if (
      ++count > MAX_ADDON_ENTRIES ||
      content.length > MAX_ADDON_FILE_BYTES ||
      bytes > MAX_ADDON_BYTES
    )
      throw new Error(
        'The addon exceeds the limit of 5 MiB per file or 25 MiB in total.',
      )
    const target = join(root, path)
    let directory = root
    for (const part of path.split('/').slice(0, -1)) {
      directory = join(directory, part)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await canonicalRoot(directory)
    }
    if (
      !(await realpath(dirname(target))).startsWith(root + sep) &&
      dirname(target) !== root
    )
      throw new Error('The addon destination is outside its staging directory.')
    await writeFile(target, content, { flag: 'wx', mode: 0o600 })
    hash.update(path).update('\0').update(content)
  }
  return { files, hash: hash.digest('hex') }
}
