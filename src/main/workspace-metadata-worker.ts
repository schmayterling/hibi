import { createHash, randomUUID } from 'node:crypto'
import { type BigIntStats, constants, type Dir } from 'node:fs'
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { sameFileIdentity } from '../shared/file-identity.ts'
import {
  type DetailPage,
  validNotePosition,
  type WorkspaceMetadataDetailSource,
} from '../shared/metadata-stream.ts'
import type { NoteHeading } from '../shared/note-metadata.ts'
import { diskIndexVersion } from './workspace-index-cache.ts'
import type { WorkspaceMetadataPage } from './workspace-index-metadata.ts'
import {
  DetailStoreWriter,
  detailStorePattern,
  readDetailStore,
  readInlineDetails,
  validDetailSource,
  validInlineDetails,
} from './workspace-metadata-detail-store.ts'
import { parseWorkspaceMetadataFallback } from './workspace-metadata-fallback.ts'
import {
  type HeadingStoreRecord,
  HeadingStoreWriter,
  headingDirectoryAvailable,
  headingStorePattern,
  inlineHeadingCount,
  inlineHeadingLength,
  readHeadingStore,
  validHeadingStore,
} from './workspace-metadata-heading-store.ts'
import type {
  CachedMetadataRequest,
  MetadataFileInput,
  MetadataParseInput,
  MetadataWorkerRequest,
} from './workspace-metadata-parser.ts'
import { parsePositionedMetadata } from './workspace-metadata-positioned.ts'
import {
  incompleteMetadataPage,
  RecordReader,
  type RecordSlice,
  type RecordToken,
  RecordWriter,
  recordSliceBytes,
  recordTokens,
} from './workspace-metadata-record.ts'
import { applySourceSyntax } from './workspace-syntax.ts'

let results: AsyncGenerator<RecordSlice> | undefined

const cacheDirectory = workerData.cacheDirectory as string | undefined
const buildIdentity = workerData.buildIdentity as string | undefined
const schema = 6
const headingDirectory = workerData.headingDirectory as string
const headingLocations = new Map<
  string,
  {
    version: string
    fingerprint: string
    path: string
    directory: string
    store: HeadingStoreRecord | undefined
    complete: boolean
  }
>()
type DetailLocation = {
  version: string
  fingerprint: string
  path: string
  directory: string
  source: WorkspaceMetadataDetailSource
  inline?: RecordToken[]
}
const detailLocations = new Map<string, DetailLocation>()
type CacheRecord = {
  schema: number
  buildIdentity: string
  fingerprint: string
  page: WorkspaceMetadataPage
  headings?: HeadingStoreRecord
  inlineHeadings?: NoteHeading[]
  inlineDetails?: RecordToken[]
}
const idPattern = /^[a-f0-9]{64}$/
const recordPattern = /^[a-f0-9]{64}\.json$/
const temporaryPattern =
  /^\.[a-f0-9]{64}-[a-f0-9-]{36}(?:\.hidx|\.hdat|\.mdat)?\.tmp$/
// Cache paths reach the checked folder itself, not its name, so a folder
// renamed and replaced with a link after the check keeps every write. macOS
// finds it by volume and file id, Linux through the open descriptor. Windows
// has neither: there a new file must be in the checked folder before it gets
// a byte, and each removal checks the path again.
let pinned:
  | { base: string; dev: bigint; ino: bigint; handle?: FileHandle }
  | undefined
let pruning: Dir | undefined
let parsing:
  | {
      input: MetadataParseInput
      chunks: string[]
      length: number
      received: number
      disk?: {
        input: MetadataFileInput
        file: FileHandle
        buffer: Buffer
        decoder: TextDecoder
        remaining: bigint
        done: boolean
      }
    }
  | undefined
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

function headingIdentity(
  input: Pick<MetadataParseInput, 'id' | 'path' | 'version' | 'fingerprint'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        buildIdentity,
        input.id,
        input.path,
        input.version,
        input.fingerprint,
      ]),
    )
    .digest('hex')
}

