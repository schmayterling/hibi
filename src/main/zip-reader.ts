import { addAbortSignal } from 'node:stream'
import { crc32 } from 'node:zlib'
import { type CentralDirectory, type File, Open } from 'unzipper'

/** Check the ZIP directory before the parser allocates entries. */
export async function openBoundedZip(zip: Buffer, entries: number) {
  let end = zip.length - 22
  const minimum = Math.max(0, end - 65535)
  for (; end >= minimum; end--)
    if (
      zip.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + zip.readUInt16LE(end + 20) === zip.length
    )
      break
  if (
    end < minimum ||
    zip.readUInt16LE(end + 4) ||
    zip.readUInt16LE(end + 6) ||
    zip.readUInt16LE(end + 8) !== zip.readUInt16LE(end + 10) ||
    zip.readUInt16LE(end + 10) > entries ||
    zip.readUInt32LE(end + 16) + zip.readUInt32LE(end + 12) !== end
  )
    throw new Error(
      `Use one ZIP file with at most ${entries.toLocaleString('en-US')} entries. Split archives and ZIP64 are not supported.`,
    )
  const open = Open.buffer as (
    data: Buffer,
    options: { tailSize: number },
  ) => Promise<CentralDirectory>
  return open(zip, { tailSize: zip.length - end })
}
export async function readZipEntry(
  file: File,
  limit: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  if (file.uncompressedSize > limit)
    throw new Error('The ZIP file exceeds the import size limit.')
  const parts: Buffer[] = []
  let size = 0
  const stream = file.stream()
  if (signal) addAbortSignal(signal, stream)
  try {
    for await (const chunk of stream) {
      const part = Buffer.from(chunk)
      size += part.length
      if (size > limit)
        throw new Error('The ZIP file exceeds the import size limit.')
      parts.push(part)
    }
  } finally {
    stream.destroy()
  }
  const content = Buffer.concat(parts)
  if (size !== file.uncompressedSize || crc32(content) !== file.crc32)
    throw new Error('The ZIP file is damaged. Export it again.')
  return content
}
