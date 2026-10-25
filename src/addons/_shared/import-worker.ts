import { parentPort, workerData } from 'node:worker_threads'
import type { ImportEntry } from '../../shared/imports'
import { createBearImport } from '../import-bear/convert.ts'
import { createNotionImport } from '../import-notion/convert.ts'
import { createObsidianImport } from '../import-obsidian/convert.ts'
import {
  IMPORT_PACKET_BYTES,
  IMPORT_PACKET_FILES,
  type ImportPacket,
  packImportEntries,
  unpackImportEntries,
} from './import-packet.ts'
import type { ImportFormat } from './import-worker-client.ts'

const { format } = workerData as { format: ImportFormat }
const converters = {
  obsidian: createObsidianImport,
  bear: createBearImport,
  notion: createNotionImport,
}
const paths: string[] = []
let conversion: ReturnType<typeof createObsidianImport>
let output: Generator<ImportEntry>
let next: IteratorResult<ImportEntry>
function* convert(files: ImportEntry[]) {
  const originals = new Map(files.map((file) => [file, file.original]))
  for (const file of files)
    for (const result of conversion.convert(file)) {
      const original = originals.get(result)
      yield original === undefined ? result : { path: result.path, original }
    }
}
parentPort?.on(
  'message',
  (
    message:
      | { type: 'paths'; paths: string[] }
      | { type: 'start' | 'next' | 'finish' }
      | { type: 'select'; start: number; count: number }
      | { type: 'files'; packet: ImportPacket },
  ) => {
    switch (message.type) {
      case 'paths':
        paths.push(...message.paths)
        break
      case 'start':
        conversion = converters[format](paths)
        break
      case 'select':
        parentPort?.postMessage(
          paths
            .slice(message.start, message.start + message.count)
            .map(conversion.reads),
        )
        return
      case 'files':
        output = convert(unpackImportEntries(message.packet))
        next = output.next()
        break
      case 'next': {
        const entries: ImportEntry[] = []
        let size = 0
        while (!next.done) {
          const length = next.value.data?.byteLength ?? 0
          if (
            entries.length &&
            (entries.length >= IMPORT_PACKET_FILES ||
              size + length > IMPORT_PACKET_BYTES)
          )
            break
          entries.push(next.value)
          size += length
          next = output.next()
        }
        const packet = packImportEntries(entries)
        parentPort?.postMessage(
          { packet, done: next.done },
          packet.bytes.byteLength ? [packet.bytes] : [],
        )
        return
      }
      case 'finish':
        parentPort?.postMessage(conversion.warnings())
        parentPort?.close()
        return
    }
    parentPort?.postMessage(null)
  },
)
