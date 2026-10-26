import { createHash } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { openMedia } from '../../main/document-media.ts'
import { resolveDocumentMediaPath } from '../../main/images.ts'
import { validateSiteFiles } from './site-runtime.ts'

/** Session-owned copies never cross the renderer bridge as media bytes. */
export class SiteMedia {
  private directory: string
  private assets: string
  private inMemory: boolean
  private signal: AbortSignal
  private copies = new Map<
    string,
    Promise<{ path: string; bytes: number } | null>
  >()
  private bytes = 0

  constructor(
    directory: string,
    assets: string,
    inMemory: boolean,
    signal: AbortSignal,
  ) {
    this.directory = directory
    this.assets = assets
    this.inMemory = inMemory
    this.signal = signal
  }

  async stage(
    source: string,
    note: string,
    workspace: string,
  ): Promise<string | null> {
    this.signal.throwIfAborted()
    const path = await resolveDocumentMediaPath(source, note, workspace)
    if (!path) return null
    let copy = this.copies.get(path)
    if (!copy) {
      copy = this.copy(path)
      this.copies.set(path, copy)
    }
    const media = await copy
    if (media && this.inMemory) {
      this.bytes += 4 * Math.ceil(media.bytes / 3)
      validateSiteFiles([{ path: media.path, bytes: this.bytes }])
    }
    return media?.path ?? null
  }

  private async copy(path: string) {
    let media: Awaited<ReturnType<typeof openMedia>>
    try {
      media = await openMedia(path, this.signal)
    } catch {
      this.signal.throwIfAborted()
      return null
    }
    const { file, stat, mime } = media
    try {
      if (this.inMemory)
        validateSiteFiles([
          { path: 'media', bytes: 4 * Math.ceil(stat.size / 3) },
        ])
      const id = createHash('sha256').update(path).digest('hex')
      const extension = mime === 'image/svg+xml' ? 'svg' : mime.split('/')[1]
      const relative = `${this.assets}/media/${id}.${extension}`
      const destination = join(this.directory, 'assets', relative)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      const output = await open(destination, 'wx', 0o600)
      let copied = 0
      const chunks = file.createReadStream({
        start: 0,
        end: stat.size - 1,
        autoClose: false,
        signal: this.signal,
      })
      try {
        async function* bytes() {
          for await (const chunk of chunks) {
            copied += chunk.length
            yield chunk
          }
        }
        await output.writeFile(bytes())
        this.signal.throwIfAborted()
        const current = await file.stat()
        if (
          copied !== stat.size ||
          current.size !== stat.size ||
          current.mtimeMs !== stat.mtimeMs
        )
          throw new Error('The attachment changed while copying. Try again.')
      } finally {
        chunks.destroy()
        await output.close()
      }
      this.signal.throwIfAborted()
      return { path: relative, bytes: copied }
    } finally {
      await file.close()
    }
  }
}

export async function* base64Chunks(chunks: AsyncIterable<Uint8Array>) {
  let remainder = Buffer.alloc(0)
  for await (const chunk of chunks) {
    const bytes = Buffer.concat([remainder, chunk])
    const end = bytes.length - (bytes.length % 3)
    yield bytes.subarray(0, end).toString('base64')
    remainder = bytes.subarray(end)
  }
  if (remainder.length) yield remainder.toString('base64')
}