function valid(page: WorkspaceMetadataPage): boolean {
  const metadata = page?.metadata
  return !!(
    typeof page?.path === 'string' &&
    typeof page.version === 'string' &&
    typeof page.syntax?.key === 'string' &&
    typeof page.syntax.complete === 'boolean' &&
    typeof page.syntax.unsupported === 'boolean' &&
    metadata &&
    typeof metadata.referenceComplete === 'boolean' &&
    strings(metadata.references?.links) &&
    strings(metadata.references?.wikilinks) &&
    strings(metadata.tags) &&
    typeof metadata.properties?.complete === 'boolean' &&
    metadata.properties.values &&
    typeof metadata.properties.values === 'object' &&
    !Array.isArray(metadata.properties.values) &&
    Object.entries(metadata.properties.values).every(
      ([key, values]) =>
        idPattern.test(key) &&
        strings(values) &&
        values.every((value) => idPattern.test(value)),
    ) &&
    typeof metadata.headings?.complete === 'boolean' &&
    Array.isArray(metadata.headings.items) &&
    metadata.headings.items.length === 0 &&
    metadata.headings.paged === true &&
    Number.isSafeInteger(metadata.headings.count) &&
    (metadata.headings.count ?? -1) >= 0
  )
}

function validInlineHeadings(
  headings: unknown,
  count: number | undefined,
): boolean {
  if (
    !Array.isArray(headings) ||
    headings.length !== count ||
    headings.length > inlineHeadingCount
  )
    return false
  let length = 0
  for (const heading of headings) {
    // Heading pages return these objects as stored, so nothing else may ride along.
    if (
      Object.keys(heading).some(
        (key) => !['depth', 'text', 'position'].includes(key),
      ) ||
      (heading.position !== undefined &&
        !validNotePosition(heading.position)) ||
      !Number.isInteger(heading.depth) ||
      heading.depth < 1 ||
      heading.depth > 6 ||
      typeof heading.text !== 'string'
    )
      return false
    length += heading.text.length
  }
  return length <= inlineHeadingLength
}

/** The checked cache folder's path for cache files, or undefined. */
async function cacheAvailable(create = false): Promise<string | undefined> {
  if (!cacheDirectory || !buildIdentity) return undefined
  try {
    const info = await lstat(cacheDirectory, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined
    if (!pinned || !sameFileIdentity(pinned, info)) await pin(info)
    return pinned?.base
  } catch (error) {
    if (create && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        await mkdir(cacheDirectory, { recursive: true, mode: 0o700 })
      } catch {
        return undefined
      }
      return cacheAvailable()
    }
    return undefined
  }
}

async function pin(info: BigIntStats): Promise<void> {
  await pinned?.handle?.close().catch(() => {})
  pinned = undefined
  const path = cacheDirectory as string
  if (process.platform === 'win32') {
    pinned = { base: path, dev: info.dev, ino: info.ino }
    return
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    const opened = await handle.stat({ bigint: true })
    const base =
      process.platform === 'darwin'
        ? `/.vol/${opened.dev}/${opened.ino}`
        : `/proc/self/fd/${handle.fd}/`
    if (
      sameFileIdentity(opened, info) &&
      sameFileIdentity(await stat(base, { bigint: true }), opened)
    ) {
      pinned = { base, dev: opened.dev, ino: opened.ino, handle }
      return
    }
  } catch {
    // Without such paths the cache stays off rather than following a name.
  }
  await handle.close()
}

async function created(
  base: string,
  path: string,
  file: FileHandle,
): Promise<boolean> {
  const [opened, entry, folder] = await Promise.all([
    file.stat({ bigint: true }),
    lstat(path, { bigint: true }),
    stat(base, { bigint: true }),
  ])
  return (
    sameFileIdentity(opened, entry) &&
    !!pinned &&
    sameFileIdentity(folder, pinned)
  )
}

async function removeEntry(base: string, name: string): Promise<void> {
  if ((await cacheAvailable()) === base)
    await unlink(join(base, name)).catch(() => {})
}

