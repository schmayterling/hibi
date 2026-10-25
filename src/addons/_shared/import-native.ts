import { join } from 'node:path'
import { app } from 'electron'
import type { ImportFile, ImportStream } from '../../shared/imports'
import {
  type ImportFormat,
  runImportWorker,
  streamImportWorker,
} from './import-worker-client'

export function nativeImport(format: ImportFormat) {
  const path = () => join(app.getAppPath(), 'out/main/import-worker.js')
  return {
    import: (files: readonly ImportFile[]) =>
      runImportWorker(path(), format, files),
    importStream: (stream: ImportStream) =>
      streamImportWorker(path(), format, stream),
  }
}
