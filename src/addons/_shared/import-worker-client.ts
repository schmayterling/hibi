import { Worker } from 'node:worker_threads'
import {
  type ImportEntry,
  type ImportFile,
  type ImportStream,
  importTextData,
} from '../../shared/imports.ts'
import {
  IMPORT_PACKET_BYTES,
  IMPORT_PACKET_FILES,
  type ImportPacket,
  packImportEntries,
  unpackImportEntries,
} from './import-packet.ts'

export type ImportFormat = 'obsidian' | 'bear' | 'notion'
export type ImportConversion = { files: ImportFile[]; warnings: string[] }

export async function streamImportWorker(
  path: string | URL,
  format: ImportFormat,
  stream: ImportStream,
): Promise<string[]> {
  const { signal } = stream
  signal?.throwIfAborted()
  const worker = new Worker(path, { workerData: { format } })
  let failure: Error | undefined
  let resolvePending: ((value: unknown) => void) | undefined
  let rejectPending: ((error: Error) => void) | undefined
  const fail = (error: Error) => {
    failure = error
    rejectPending?.(error)
  }
  const abort = () => {
    fail(signal?.reason ?? new Error('Import cancelled.'))
    void worker.terminate()
  }
  signal?.addEventListener('abort', abort, { once: true })
  worker.on('message', (value: unknown) => resolvePending?.(value))
  worker.once('error', fail)
  worker.once('exit', (code) =>
    fail(new Error(`Import conversion stopped before completing (${code}).`)),
  )
  async function request<T>(
    message: unknown,
    buffers: ArrayBuffer[] = [],
  ): Promise<T> {
    signal?.throwIfAborted()
    if (failure) throw failure
    try {
      return await new Promise<T>((resolve, reject) => {
        resolvePending = (value) => resolve(value as T)
        rejectPending = reject
        worker.postMessage(message, buffers)
      })
    } finally {
      resolvePending = undefined
      rejectPending = undefined
    }
  }
  async function convert(entries: ImportEntry[]) {
    const packet = packImportEntries(entries)
    await request(
      { type: 'files', packet },
      packet.bytes.byteLength ? [packet.bytes] : [],
    )
    for (;;) {
      const result = await request<{ packet: ImportPacket; done: boolean }>({
        type: 'next',
      })
      for (const entry of unpackImportEntries(result.packet)) {
        signal?.throwIfAborted()
        await stream.write(entry)
      }
      if (result.done) break
    }
  }
  try {
    for (
      let start = 0;
      start < stream.paths.length;
      start += IMPORT_PACKET_FILES
    )
      await request({
        type: 'paths',
        paths: stream.paths.slice(start, start + IMPORT_PACKET_FILES),
      })
    await request({ type: 'start' })
    for (
      let start = 0;
      start < stream.paths.length;
      start += IMPORT_PACKET_FILES
    ) {
      const reads = await request<boolean[]>({
        type: 'select',
        start,
        count: IMPORT_PACKET_FILES,
      })
      let entries: ImportEntry[] = [],
        size = 0
      for (let offset = 0; offset < reads.length; offset++) {
        signal?.throwIfAborted()
        const index = start + offset
        const path = stream.paths[index] as string
        const data = reads[offset]
          ? importTextData({ path, data: await stream.read(index) })
          : undefined
        if (
          entries.length &&
          size + (data?.byteLength ?? 0) > IMPORT_PACKET_BYTES
        ) {
          await convert(entries)
          entries = []
          size = 0
        }
        entries.push({ path, original: index, ...(data ? { data } : {}) })
        size += data?.byteLength ?? 0
      }
      if (entries.length) await convert(entries)
    }
    return await request<string[]>({ type: 'finish' })
  } finally {
    signal?.removeEventListener('abort', abort)
    await worker.terminate()
  }
}

export async function runImportWorker(
  path: string | URL,
  format: ImportFormat,
  files: readonly ImportFile[],
): Promise<ImportConversion> {
  const converted: ImportFile[] = []
  const warnings = await streamImportWorker(path, format, {
    paths: files.map((file) => file.path),
    read: async (index) => (files[index] as ImportFile).data,
    write: async (entry) => {
      const original =
        entry.original === undefined ? undefined : files[entry.original]
      if (entry.data) converted.push({ path: entry.path, data: entry.data })
      else if (original) converted.push(original)
      else throw new Error('The import contains an unsafe file path.')
    },
  })
  return { files: converted, warnings }
}