async function readRecord(
  id: string,
  details = false,
): Promise<CacheRecord | null> {
  const base = idPattern.test(id) ? await cacheAvailable() : undefined
  if (!base) return null
  try {
    const path = join(base, `${id}.json`)
    const info = await lstat(path, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink()) return null
    // O_NOFOLLOW closes the lstat/open race; a fixed read also bounds file growth.
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const opened = await file.stat({ bigint: true })
      if (!opened.isFile() || !sameFileIdentity(opened, info)) return null
      const reader = new RecordReader(undefined, true, !details)
      let first = true
      const buffer = Buffer.alloc(64 * 1024)
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let line = '',
        position = 0n
      while (position < opened.size) {
        const length = Number(
          opened.size - position > BigInt(buffer.length)
            ? BigInt(buffer.length)
            : opened.size - position,
        )
        const { bytesRead } = await file.read(buffer, 0, length)
        if (!bytesRead) return null
        position += BigInt(bytesRead)
        line += decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
        let end = line.indexOf('\n')
        while (end >= 0) {
          if (end > recordSliceBytes) return null
          const tokens = JSON.parse(line.slice(0, end))
          if (!Array.isArray(tokens) || tokens.length > 8192) return null
          // Old records can contain millions of headings. Reject their schema before reconstruction.
          if (first) {
            if (
              tokens[0] !== '{' ||
              !Array.isArray(tokens[1]) ||
              tokens[1][0] !== 'schema' ||
              tokens[1][1] !== true ||
              tokens[2] !== schema
            )
              return null
            first = false
          }
          reader.write(tokens)
          line = line.slice(end + 1)
          end = line.indexOf('\n')
        }
        if (line.length > recordSliceBytes) return null
      }
      line += decoder.decode()
      const after = await file.stat({ bigint: true })
      const pathInfo = await lstat(path, { bigint: true })
      if (
        line.length ||
        diskIndexVersion(opened) !== diskIndexVersion(after) ||
        diskIndexVersion(opened) !== diskIndexVersion(pathInfo) ||
        pathInfo.isSymbolicLink() ||
        (await cacheAvailable()) !== base
      )
        return null
      const value = reader.finish() as CacheRecord
      const page = value.page as WorkspaceMetadataPage
      return value.schema === schema &&
        value.buildIdentity === buildIdentity &&
        typeof value.fingerprint === 'string' &&
        page?.id === id &&
        valid(page) &&
        page.details &&
        validDetailSource(page.details) &&
        page.details.key.startsWith(`${id}-`) &&
        page.details.identity ===
          headingIdentity({
            id,
            path: page.path,
            version: page.version,
            fingerprint: value.fingerprint,
          }) &&
        (!details ||
          value.inlineDetails === undefined ||
          validInlineDetails(page.details, value.inlineDetails)) &&
        (page.details.bytes > 0 || value.inlineDetails !== undefined) &&
        (!value.headings ||
          (validHeadingStore(value.headings) &&
            value.headings.key.startsWith(`${id}-`) &&
            value.headings.count === page.metadata.headings.count &&
            value.headings.identity ===
              headingIdentity({
                id,
                path: page.path,
                version: page.version,
                fingerprint: value.fingerprint,
              }))) &&
        (!value.inlineHeadings ||
          validInlineHeadings(
            value.inlineHeadings,
            page.metadata.headings.count,
          )) &&
        (page.metadata.headings.count === 0 ||
          !!value.headings ||
          !!value.inlineHeadings)
        ? value
        : null
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

async function cached(
  request: CachedMetadataRequest,
): Promise<WorkspaceMetadataPage | null> {
  const value = await readRecord(request.id)
  return value &&
    value.fingerprint === request.fingerprint &&
    value.page.path === request.path &&
    value.page.version === request.version
    ? value.page
    : null
}

async function readDetails(
  request: CachedMetadataRequest,
  cursor: number,
): Promise<DetailPage | null> {
  if (
    !idPattern.test(request.id) ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0
  )
    return null
  const local = detailLocations.get(request.id)
  if (local) {
    if (
      local.path !== request.path ||
      local.version !== request.version ||
      local.fingerprint !== request.fingerprint
    )
      return null
    if (
      local.directory !== headingDirectory &&
      (await cacheAvailable()) !== local.directory
    )
      return null
    return local.inline !== undefined
      ? readInlineDetails(local.source, local.inline, cursor)
      : readDetailStore(local.directory, local.source, cursor)
  }
  const record = await readRecord(request.id, true)
  if (
    !record ||
    record.fingerprint !== request.fingerprint ||
    record.page.path !== request.path ||
    record.page.version !== request.version ||
    !record.page.details
  )
    return null
  if (record.inlineDetails !== undefined)
    return readInlineDetails(record.page.details, record.inlineDetails, cursor)
  const base = await cacheAvailable()
  return base ? readDetailStore(base, record.page.details, cursor) : null
}

async function clearDetailLocation(id: string): Promise<void> {
  const previous = detailLocations.get(id)
  detailLocations.delete(id)
  if (
    previous?.directory === headingDirectory &&
    previous.source.bytes &&
    previous.inline === undefined
  )
    await unlink(join(previous.directory, `${previous.source.key}.mdat`)).catch(
      () => {},
    )
}

async function readHeadings(
  request: CachedMetadataRequest,
  offset: number,
  limit: number,
) {
  const local = headingLocations.get(request.id)
  if (
    local &&
    local.version === request.version &&
    local.path === request.path &&
    local.fingerprint === request.fingerprint
  )
    return local.store
      ? readHeadingStore(
          local.directory,
          local.store,
          offset,
          limit,
          local.complete,
        )
      : {
          items: [],
          nextOffset: offset,
          hasMore: false,
          complete: local.complete,
        }
  const record = await readRecord(request.id)
  if (
    !record ||
    record.fingerprint !== request.fingerprint ||
    record.page.path !== request.path ||
    record.page.version !== request.version
  )
    return null
  const complete =
    record.page.metadata.headings.complete && record.page.syntax.complete
  if (record.inlineHeadings) {
    // Inline lists are far below a heading page's byte bound.
    const items = record.inlineHeadings.slice(offset, offset + limit)
    const nextOffset = offset + items.length
    return {
      items,
      nextOffset,
      hasMore: nextOffset < record.inlineHeadings.length,
      complete,
    }
  }
  if (!record.headings)
    return { items: [], nextOffset: offset, hasMore: false, complete }
  const base = await cacheAvailable()
  if (!base) return null
  return readHeadingStore(base, record.headings, offset, limit, complete)
}

// Rich descriptors stay worker-owned; ordinary metadata pages carry only index projections.
const metadataProjection = (page: WorkspaceMetadataPage | null) =>
  page && { ...page, details: undefined }

async function* resultPages(
  requests: readonly CachedMetadataRequest[],
): AsyncGenerator<RecordSlice> {
  if (requests.length > 64)
    throw new RangeError('cachedBatch accepts 64 requests')
  const writer = new RecordWriter()
  for (const tokens of writer.write(['['])) yield { tokens, done: false }
  const available = await cacheAvailable()
  for (const request of requests) {
    // Release each derived record before opening the next. No batch-sized heap.
    const page = available ? await cached(request) : null
    for (const tokens of writer.write(recordTokens(metadataProjection(page))))
      yield { tokens, done: false }
  }
  for (const tokens of writer.write([']'])) yield { tokens, done: false }
  yield { tokens: writer.finish(), done: true }
}

async function* resultPage(value: unknown): AsyncGenerator<RecordSlice> {
  const writer = new RecordWriter()
  for (const tokens of writer.write(
    recordTokens(metadataProjection(value as WorkspaceMetadataPage)),
  ))
    yield { tokens, done: false }
  yield { tokens: writer.finish(), done: true }
}

async function resultChunk(): Promise<RecordSlice> {
  const next = await results?.next()
  if (!next || next.done) throw new TypeError('Missing metadata result')
  if (next.value.done) {
    await results?.return(undefined)
    results = undefined
  }
  return next.value
}

async function remember(
  page: WorkspaceMetadataPage,
  fingerprint: string,
  headings?: HeadingStoreRecord,
  inlineHeadings?: NoteHeading[],
  inlineDetails?: RecordToken[],
): Promise<boolean> {
  if (!page.id || !idPattern.test(page.id) || !page.version.startsWith('disk:'))
    return false
  const base = await cacheAvailable(true)
  if (!base) return false
  const temporary = join(base, `.${page.id}-${randomUUID()}.tmp`)
  let renamed = false
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      if (!(await created(base, temporary, file))) return false
      const writer = new RecordWriter()
      const tokens = recordTokens({
        schema,
        buildIdentity,
        fingerprint,
        page,
        headings,
        inlineHeadings,
        inlineDetails,
      })
      const write = async (slice: RecordToken[]) => {
        const buffer = Buffer.from(`${JSON.stringify(slice)}\n`)
        for (let offset = 0; offset < buffer.length; ) {
          const { bytesWritten } = await file.write(
            buffer,
            offset,
            buffer.length - offset,
          )
          if (!bytesWritten) throw new Error('Invalid metadata cache write')
          offset += bytesWritten
        }
      }
      for (const slice of writer.write(tokens)) await write(slice)
      await write(writer.finish())
    } finally {
      await file.close()
    }
    if ((await cacheAvailable()) === base) {
      await rename(temporary, join(base, `${page.id}.json`))
      renamed = true
      return true
    }
  } catch {
    // Cache writes are optional; the parsed page remains usable.
  } finally {
    if (!renamed) await unlink(temporary).catch(() => {})
  }
  return false
}

