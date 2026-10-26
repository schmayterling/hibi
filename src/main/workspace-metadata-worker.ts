import { createHash, randomUUID } from 'node:crypto'
import { constants, type Dir } from 'node:fs'
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  unlink,
} from 'node:fs/promises'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { sameFileIdentity } from '../shared/file-identity.ts'
import { diskIndexVersion } from './workspace-index-cache.ts'
import {
  parseWorkspaceMetadata,
  type WorkspaceMetadataPage,
} from './workspace-index-metadata.ts'
import { parseWorkspaceMetadataFallback } from './workspace-metadata-fallback.ts'
import {
  type HeadingStoreRecord,
  HeadingStoreWriter,
  headingDirectoryAvailable,
  headingStorePattern,
  readHeadingStore,
  validHeadingStore,
} from './workspace-metadata-heading-store.ts'
import type {
  CachedMetadataRequest,
  MetadataFileInput,
  MetadataParseInput,
  MetadataWorkerRequest,
} from './workspace-metadata-parser.ts'
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
const schema = 5
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
type CacheRecord = {
  schema: number
  buildIdentity: string
  fingerprint: string
  page: WorkspaceMetadataPage
  headings?: HeadingStoreRecord
}
const idPattern = /^[a-f0-9]{64}$/
const recordPattern = /^[a-f0-9]{64}\.json$/
const temporaryPattern = /^\.[a-f0-9]{64}-[a-f0-9-]{36}(?:\.hidx|\.hdat)?\.tmp$/
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

async function cacheAvailable(): Promise<boolean> {
  if (!cacheDirectory || !buildIdentity) return false
  try {
    const info = await lstat(cacheDirectory)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

async function readRecord(id: string): Promise<CacheRecord | null> {
  if (!cacheDirectory || !idPattern.test(id) || !(await cacheAvailable()))
    return null
  try {
    const path = join(cacheDirectory, `${id}.json`)
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
      const reader = new RecordReader(undefined, true)
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
        !(await cacheAvailable())
      )
        return null
      const value = reader.finish() as CacheRecord
      const page = value.page as WorkspaceMetadataPage
      return value.schema === schema &&
        value.buildIdentity === buildIdentity &&
        typeof value.fingerprint === 'string' &&
        page?.id === id &&
        valid(page) &&
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
        (page.metadata.headings.count === 0 || !!value.headings)
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
  if (!record.headings)
    return { items: [], nextOffset: offset, hasMore: false, complete }
  return readHeadingStore(
    cacheDirectory as string,
    record.headings,
    offset,
    limit,
    complete,
  )
}

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
    for (const tokens of writer.write(recordTokens(page)))
      yield { tokens, done: false }
  }
  for (const tokens of writer.write([']'])) yield { tokens, done: false }
  yield { tokens: writer.finish(), done: true }
}

async function* resultPage(value: unknown): AsyncGenerator<RecordSlice> {
  const writer = new RecordWriter()
  for (const tokens of writer.write(recordTokens(value)))
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
): Promise<boolean> {
  if (
    !cacheDirectory ||
    !buildIdentity ||
    !page.id ||
    !idPattern.test(page.id) ||
    !page.version.startsWith('disk:')
  )
    return false
  const temporary = join(cacheDirectory, `.${page.id}-${randomUUID()}.tmp`)
  try {
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 })
    if (!(await cacheAvailable())) return false
    const file = await open(temporary, 'wx', 0o600)
    try {
      const writer = new RecordWriter()
      const tokens = recordTokens({
        schema,
        buildIdentity,
        fingerprint,
        page,
        headings,
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
    if (await cacheAvailable()) {
      await rename(temporary, join(cacheDirectory, `${page.id}.json`))
      return true
    }
  } catch {
    // Cache writes are optional; the parsed page remains usable.
  } finally {
    await unlink(temporary).catch(() => {})
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
  if (await remember(page, input.fingerprint)) headingLocations.delete(input.id)
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
  if (!cacheDirectory || !(await cacheAvailable())) return
  try {
    const directory = await opendir(cacheDirectory)
    for await (const entry of directory) {
      if (temporaryPattern.test(entry.name) && (await cacheAvailable()))
        await unlink(join(cacheDirectory, entry.name)).catch(() => {})
    }
  } catch {
    // Cache maintenance must not prevent indexing.
  }
}

async function finishBuild(remove: readonly string[]) {
  if (remove.length > 64 || remove.some((name) => !recordPattern.test(name)))
    throw new RangeError('Invalid metadata cache names')
  if (!cacheDirectory || !(await cacheAvailable())) {
    await clearPruning()
    return null
  }
  try {
    for (const name of remove) {
      const record = await readRecord(name.slice(0, -5))
      if (record?.headings)
        for (const suffix of ['hidx', 'hdat'])
          await unlink(
            join(cacheDirectory, `${record.headings.key}.${suffix}`),
          ).catch(() => {})
      await unlink(join(cacheDirectory, name)).catch(() => {})
      headingLocations.delete(name.slice(0, -5))
    }
    pruning ??= await opendir(cacheDirectory)
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
          !record?.headings ||
          !entry.name.startsWith(`${record.headings.key}.`)
        )
          await unlink(join(cacheDirectory, entry.name)).catch(() => {})
      } else if (temporaryPattern.test(entry.name))
        await unlink(join(cacheDirectory, entry.name)).catch(() => {})
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
  let directory = headingDirectory
  if (
    cacheDirectory &&
    buildIdentity &&
    idPattern.test(input.id) &&
    input.version.startsWith('disk:')
  ) {
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 }).catch(
      () => {},
    )
    if (await cacheAvailable()) directory = cacheDirectory
  }
  if (!(await headingDirectoryAvailable(directory))) return null
  let writer: HeadingStoreWriter | undefined
  const onHeading = (heading: Parameters<HeadingStoreWriter['add']>[0]) => {
    writer ??= new HeadingStoreWriter(
      directory,
      idPattern.test(input.id)
        ? input.id
        : createHash('sha256').update(input.path).digest('hex'),
      headingIdentity(input),
    )
    writer.add(heading)
  }
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
          metadata: parseWorkspaceMetadata(
            { id: input.id, path: input.path, markdown: source },
            syntax,
            undefined,
            onHeading,
          ),
        }
      } catch (error) {
        writer?.abort()
        writer = undefined
        if (readFailure(error)) throw error
        page = parseWorkspaceMetadataFallback(input, chunks, onHeading)
      }
    }
    const headings = writer?.finish()
    page.metadata.headings = {
      items: [],
      complete: page.metadata.headings.complete,
      count: headings?.count ?? 0,
      paged: true,
    }
    if (!(await headingDirectoryAvailable(directory)) || !(await current())) {
      writer?.abort()
      return null
    }
    const previous = headingLocations.get(input.id)
    headingLocations.set(input.id, {
      version: input.version,
      fingerprint: input.fingerprint,
      path: input.path,
      directory,
      store: headings,
      complete: page.metadata.headings.complete && page.syntax.complete,
    })
    if (previous?.store && previous.directory === headingDirectory)
      for (const suffix of ['hidx', 'hdat'])
        await unlink(
          join(previous.directory, `${previous.store.key}.${suffix}`),
        ).catch(() => {})
    parentPort?.postMessage({ parsed: true })
    if (directory === cacheDirectory || !headings) {
      if (await remember(page, input.fingerprint, headings))
        headingLocations.delete(input.id)
    }
    return page
  } catch (error) {
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
