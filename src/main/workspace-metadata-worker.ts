import { randomUUID } from 'node:crypto'
import { constants, type Dir } from 'node:fs'
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { diskIndexVersion } from './workspace-index-cache.ts'
import {
  parseWorkspaceMetadata,
  type WorkspaceMetadataPage,
} from './workspace-index-metadata.ts'
import type {
  CachedMetadataRequest,
  MetadataFileInput,
  MetadataParseInput,
  MetadataWorkerRequest,
} from './workspace-metadata-parser.ts'
import { applySourceSyntax } from './workspace-syntax.ts'

const cacheDirectory = workerData.cacheDirectory as string | undefined
const buildIdentity = workerData.buildIdentity as string | undefined
const schema = 3
// Corrupt/oversize cache records are discarded; parsed content is never capped.
const maxCacheRecordBytes = 32 * 1024 * 1024
const maxBatchBytes = 4 * 1024 * 1024
const idPattern = /^[a-f0-9]{64}$/
const recordPattern = /^[a-f0-9]{64}\.json$/
const temporaryPattern = /^\.[a-f0-9]{64}-[a-f0-9-]{36}\.tmp$/
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
        done: boolean
      }
    }
  | undefined
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

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
    metadata.headings.items.every(
      (heading) =>
        Number.isInteger(heading.depth) &&
        heading.depth >= 1 &&
        heading.depth <= 6 &&
        typeof heading.text === 'string',
    )
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

async function cached(
  request: CachedMetadataRequest,
  budget = { bytes: maxCacheRecordBytes },
): Promise<WorkspaceMetadataPage | null> {
  if (!cacheDirectory || !idPattern.test(request.id)) return null
  try {
    const path = join(cacheDirectory, `${request.id}.json`)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) return null
    // O_NOFOLLOW closes the lstat/open race; a fixed read also bounds file growth.
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const info = await file.stat()
      if (
        !info.isFile() ||
        info.size > Math.min(maxCacheRecordBytes, budget.bytes)
      )
        return null
      budget.bytes -= info.size
      const buffer = Buffer.alloc(info.size + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
        )
        if (!bytesRead) break
        length += bytesRead
      }
      if (length !== info.size) return null
      const value = JSON.parse(buffer.subarray(0, length).toString('utf8'))
      const page = value.page as WorkspaceMetadataPage
      return value.schema === schema &&
        value.buildIdentity === buildIdentity &&
        value.fingerprint === request.fingerprint &&
        page?.id === request.id &&
        page.path === request.path &&
        page.version === request.version &&
        valid(page)
        ? page
        : null
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

async function cachedBatch(
  requests: readonly CachedMetadataRequest[],
): Promise<(WorkspaceMetadataPage | null)[]> {
  if (requests.length > 64)
    throw new RangeError('cachedBatch accepts 64 requests')
  const pages: (WorkspaceMetadataPage | null)[] = requests.map(() => null)
  if (!(await cacheAvailable())) return pages
  const budget = { bytes: maxBatchBytes - 1024 }
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(4, requests.length) }, async () => {
      while (next < requests.length) {
        const index = next++
        const request = requests[index]
        if (request) pages[index] = await cached(request, budget)
      }
    }),
  )
  return pages
}

async function remember(
  page: WorkspaceMetadataPage,
  fingerprint: string,
): Promise<void> {
  if (
    !cacheDirectory ||
    !buildIdentity ||
    !page.id ||
    !idPattern.test(page.id) ||
    !page.version.startsWith('disk:')
  )
    return
  const temporary = join(cacheDirectory, `.${page.id}-${randomUUID()}.tmp`)
  try {
    const record = JSON.stringify({ schema, buildIdentity, fingerprint, page })
    if (Buffer.byteLength(record) > maxCacheRecordBytes) return
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 })
    if (!(await cacheAvailable())) return
    await writeFile(temporary, record, { flag: 'wx', mode: 0o600 })
    await rename(temporary, join(cacheDirectory, `${page.id}.json`))
  } catch {
    // Cache writes are optional; the parsed page remains usable.
  } finally {
    await unlink(temporary).catch(() => {})
  }
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
    for (const name of remove)
      await unlink(join(cacheDirectory, name)).catch(() => {})
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
      else if (temporaryPattern.test(entry.name))
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
  const { bytesRead } = await disk.file.read(disk.buffer, 0, disk.buffer.length)
  if (bytesRead) {
    state.chunks.push(
      disk.decoder.decode(disk.buffer.subarray(0, bytesRead), { stream: true }),
    )
    return true
  }
  state.chunks.push(disk.decoder.decode())
  disk.done = true
  return false
}

async function derive(input: MetadataParseInput, source: string) {
  const syntax = applySourceSyntax(input.syntax, source)
  const page: WorkspaceMetadataPage = {
    id: input.id,
    path: input.path,
    version: input.version,
    syntax,
    metadata: parseWorkspaceMetadata(
      { id: input.id, path: input.path, markdown: source },
      syntax,
    ),
  }
  await remember(page, input.fingerprint)
  return page
}

async function parseEnd(): Promise<WorkspaceMetadataPage | null> {
  const state = parsing
  if (!state) return null
  try {
    if (state.disk) {
      const { file, input, done } = state.disk
      if (!done) return null
      const info = await file.stat({ bigint: true })
      const pathInfo = await lstat(input.nativePath, { bigint: true })
      if (
        !info.isFile() ||
        !pathInfo.isFile() ||
        pathInfo.isSymbolicLink() ||
        diskIndexVersion(info) !== input.expectedVersion ||
        diskIndexVersion(pathInfo) !== input.expectedVersion
      )
        return null
    } else if (state.received !== state.length) return null
    const source = state.chunks.join('')
    state.chunks.length = 0
    return await derive(state.input, source)
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
    'ERR_ENCODING_INVALID_ENCODED_DATA',
  ].includes((error as NodeJS.ErrnoException)?.code ?? '')
}

const startup = cleanupTemporaries()

parentPort?.on('message', async (request: MetadataWorkerRequest) => {
  try {
    await startup
    let value: unknown
    if (request.kind === 'beginBuild') {
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
    } else if (request.kind === 'parseEnd') value = await parseEnd()
    else if (request.kind === 'parseClear') {
      await clearParsing()
      value = true
    } else if (request.kind === 'cachedBatch')
      value = await cachedBatch(request.requests)
    else if (request.kind === 'cached')
      value = (await cacheAvailable()) ? await cached(request) : null
    else {
      await clearParsing()
      const syntax = applySourceSyntax(request.syntax, request.page.markdown)
      const page: WorkspaceMetadataPage = {
        ...(request.page.id ? { id: request.page.id } : {}),
        path: request.page.path,
        version: request.version,
        syntax,
        metadata: parseWorkspaceMetadata(request.page, syntax),
      }
      await remember(page, request.fingerprint)
      value = page
    }
    parentPort?.postMessage({ value })
  } catch (error) {
    await clearParsing()
    const disk =
      request.kind === 'fileStart' ||
      request.kind === 'fileChunk' ||
      request.kind === 'parseEnd'
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