async function incomplete(input: MetadataParseInput | MetadataFileInput) {
  if ('nativePath' in input) {
    const info = await lstat(input.nativePath, { bigint: true })
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      diskIndexVersion(info) !== input.expectedVersion
    )
      return null
  }
  const page = incompleteMetadataPage(input)
  page.details = {
    key: `${input.id}-${randomUUID()}`,
    count: 0,
    identity: headingIdentity(input),
    bytes: 0,
    complete: false,
  }
  await clearDetailLocation(input.id)
  detailLocations.set(input.id, {
    ...input,
    directory: headingDirectory,
    source: page.details,
    inline: [],
  })
  if (await remember(page, input.fingerprint, undefined, undefined, []))
    headingLocations.delete(input.id)
  else
    headingLocations.set(input.id, {
      version: input.version,
      fingerprint: input.fingerprint,
      path: input.path,
      directory: headingDirectory,
      store: undefined,
      complete: false,
    })
  return page
}

async function clearPruning(): Promise<void> {
  const directory = pruning
  pruning = undefined
  await directory?.close().catch(() => {})
}

async function cleanupTemporaries(): Promise<void> {
  const base = await cacheAvailable()
  if (!base) return
  try {
    const directory = await opendir(base)
    for await (const entry of directory) {
      if (temporaryPattern.test(entry.name)) await removeEntry(base, entry.name)
    }
  } catch {
    // Cache maintenance must not prevent indexing.
  }
}

