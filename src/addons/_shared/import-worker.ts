import { parentPort, workerData } from 'node:worker_threads'
import type { ImportFile } from '../../shared/imports'
import { importBear } from '../import-bear/convert.ts'
import { importNotion } from '../import-notion/convert.ts'
import { importObsidian } from '../import-obsidian/convert.ts'
import type {
  ImportFormat,
  ImportWorkerResult,
} from './import-worker-client.ts'

const { format, files } = workerData as {
  format: ImportFormat
  files: ImportFile[]
}
const converters = {
  obsidian: importObsidian,
  bear: importBear,
  notion: importNotion,
}
const originals = new Map(files.map((file, index) => [file, index]))
const result = await converters[format](files)
const message: ImportWorkerResult = {
  files: result.files.map((file) => originals.get(file) ?? file),
  warnings: result.warnings,
}
parentPort?.postMessage(
  message,
  message.files.flatMap((file) =>
    typeof file === 'number' ? [] : [file.data.buffer as ArrayBuffer],
  ),
)
parentPort?.close()
