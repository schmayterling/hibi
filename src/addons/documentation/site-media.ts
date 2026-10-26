import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { openMedia } from '../../main/document-media.ts'
import { resolveDocumentMediaPath } from '../../main/images.ts'
import { validateSiteFiles } from './site-runtime.ts'

export type SiteAsset = {
  path: string
  source: string
  bytes: number
  mtimeMs: number
}

export async function* readSiteAsset(asset: SiteAsset, signal?: AbortSignal) {
  const { file, stat } = await openMedia(asset.source, signal)
  let copied = 0
  let chunks: ReturnType<typeof file.createReadStream> | undefined
  try {
    if (stat.size !== asset.bytes || stat.mtimeMs !== asset.mtimeMs)
      throw new Error('The attachment changed while copying. Try again.')
    chunks = file.createReadStream({
      start: 0,
      end: stat.size - 1,
      autoClose: false,
      signal,
    })
    for await (const chunk of chunks) {
      copied += chunk.length
      yield chunk as Buffer
    }
    const current = await file.stat()
    if (
      copied !== asset.bytes ||
      current.size !== asset.bytes ||
      current.mtimeMs !== asset.mtimeMs
    )
      throw new Error('The attachment changed while copying. Try again.')
  } finally {
    chunks?.destroy()
    await file.close()
  }
}

/** Private source references never cross the renderer bridge as media bytes. */
export class SiteMedia {
  private assets: string
  private inMemory: boolean
  private signal: AbortSignal
  private sources = new Map<string, Promise<SiteAsset | null>>()
  private references = new Map<string, SiteAsset>()
  private bytes = 0

  constructor(assets: string, inMemory: boolean, signal: AbortSignal) {
    this.assets = assets
    this.inMemory = inMemory
    this.signal = signal
  }

  files() {
    return [...this.references.values()]
  }

  async stage(
    source: string,
    note: string,
    workspace: string,
  ): Promise<string | null> {
    this.signal.throwIfAborted()
    const path = await resolveDocumentMediaPath(source, note, workspace)
    if (!path) return null
    let captured = this.sources.get(path)
    if (!captured) {
      captured = this.capture(path)
      this.sources.set(path, captured)
    }
    const asset = await captured
    if (asset) {
      if (this.inMemory) {
        this.bytes += 4 * Math.ceil(asset.bytes / 3)
        validateSiteFiles([{ path: asset.path, bytes: this.bytes }])
      }
      this.references.set(asset.path, asset)
    }
    return asset?.path ?? null
  }

  async publish(relative: string, destination: string) {
    const asset = this.references.get(relative)
    if (!asset) return false
    const output = await open(destination, 'wx', 0o600)
    try {
      await output.writeFile(readSiteAsset(asset, this.signal))
      this.signal.throwIfAborted()
    } finally {
      await output.close()
    }
    return true
  }

  private async capture(source: string) {
    let media: Awaited<ReturnType<typeof openMedia>>
    try {
      media = await openMedia(source, this.signal)
    } catch {
      this.signal.throwIfAborted()
      return null
    }
    try {
      const { stat, mime } = media
      if (this.inMemory)
        validateSiteFiles([
          { path: 'media', bytes: 4 * Math.ceil(stat.size / 3) },
        ])
      const id = createHash('sha256').update(source).digest('hex')
      const extension = mime === 'image/svg+xml' ? 'svg' : mime.split('/')[1]
      return {
        path: `${this.assets}/media/${id}.${extension}`,
        source,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
      }
    } finally {
      await media.file.close()
    }
  }
}

export async function* base64Chunks(chunks: AsyncIterable<Uint8Array>) {
  const buffer = Buffer.allocUnsafe(48 * 1024)
  let used = 0
  for await (const chunk of chunks)
    for (let offset = 0; offset < chunk.length; ) {
      const length = Math.min(buffer.length - used, chunk.length - offset)
      buffer.set(chunk.subarray(offset, offset + length), used)
      offset += length
      used += length
      if (used === buffer.length) {
        yield buffer.toString('base64')
        used = 0
      }
    }
  if (used) yield buffer.subarray(0, used).toString('base64')
}