async function finishBuild(remove: readonly string[]) {
  if (remove.length > 64 || remove.some((name) => !recordPattern.test(name)))
    throw new RangeError('Invalid metadata cache names')
  const base = await cacheAvailable()
  if (!base) {
    await clearPruning()
    return null
  }
  try {
    for (const name of remove) {
      const record = await readRecord(name.slice(0, -5))
      if (record?.headings)
        for (const suffix of ['hidx', 'hdat'])
          await removeEntry(base, `${record.headings.key}.${suffix}`)
      if (record?.page.details && record.inlineDetails === undefined)
        await removeEntry(base, `${record.page.details.key}.mdat`)
      await clearDetailLocation(name.slice(0, -5))
      await removeEntry(base, name)
      headingLocations.delete(name.slice(0, -5))
    }
    pruning ??= await opendir(base)
    const names: string[] = []
    // Bound enumeration itself, including unrelated entries.
    for (let count = 0; count < 64; count++) {
      const entry = await pruning.read()
      if (!entry) {
        if (!names.length) {
          await clearPruning()
          await cleanupTemporaries()
        }
        return { names, done: names.length === 0 }
      }
      if (recordPattern.test(entry.name)) names.push(entry.name)
      else if (headingStorePattern.test(entry.name)) {
        const id = entry.name.slice(0, 64)
        const record = await readRecord(id)
        if (
          (!record?.headings ||
            !entry.name.startsWith(`${record.headings.key}.`)) &&
          !entry.name.startsWith(`${headingLocations.get(id)?.store?.key}.`)
        )
          await removeEntry(base, entry.name)
      } else if (detailStorePattern.test(entry.name)) {
        const record = await readRecord(entry.name.slice(0, 64))
        if (
          (!record?.page.details ||
            entry.name !== `${record.page.details.key}.mdat`) &&
          entry.name !==
            `${detailLocations.get(entry.name.slice(0, 64))?.source.key}.mdat`
        )
          await removeEntry(base, entry.name)
      } else if (temporaryPattern.test(entry.name))
        await removeEntry(base, entry.name)
    }
    return { names, done: false }
  } catch {
    await clearPruning()
    return null
  }
}

