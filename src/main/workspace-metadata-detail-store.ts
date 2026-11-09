import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { sameFileIdentity } from '../shared/file-identity.ts'
import {
  type DetailPage,
  DetailReader,
  type RecordToken,
  RecordWriter,
  recordSliceBytes,
  recordTokens,
  validateRecordTokens,
  type WorkspaceMetadataDetailSource,
} from '../shared/metadata-stream.ts'
import type { NoteCacheEntry } from '../shared/note-cache.ts'
import { diskIndexVersion } from './workspace-index-cache.ts'
import {
  headingDirectoryAvailable,
  openChecked,
  readAll,
  writeAll,
} from './workspace-metadata-heading-store.ts'

export const detailStorePattern = /^([a-f0-9]{64})-[a-f0-9-]{36}\.mdat$/
const keyPattern = /^[a-f0-9]{64}-[a-f0-9-]{36}$/
const headerBytes = 96
const frameBytes = 16
export const inlineDetailBytes = 8192

export function validDetailSource(
  value: WorkspaceMetadataDetailSource,
): boolean {
  return !!(
    value &&
    Object.keys(value).length === 5 &&
    typeof value.key === 'string' &&
    typeof value.identity === 'string' &&
    keyPattern.test(value.key) &&
    /^[a-f0-9]{64}$/.test(value.identity) &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0 &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    typeof value.complete === 'boolean' &&
    (value.count === 0) === (value.bytes === 0)
  )
}

/** Small streams share the note's cache record; larger ones have bounded frames. */
export class DetailStoreWriter {
  readonly record: WorkspaceMetadataDetailSource
  inline: RecordToken[] | undefined
  private writer = new RecordWriter()
  private fd: number | undefined
  directory: string
  private folder: import('node:fs').BigIntStats
  private fallbackDirectory: string | undefined
  private allowInline: boolean
  private temporary: string
  private stored: string | undefined
  private created: import('node:fs').BigIntStats | undefined

  constructor(
    directory: string,
    id: string,
    identity: string,
    options: { fallbackDirectory?: string; inline?: boolean } = {},
  ) {
    if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{64}$/.test(identity))
      throw new TypeError('Invalid metadata record')
    this.directory = directory
    this.fallbackDirectory = options.fallbackDirectory
    this.allowInline = options.inline !== false
    this.folder = lstatSync(directory, { bigint: true })
    if (!this.folder.isDirectory() || this.folder.isSymbolicLink())
      throw new TypeError('Invalid metadata record')
    this.record = {
      key: `${id}-${randomUUID()}`,
      count: 0,
      identity,
      bytes: 0,
      complete: false,
    }
    this.temporary = join(directory, `.${this.record.key}.mdat.tmp`)
  }

  add(entry: NoteCacheEntry): void {
    this.write(recordTokens(entry), 1)
  }

  write(tokens: Iterable<RecordToken>, count: number): void {
    for (const slice of this.writer.write(tokens)) this.flush(slice)
    this.record.count += count
  }

  private openFile(): void {
    this.temporary = join(this.directory, `.${this.record.key}.mdat.tmp`)
    this.fd = openSync(this.temporary, 'wx', 0o600)
    this.stored = this.temporary
    this.created = fstatSync(this.fd, { bigint: true })
    if (
      !sameFileIdentity(
        statSync(this.directory, { bigint: true }),
        this.folder,
      ) ||
      !sameFileIdentity(
        fstatSync(this.fd, { bigint: true }),
        lstatSync(this.temporary, { bigint: true }),
      )
    )
      throw new TypeError('Invalid metadata record')
  }

  private flush(tokens: RecordToken[], final = false): void {
    if (!tokens.length) return
    const buffer = Buffer.from(JSON.stringify(tokens))
    if (buffer.length > recordSliceBytes)
      throw new TypeError('Invalid metadata slice')
    if (
      final &&
      this.allowInline &&
      this.fd === undefined &&
      buffer.length <= inlineDetailBytes
    ) {
      this.inline = tokens
    } else {
      if (this.fd === undefined) {
        try {
          this.openFile()
        } catch (error) {
          this.abort()
          if (
            !this.fallbackDirectory ||
            this.directory === this.fallbackDirectory
          )
            throw error
          this.directory = this.fallbackDirectory
          this.folder = lstatSync(this.directory, { bigint: true })
          if (!this.folder.isDirectory() || this.folder.isSymbolicLink())
            throw error
          this.openFile()
        }
      }
      const header = Buffer.alloc(frameBytes)
      header.write('MDP1', 0, 'ascii')
      header.writeDoubleLE(this.record.bytes, 4)
      header.writeUInt32LE(buffer.length, 12)
      writeAll(
        this.fd as number,
        header,
        header.length,
        headerBytes + this.record.bytes,
      )
      writeAll(
        this.fd as number,
        buffer,
        buffer.length,
        headerBytes + this.record.bytes + frameBytes,
      )
    }
    this.record.bytes += frameBytes + buffer.length
  }

  finish(complete: boolean): WorkspaceMetadataDetailSource {
    try {
      this.flush(this.writer.finish(), true)
      this.record.complete = complete
      if (!this.record.count) this.inline = []
      if (this.fd !== undefined) {
        const header = Buffer.alloc(headerBytes)
        header.write('HIBIMD01', 0, 'ascii')
        header.write(this.record.identity, 8, 'ascii')
        header.writeDoubleLE(this.record.count, 72)
        header.writeDoubleLE(this.record.bytes, 80)
        header.writeUInt8(complete ? 1 : 0, 88)
        if (
          !sameFileIdentity(
            statSync(this.directory, { bigint: true }),
            this.folder,
          ) ||
          !sameFileIdentity(
            fstatSync(this.fd, { bigint: true }),
            lstatSync(this.temporary, { bigint: true }),
          )
        )
          throw new TypeError('Invalid metadata record')
        writeAll(this.fd, header, header.length, 0)
        closeSync(this.fd)
        this.fd = undefined
        const target = join(this.directory, `${this.record.key}.mdat`)
        renameSync(this.temporary, target)
        this.stored = target
      }
      return this.record
    } catch (error) {
      this.abort()
      throw error
    }
  }

  abort(): void {
    if (this.fd !== undefined) closeSync(this.fd)
    this.fd = undefined
    const stored = this.stored
    this.stored = undefined
    if (!stored) return
    try {
      // Our own new file goes even when the folder became a link after it was made.
      if (
        sameFileIdentity(
          lstatSync(this.directory, { bigint: true }),
          this.folder,
        ) ||
        (this.created &&
          sameFileIdentity(lstatSync(stored, { bigint: true }), this.created))
      )
        unlinkSync(stored)
    } catch {}
  }
}

