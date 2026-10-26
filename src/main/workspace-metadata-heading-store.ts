import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { type FileHandle, lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { NoteHeading } from '../shared/note-metadata.ts'
import { diskIndexVersion } from './workspace-index-cache.ts'

export type HeadingStoreRecord = {
  key: string
  count: number
  identity: string
}
export type HeadingPage = {
  items: NoteHeading[]
  nextOffset: number
  hasMore: boolean
  complete: boolean
}
export const headingStorePattern = /^([a-f0-9]{64})-[a-f0-9-]{36}\.(hidx|hdat)$/
const keyPattern = /^[a-f0-9]{64}-[a-f0-9-]{36}$/
const headerBytes = 88
const entryBytes = 24
export const headingStoreBufferBytes = 64 * 1024
export const headingPageBytes = 32 * 1024
export const headingPageLimit = 1000

export function validHeadingStore(value: HeadingStoreRecord): boolean {
  return !!(
    value &&
    keyPattern.test(value.key) &&
    /^[a-f0-9]{64}$/.test(value.identity) &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0
  )
}

export async function headingDirectoryAvailable(
  directory: string,
): Promise<boolean> {
  try {
    const info = await lstat(directory)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

function writeAll(
  fd: number,
  buffer: Buffer,
  length: number,
  position: number,
): void {
  for (let offset = 0; offset < length; ) {
    const written = writeSync(
      fd,
      buffer,
      offset,
      length - offset,
      position + offset,
    )
    if (!written) throw new TypeError('Invalid metadata record')
    offset += written
  }
}

/** Worker-only sink: fixed buffers, no heading array or per-heading JSON tokens. */
export class HeadingStoreWriter {
  readonly record: HeadingStoreRecord
  readonly residentBytes = headingStoreBufferBytes * 2
  private index = Buffer.alloc(headingStoreBufferBytes)
  private data = Buffer.alloc(headingStoreBufferBytes)
  private indexLength = 0
  private dataLength = 0
  private indexPosition = headerBytes
  private dataPosition = headerBytes
  private indexFd: number | undefined
  private dataFd: number | undefined
  private directory: string

  constructor(directory: string, id: string, identity: string) {
    if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{64}$/.test(identity))
      throw new TypeError('Invalid metadata record')
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new TypeError('Invalid metadata record')
    this.directory = directory
    this.record = { key: `${id}-${randomUUID()}`, count: 0, identity }
    try {
      this.indexFd = openSync(
        join(directory, `.${this.record.key}.hidx.tmp`),
        'wx',
        0o600,
      )
      this.dataFd = openSync(
        join(directory, `.${this.record.key}.hdat.tmp`),
        'wx',
        0o600,
      )
    } catch (error) {
      this.abort()
      throw error
    }
  }

  private flushIndex(): void {
    writeAll(
      this.indexFd as number,
      this.index,
      this.indexLength,
      this.indexPosition,
    )
    this.indexPosition += this.indexLength
    this.indexLength = 0
  }

  private flushData(): void {
    writeAll(
      this.dataFd as number,
      this.data,
      this.dataLength,
      this.dataPosition,
    )
    this.dataPosition += this.dataLength
    this.dataLength = 0
  }

  add = (heading: NoteHeading): void => {
    if (this.indexLength + entryBytes > this.index.length) this.flushIndex()
    this.index.writeDoubleLE(
      this.dataPosition + this.dataLength,
      this.indexLength,
    )
    this.index.writeDoubleLE(heading.text.length, this.indexLength + 8)
    this.index.writeDoubleLE(heading.depth, this.indexLength + 16)
    this.indexLength += entryBytes
    this.record.count++
    for (let start = 0; start < heading.text.length; ) {
      if (this.dataLength === this.data.length) this.flushData()
      const end = Math.min(
        heading.text.length,
        start + (this.data.length - this.dataLength) / 2,
      )
      this.dataLength += this.data.write(
        heading.text.slice(start, end),
        this.dataLength,
        'utf16le',
      )
      start = end
    }
  }

  finish(): HeadingStoreRecord {
    try {
      this.flushIndex()
      this.flushData()
      const header = Buffer.alloc(headerBytes)
      header.write('HIBIHD01', 0, 'ascii')
      header.write(this.record.identity, 8, 'ascii')
      header.writeDoubleLE(this.record.count, 72)
      header.writeDoubleLE(this.dataPosition, 80)
      writeAll(this.indexFd as number, header, header.length, 0)
      writeAll(this.dataFd as number, header, header.length, 0)
      this.close()
      for (const suffix of ['hidx', 'hdat'])
        renameSync(
          join(this.directory, `.${this.record.key}.${suffix}.tmp`),
          join(this.directory, `${this.record.key}.${suffix}`),
        )
      return this.record
    } catch (error) {
      this.abort()
      throw error
    }
  }

  private close(): void {
    for (const fd of [this.indexFd, this.dataFd])
      if (fd !== undefined) closeSync(fd)
    this.indexFd = undefined
    this.dataFd = undefined
  }

  abort(): void {
    this.close()
    for (const suffix of ['hidx', 'hdat'])
      for (const name of [
        `${this.record.key}.${suffix}`,
        `.${this.record.key}.${suffix}.tmp`,
      ])
        try {
          unlinkSync(join(this.directory, name))
        } catch {}
  }
}

async function openChecked(path: string) {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) return null
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  let accepted = false
  try {
    const info = await file.stat({ bigint: true })
    if (!info.isFile() || before.ino !== info.ino || before.dev !== info.dev)
      return null
    accepted = true
    return { file, info, path }
  } finally {
    if (!accepted) await file.close()
  }
}

async function readAll(
  file: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<boolean> {
  for (let offset = 0; offset < buffer.length; ) {
    const { bytesRead } = await file.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    )
    if (!bytesRead) return false
    offset += bytesRead
  }
  return true
}

/** Seek to at most limit physical headings; skipped fields still advance the cursor. */
export async function readHeadingStore(
  directory: string,
  record: HeadingStoreRecord,
  offset: number,
  limit: number,
  complete: boolean,
): Promise<HeadingPage | null> {
  if (
    !validHeadingStore(record) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > headingPageLimit ||
    !(await headingDirectoryAvailable(directory))
  )
    return null
  const opened: NonNullable<Awaited<ReturnType<typeof openChecked>>>[] = []
  try {
    for (const suffix of ['hidx', 'hdat']) {
      const file = await openChecked(join(directory, `${record.key}.${suffix}`))
      if (!file) return null
      opened.push(file)
    }
    const [index, data] = opened
    if (!index || !data) return null
    const header = Buffer.alloc(headerBytes)
    if (
      !(await readAll(index.file, header, 0)) ||
      header.toString('ascii', 0, 8) !== 'HIBIHD01' ||
      header.toString('ascii', 8, 72) !== record.identity ||
      header.readDoubleLE(72) !== record.count ||
      index.info.size !==
        BigInt(headerBytes) + BigInt(record.count) * BigInt(entryBytes) ||
      header.readDoubleLE(80) !== Number(data.info.size)
    )
      return null
    const dataHeader = Buffer.alloc(headerBytes)
    if (
      !(await readAll(data.file, dataHeader, 0)) ||
      !header.equals(dataHeader)
    )
      return null
    const count = Math.min(limit, Math.max(0, record.count - offset))
    const entries = Buffer.alloc(count * entryBytes)
    if (
      !(await readAll(index.file, entries, headerBytes + offset * entryBytes))
    )
      return null
    const items: NoteHeading[] = []
    let nextOffset = offset
    let bytes = 0
    for (let index = 0; index < count; index++) {
      const position = entries.readDoubleLE(index * entryBytes)
      const length = entries.readDoubleLE(index * entryBytes + 8)
      const depth = entries.readDoubleLE(index * entryBytes + 16)
      if (
        !Number.isSafeInteger(position) ||
        position < headerBytes ||
        (position - headerBytes) % 2 !== 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        BigInt(position) + BigInt(length) * 2n > data.info.size ||
        !Number.isInteger(depth) ||
        depth < 1 ||
        depth > 6
      )
        return null
      if (length > headingPageBytes) {
        complete = false
        nextOffset++
        continue
      }
      const buffer = Buffer.alloc(length * 2)
      if (!(await readAll(data.file, buffer, position))) return null
      const text = buffer.toString('utf16le')
      const size = Buffer.byteLength(text)
      if (size > headingPageBytes) {
        complete = false
        nextOffset++
        continue
      }
      if (bytes + size > headingPageBytes) break
      items.push({ depth, text })
      nextOffset++
      bytes += size
    }
    for (const entry of opened) {
      const after = await entry.file.stat({ bigint: true })
      const pathInfo = await lstat(entry.path, { bigint: true })
      if (
        pathInfo.isSymbolicLink() ||
        diskIndexVersion(entry.info) !== diskIndexVersion(after) ||
        diskIndexVersion(entry.info) !== diskIndexVersion(pathInfo)
      )
        return null
    }
    if (!(await headingDirectoryAvailable(directory))) return null
    return { items, nextOffset, hasMore: nextOffset < record.count, complete }
  } catch {
    return null
  } finally {
    for (const entry of opened) await entry.file.close()
  }
}