async function clearParsing(): Promise<void> {
  const disk = parsing?.disk
  parsing = undefined
  await disk?.file.close()
}

async function fileStart(input: MetadataFileInput): Promise<boolean> {
  await clearParsing()
  const file = await open(
    input.nativePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const info = await file.stat({ bigint: true })
    if (!info.isFile() || diskIndexVersion(info) !== input.expectedVersion)
      return false
    parsing = {
      input,
      chunks: [],
      length: 0,
      received: 0,
      disk: {
        input,
        file,
        buffer: Buffer.alloc(64 * 1024),
        decoder: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }),
        remaining: info.size,
        done: false,
      },
    }
    return true
  } finally {
    if (!parsing) await file.close()
  }
}

async function fileChunk(): Promise<boolean | null> {
  const state = parsing
  const disk = state?.disk
  if (!state || !disk || disk.done) return null
  if (disk.remaining > 0n) {
    const length = Number(
      disk.remaining > BigInt(disk.buffer.length)
        ? BigInt(disk.buffer.length)
        : disk.remaining,
    )
    const { bytesRead } = await disk.file.read(disk.buffer, 0, length)
    if (!bytesRead) return null
    disk.remaining -= BigInt(bytesRead)
    state.chunks.push(
      disk.decoder.decode(disk.buffer.subarray(0, bytesRead), { stream: true }),
    )
    if (disk.remaining > 0n) return true
  }
  state.chunks.push(disk.decoder.decode())
  disk.done = true
  return false
}