export function validInlineDetails(
  source: WorkspaceMetadataDetailSource,
  tokens: RecordToken[],
): boolean {
  try {
    validateRecordTokens(tokens)
    if (
      Buffer.byteLength(JSON.stringify(tokens)) > inlineDetailBytes ||
      source.bytes !==
        (tokens.length
          ? frameBytes + Buffer.byteLength(JSON.stringify(tokens))
          : 0)
    )
      return false
    const reader = new DetailReader()
    let count = 0
    for (const _entry of reader.write(tokens)) count++
    reader.finish()
    return count === source.count
  } catch {
    return false
  }
}

function validCursor(
  source: WorkspaceMetadataDetailSource,
  cursor: number,
): boolean {
  return (
    validDetailSource(source) &&
    Number.isSafeInteger(cursor) &&
    cursor >= 0 &&
    cursor <= source.bytes
  )
}

export function readInlineDetails(
  source: WorkspaceMetadataDetailSource,
  tokens: RecordToken[],
  cursor: number,
): DetailPage | null {
  if (
    !validCursor(source, cursor) ||
    (cursor !== 0 && cursor !== source.bytes) ||
    !validInlineDetails(source, tokens)
  )
    return null
  return {
    tokens: cursor === 0 ? tokens : [],
    nextCursor: source.bytes,
    hasMore: false,
    complete: source.complete,
    source,
  }
}

/** Read one physical frame by byte cursor; never reconstruct a whole note. */
export async function readDetailStore(
  directory: string,
  source: WorkspaceMetadataDetailSource,
  cursor: number,
): Promise<DetailPage | null> {
  if (
    !validCursor(source, cursor) ||
    !(await headingDirectoryAvailable(directory))
  )
    return null
  let opened: Awaited<ReturnType<typeof openChecked>> = null
  try {
    const path = join(directory, `${source.key}.mdat`)
    opened = await openChecked(path)
    if (!opened) return null
    const header = Buffer.alloc(headerBytes)
    if (
      !(await readAll(opened.file, header, 0)) ||
      header.toString('ascii', 0, 8) !== 'HIBIMD01' ||
      header.toString('ascii', 8, 72) !== source.identity ||
      header.readDoubleLE(72) !== source.count ||
      header.readDoubleLE(80) !== source.bytes ||
      header.readUInt8(88) !== Number(source.complete) ||
      opened.info.size !== BigInt(headerBytes) + BigInt(source.bytes)
    )
      return null
    let tokens: RecordToken[] = []
    let nextCursor = cursor
    if (cursor < source.bytes) {
      const frame = Buffer.alloc(frameBytes)
      if (
        !(await readAll(opened.file, frame, headerBytes + cursor)) ||
        frame.toString('ascii', 0, 4) !== 'MDP1' ||
        frame.readDoubleLE(4) !== cursor
      )
        return null
      const length = frame.readUInt32LE(12)
      nextCursor += frameBytes + length
      if (!length || length > recordSliceBytes || nextCursor > source.bytes)
        return null
      const buffer = Buffer.alloc(length)
      if (
        !(await readAll(opened.file, buffer, headerBytes + cursor + frameBytes))
      )
        return null
      const parsed: unknown = JSON.parse(buffer.toString('utf8'))
      validateRecordTokens(parsed)
      tokens = parsed
    }
    const after = await opened.file.stat({ bigint: true })
    const pathInfo = await lstat(path, { bigint: true })
    if (
      pathInfo.isSymbolicLink() ||
      diskIndexVersion(opened.info) !== diskIndexVersion(after) ||
      diskIndexVersion(opened.info) !== diskIndexVersion(pathInfo) ||
      !(await headingDirectoryAvailable(directory))
    )
      return null
    return {
      tokens,
      nextCursor,
      hasMore: nextCursor < source.bytes,
      complete: source.complete,
      source,
    }
  } catch {
    return null
  } finally {
    await opened?.file.close()
  }
}
