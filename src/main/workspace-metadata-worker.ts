import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import {
  parseWorkspaceMetadata,
  type WorkspaceMetadataPage,
} from './workspace-index-metadata.ts'
import type { MetadataRequest } from './workspace-metadata-parser.ts'

const cacheDirectory = workerData.cacheDirectory as string | undefined
const schema = 2
// A corrupt cache record is discarded; this never limits a workspace or query.
const maxCacheRecordBytes = 32 * 1024 * 1024
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
        /^[a-f0-9]{64}$/.test(key) &&
        strings(values) &&
        values.every((value) => /^[a-f0-9]{64}$/.test(value)),
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

async function cached(
  request: Extract<MetadataRequest, { kind: 'cached' }>,
): Promise<WorkspaceMetadataPage | null> {
  if (!cacheDirectory || !/^[a-f0-9]{64}$/.test(request.id)) return null
  try {
    const path = join(cacheDirectory, `${request.id}.json`)
    const info = await lstat(path)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > maxCacheRecordBytes
    )
      return null
    const value = JSON.parse(await readFile(path, 'utf8'))
    const page = value.page as WorkspaceMetadataPage
    return value.schema === schema &&
      value.fingerprint === request.fingerprint &&
      page?.id === request.id &&
      page.path === request.path &&
      page.version === request.version &&
      valid(page)
      ? page
      : null
  } catch {
    return null
  }
}

async function remember(
  page: WorkspaceMetadataPage,
  fingerprint: string,
): Promise<void> {
  if (
    !cacheDirectory ||
    !page.id ||
    !/^[a-f0-9]{64}$/.test(page.id) ||
    !page.version.startsWith('disk:')
  )
    return
  const temporary = join(cacheDirectory, `.${page.id}-${randomUUID()}.tmp`)
  try {
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 })
    await writeFile(temporary, JSON.stringify({ schema, fingerprint, page }), {
      flag: 'wx',
      mode: 0o600,
    })
    await rename(temporary, join(cacheDirectory, `${page.id}.json`))
  } catch {
    // Cache writes are optional; the parsed page remains usable.
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

parentPort?.on('message', async (request: MetadataRequest) => {
  try {
    if (request.kind === 'cached') {
      parentPort?.postMessage({ page: await cached(request) })
      return
    }
    const page: WorkspaceMetadataPage = {
      ...(request.page.id ? { id: request.page.id } : {}),
      path: request.page.path,
      version: request.version,
      syntax: request.syntax,
      metadata: parseWorkspaceMetadata(request.page, request.syntax),
    }
    await remember(page, request.fingerprint)
    parentPort?.postMessage({ page })
  } catch (error) {
    parentPort?.postMessage({
      page: null,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