async function derive(
  input: MetadataParseInput,
  chunks: readonly string[],
  fallback = false,
  current: () => Promise<boolean> = async () => true,
) {
  let directory =
    (idPattern.test(input.id) &&
      input.version.startsWith('disk:') &&
      (await cacheAvailable(true))) ||
    headingDirectory
  if (!(await headingDirectoryAvailable(directory))) return null
  let writer: HeadingStoreWriter | undefined
  const store = (into: string) =>
    new HeadingStoreWriter(
      into,
      idPattern.test(input.id)
        ? input.id
        : createHash('sha256').update(input.path).digest('hex'),
      headingIdentity(input),
    )
  const inline: NoteHeading[] = []
  let inlineLength = 0
  const onHeading = (heading: NoteHeading) => {
    if (
      !writer &&
      inline.length < inlineHeadingCount &&
      inlineLength + heading.text.length <= inlineHeadingLength
    ) {
      inline.push(heading)
      inlineLength += heading.text.length
      return
    }
    if (!writer) {
      try {
        writer = store(directory)
      } catch (error) {
        // A cache that refuses heading files is not a note read failure:
        // like an unsaved record's, the headings wait in a temporary file.
        if (directory === headingDirectory) throw error
        directory = headingDirectory
        writer = store(directory)
      }
      for (const earlier of inline.splice(0)) writer.add(earlier)
    }
    writer.add(heading)
  }
  let detailWriter = new DetailStoreWriter(
    directory,
    idPattern.test(input.id)
      ? input.id
      : createHash('sha256').update(input.path).digest('hex'),
    headingIdentity(input),
    {
      fallbackDirectory: headingDirectory,
      inline: directory !== headingDirectory,
    },
  )
  let detailsComplete = false
  let page: WorkspaceMetadataPage
  try {
    if (fallback)
      page = parseWorkspaceMetadataFallback(input, chunks, onHeading)
    else {
      try {
        const source = chunks.join('')
        const syntax = applySourceSyntax(input.syntax, source)
        page = {
          id: input.id,
          path: input.path,
          version: input.version,
          syntax,
          metadata: parsePositionedMetadata(
            { id: input.id, path: input.path, markdown: source },
            syntax,
            (entry) => detailWriter.add(entry),
            onHeading,
            (complete) => {
              detailsComplete = complete
            },
          ),
        }
      } catch (error) {
        detailWriter.abort()
        detailWriter = new DetailStoreWriter(
          headingDirectory,
          idPattern.test(input.id)
            ? input.id
            : createHash('sha256').update(input.path).digest('hex'),
          headingIdentity(input),
          { inline: false },
        )
        detailsComplete = false
        writer?.abort()
        writer = undefined
        inline.length = 0
        inlineLength = 0
        if (readFailure(error)) throw error
        page = parseWorkspaceMetadataFallback(input, chunks, onHeading)
      }
    }
    const details = detailWriter.finish(detailsComplete && page.syntax.complete)
    page.details = details
    const headings = writer?.finish()
    page.metadata.headings = {
      items: [],
      complete: page.metadata.headings.complete,
      count: headings?.count ?? inline.length,
      paged: true,
    }
    if (!(await headingDirectoryAvailable(directory)) || !(await current())) {
      writer?.abort()
      detailWriter.abort()
      return null
    }
    await clearDetailLocation(input.id)
    const detailLocation = {
      version: input.version,
      fingerprint: input.fingerprint,
      path: input.path,
      directory: detailWriter.directory,
      source: details,
    }
    detailLocations.set(input.id, detailLocation)
    const previous = headingLocations.get(input.id)
    const location = {
      version: input.version,
      fingerprint: input.fingerprint,
      path: input.path,
      directory,
      store: headings,
      complete: page.metadata.headings.complete && page.syntax.complete,
    }
    headingLocations.set(input.id, location)
    if (previous?.store && previous.directory === headingDirectory)
      for (const suffix of ['hidx', 'hdat'])
        await unlink(
          join(previous.directory, `${previous.store.key}.${suffix}`),
        ).catch(() => {})
    parentPort?.postMessage({ parsed: true })
    const saved =
      (directory !== headingDirectory || !headings) &&
      (detailWriter.directory !== headingDirectory || details.bytes === 0) &&
      (await remember(
        page,
        input.fingerprint,
        headings,
        inline.length ? inline : undefined,
        detailWriter.inline,
      ))
    if (saved) {
      headingLocations.delete(input.id)
      detailLocations.delete(input.id)
    } else {
      if (inline.length) {
        // Without a saved record, headings wait in a temporary heading file.
        writer = store(headingDirectory)
        for (const heading of inline) writer.add(heading)
        headingLocations.set(input.id, {
          ...location,
          directory: headingDirectory,
          store: writer.finish(),
        })
      }
      if (detailWriter.inline !== undefined) {
        const temporary = new DetailStoreWriter(
          headingDirectory,
          idPattern.test(input.id)
            ? input.id
            : createHash('sha256').update(input.path).digest('hex'),
          headingIdentity(input),
          { inline: false },
        )
        temporary.write(detailWriter.inline, details.count)
        page.details = temporary.finish(details.complete)
        detailLocations.set(input.id, {
          ...detailLocation,
          directory: headingDirectory,
          source: page.details,
        })
      }
    }
    return page
  } catch (error) {
    detailWriter.abort()
    writer?.abort()
    throw error
  }
}

