import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

/** The largest PDF Hibi displays; pdf.js holds the whole file in memory. */
export const MAX_PDF_BYTES = 64 * 1024 * 1024

/** PDF readers accept the `%PDF-` header anywhere in a file's first KiB. */
const HEADER_WINDOW = 1024

/** A PDF's bytes for the viewer; null unless the path is a PDF file within the size limit. */
export async function readPdfBytes(path: string): Promise<Uint8Array | null> {
  try {
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
    )
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > MAX_PDF_BYTES) return null
      const bytes = Buffer.alloc(stat.size + 1)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead !== stat.size) return null
      const data = bytes.subarray(0, bytesRead)
      return data.subarray(0, HEADER_WINDOW).includes('%PDF-') ? data : null
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}
