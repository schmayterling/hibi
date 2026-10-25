import { setImmediate } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import type { ImportFile } from '../../shared/imports'

export type ImportFormat = 'obsidian' | 'bear' | 'notion'
export type ImportConversion = { files: ImportFile[]; warnings: string[] }
export type ImportWorkerResult = {
  files: (ImportFile | number)[]
  warnings: string[]
}

export async function runImportWorker(
  path: string | URL,
  format: ImportFormat,
  files: readonly ImportFile[],
): Promise<ImportConversion> {
  const extensions = {
    obsidian: /\.md$/i,
    bear: /\.(md|markdown)$/i,
    notion: /\.(md|csv)$/i,
  }
  const input: ImportFile[] = [],
    transferList: ArrayBuffer[] = []
  // Assets stay in main; only note bytes cross the worker boundary.
  for (const file of files) {
    const data = extensions[format].test(file.path)
      ? new Uint8Array(file.data)
      : new Uint8Array()
    input.push({ path: file.path, data })
    transferList.push(data.buffer)
    if (input.length % 32 === 0) await setImmediate()
  }
  const worker = new Worker(path, {
    workerData: { format, files: input },
    transferList,
  })
  try {
    const result = await new Promise<ImportWorkerResult>((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', (code) =>
        reject(
          new Error(`Import conversion stopped before completing (${code}).`),
        ),
      )
    })
    return {
      files: result.files.map((file) =>
        typeof file === 'number' ? (files[file] as ImportFile) : file,
      ),
      warnings: result.warnings,
    }
  } finally {
    await worker.terminate()
  }
}
