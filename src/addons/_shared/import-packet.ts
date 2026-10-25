import type { ImportEntry } from '../../shared/imports'

export const IMPORT_PACKET_FILES = 1000
export const IMPORT_PACKET_BYTES = 4 * 1024 * 1024
type PackedEntry = {
  path: string
  original?: number
  offset?: number
  length?: number
}
export type ImportPacket = { files: PackedEntry[]; bytes: ArrayBuffer }

/** One transfer per packet avoids Node's quadratic transfer-list duplicate check. */
export function packImportEntries(
  entries: readonly ImportEntry[],
): ImportPacket {
  let size = 0
  const files = entries.map((entry) => {
    const file: PackedEntry = { path: entry.path }
    if (entry.original !== undefined) file.original = entry.original
    if (entry.data instanceof Uint8Array) {
      if (entry.data.byteLength > 32 * 1024 * 1024)
        throw new Error('Import files must each be under 32 MiB.')
      file.offset = size
      file.length = entry.data.byteLength
      size += entry.data.byteLength
    } else if (!Number.isSafeInteger(entry.original))
      throw new Error('The import contains an unsafe file path.')
    return file
  })
  const bytes = new Uint8Array(size)
  entries.forEach((entry, index) => {
    if (entry.data) bytes.set(entry.data, files[index]?.offset)
  })
  return { files, bytes: bytes.buffer }
}
export function unpackImportEntries(packet: ImportPacket): ImportEntry[] {
  return packet.files.map((file) => ({
    path: file.path,
    ...(file.original === undefined ? {} : { original: file.original }),
    ...(file.offset === undefined
      ? {}
      : {
          data: new Uint8Array(packet.bytes, file.offset, file.length),
        }),
  }))
}
