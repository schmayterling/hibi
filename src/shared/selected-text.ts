import type { OperationResult } from './foundation-contracts'

export const SELECTED_TEXT_CHANNELS = {
  select: 'host-selected-text:select',
  read: 'host-selected-text:read',
} as const

export const SELECTED_TEXT_MAX_BYTES = 2 * 1024 * 1024
export const SELECTED_TEXT_TTL_MS = 60_000

export type SelectedTextGrant = { readonly handle: string }
export type SelectedTextFailure =
  | 'disposed'
  | 'stale'
  | 'not-found'
  | 'permission-denied'
  | 'limit-exceeded'
  | 'unsupported'
  | 'busy'
export type SelectedTextSelection = OperationResult<
  SelectedTextGrant | null,
  SelectedTextFailure
>
export type SelectedTextRead = OperationResult<string, SelectedTextFailure>

/** These grants scope cooperating addons. Addons in Hibi's shared renderer can access the same ambient bridge; this is not hostile-addon isolation. */
export interface SelectedTextHostApi {
  select(): Promise<SelectedTextSelection>
  read(handle: string): Promise<SelectedTextRead>
}