async function parseEnd(
  fallback = false,
): Promise<WorkspaceMetadataPage | null> {
  const state = parsing
  if (!state) return null
  try {
    const current = async () => {
      const disk = state.disk
      if (!disk) return state.received === state.length
      if (!disk.done) return false
      const info = await disk.file.stat({ bigint: true })
      const pathInfo = await lstat(disk.input.nativePath, { bigint: true })
      return (
        info.isFile() &&
        pathInfo.isFile() &&
        !pathInfo.isSymbolicLink() &&
        diskIndexVersion(info) === disk.input.expectedVersion &&
        diskIndexVersion(pathInfo) === disk.input.expectedVersion
      )
    }
    if (!(await current())) return null
    return await derive(state.input, state.chunks, fallback, current)
  } finally {
    await clearParsing()
  }
}

function readFailure(error: unknown): boolean {
  return [
    'ENOENT',
    'ELOOP',
    'EISDIR',
    'ENOTDIR',
    'EACCES',
    'EPERM',
    'ESTALE',
    'EIO',
    'ERR_ENCODING_INVALID_ENCODED_DATA',
  ].includes((error as NodeJS.ErrnoException)?.code ?? '')
}

const startup = cleanupTemporaries()
void startup.then(() => parentPort?.postMessage({ ready: true }))

parentPort?.on('message', async (request: MetadataWorkerRequest) => {
  try {
    await startup
    let value: unknown
    if (request.kind === 'resultChunk') {
      parentPort?.postMessage({ value: await resultChunk() })
      return
    }
    await results?.return(undefined)
    results = undefined
    if (request.kind === 'incomplete') {
      value = await incomplete(request.input)
    } else if (request.kind === 'readDetails') {
      value = await readDetails(request.input, request.cursor)
    } else if (request.kind === 'readHeadings') {
      value = await readHeadings(request.input, request.offset, request.limit)
    } else if (request.kind === 'beginBuild') {
      await clearPruning()
      await cleanupTemporaries()
      value = true
    } else if (request.kind === 'finishBuild')
      value = await finishBuild(request.remove)
    else if (request.kind === 'fileStart')
      value = await fileStart(request.input)
    else if (request.kind === 'fileChunk') value = await fileChunk()
    else if (request.kind === 'sourceStart') {
      await clearParsing()
      if (!Number.isSafeInteger(request.length) || request.length < 0)
        throw new RangeError('Invalid metadata source length')
      parsing = {
        input: request.input,
        chunks: [],
        length: request.length,
        received: 0,
      }
      value = true
    } else if (request.kind === 'sourceChunk') {
      if (
        !parsing ||
        parsing.disk ||
        request.source.length > 32 * 1024 ||
        parsing.received + request.source.length > parsing.length
      )
        throw new RangeError('Invalid metadata source chunk')
      parsing.chunks.push(request.source)
      parsing.received += request.source.length
      value = true
    } else if (request.kind === 'parseEnd')
      value = await parseEnd(request.fallback)
    else if (request.kind === 'parseClear') {
      await clearParsing()
      value = true
    } else if (request.kind === 'cachedBatch') {
      results = resultPages(request.requests)
      parentPort?.postMessage({ value: await resultChunk() })
      return
    } else if (request.kind === 'cached')
      value = (await cacheAvailable()) ? await cached(request) : null
    else {
      await clearParsing()
      value = await derive(
        {
          id: request.page.id ?? '',
          path: request.page.path,
          version: request.version,
          syntax: request.syntax,
          fingerprint: request.fingerprint,
        },
        [request.page.markdown],
        request.fallback,
      )
    }
    if (value && typeof value === 'object' && 'metadata' in value) {
      results = resultPage(value)
      value = await resultChunk()
    }
    parentPort?.postMessage({ value })
  } catch (error) {
    await clearParsing()
    const disk =
      request.kind === 'fileStart' ||
      request.kind === 'fileChunk' ||
      request.kind === 'parseEnd' ||
      request.kind === 'incomplete'
    parentPort?.postMessage(
      disk && readFailure(error)
        ? { value: null }
        : {
            value: null,
            error: error instanceof Error ? error.message : String(error),
            code:
              error instanceof RangeError &&
              error.message === 'Invalid string length'
                ? 'ERR_STRING_TOO_LONG'
                : (error as NodeJS.ErrnoException)?.code,
          },
    )
  }
})
