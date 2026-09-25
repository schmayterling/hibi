import type { OperationResult } from './foundation-contracts'

export const HOST_SELECTED_IO_CHANNELS = {
  selectImport: 'host-selected-io:select-import',
  readImport: 'host-selected-io:read-import',
  selectExport: 'host-selected-io:select-export',
  writeExport: 'host-selected-io:write-export',
  cancel: 'host-selected-io:cancel',
} as const

export const HOST_SELECTED_IO_MAX_BYTES = 16 * 1024 * 1024
export const HOST_SELECTED_IO_TTL_MS = 60_000

export interface HostImportChoice {
  readonly extensions?: readonly string[]
}

export interface HostExportChoice {
  readonly suggestedName: string
  readonly extension?: string
}

export interface HostSelectedIoGrant {
  readonly handle: string
  readonly name: string
}

export interface HostExportReceipt {
  readonly bytes: number
  readonly atomicVisibility: true
  readonly directorySynced: boolean
}

export type HostSelectedIoFailure =
  | 'cancelled'
  | 'disposed'
  | 'not-found'
  | 'stale'
  | 'conflict'
  | 'busy'
  | 'unsupported'
  | 'permission-denied'
  | 'limit-exceeded'

export type HostSelectedIoSelection = OperationResult<
  HostSelectedIoGrant | null,
  HostSelectedIoFailure
>
export type HostSelectedIoRead = OperationResult<
  Uint8Array,
  HostSelectedIoFailure
>
export type HostSelectedIoWrite = OperationResult<
  HostExportReceipt,
  HostSelectedIoFailure
>
export type HostSelectedIoCancel = OperationResult<null, HostSelectedIoFailure>

/** For trusted addons sharing Hibi's renderer. This is not hostile-addon isolation. Exports create new files only. */
export interface HostSelectedIoHostApi {
  selectImport(choice?: HostImportChoice): Promise<HostSelectedIoSelection>
  readImport(handle: string): Promise<HostSelectedIoRead>
  selectExport(choice: HostExportChoice): Promise<HostSelectedIoSelection>
  writeExport(handle: string, bytes: Uint8Array): Promise<HostSelectedIoWrite>
  cancel(handle: string): Promise<HostSelectedIoCancel>
}
