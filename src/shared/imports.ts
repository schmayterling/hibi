export const IMPORT_CHANNELS = {
  list: 'imports:list',
  run: 'imports:run',
  cancel: 'imports:cancel',
} as const
export type ImportSource = 'folder' | 'zip'
export type Importer = {
  id: string
  name: string
  instructions: string
  sources: readonly ImportSource[]
}
/** Relative paths and bytes from a user-selected export. Never executable addon code. */
export type ImportFile = { path: string; data: Uint8Array }
/** Private transport for compiled importers; attachment bytes remain on disk. */
export type ImportEntry = { path: string; data?: Uint8Array; original?: number }
export function importTextData(file: ImportEntry): Uint8Array {
  if (!(file.data instanceof Uint8Array))
    throw new Error('The import contains an unsafe file path.')
  if (file.data.byteLength > 2 * 1024 * 1024)
    throw new Error(
      `This document exceeds the 2 MiB editing limit: ${file.path}`,
    )
  return file.data
}
export type ImportStream = {
  signal?: AbortSignal
  paths: readonly string[]
  read: (index: number) => Promise<Uint8Array>
  write: (entry: ImportEntry) => Promise<void>
}
export type ImportResult = { folder: string; files: number; warnings: string[] }
export type ImportRequest = {
  id: string
  source: ImportSource
  workspaceId: string
}
