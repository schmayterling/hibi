/** Session storage is explicit and expires with its addon/window lifecycle. */
export type CredentialMode = 'persistent' | 'session'

export interface StoreCredentialRequest {
  readonly key: string
  readonly secret: string
  readonly mode: CredentialMode
}

export interface CredentialKeyRequest {
  readonly key: string
}

export type CredentialAvailability =
  | 'protected'
  | 'unprotected'
  | 'locked-or-unavailable'

export interface CredentialStatus {
  readonly key: string
  readonly stored: 'missing' | CredentialMode
  readonly persistence: CredentialAvailability
}

export type CredentialFailure =
  | 'invalid-request'
  | 'stale'
  | 'busy'
  | 'limit-exceeded'
  | 'unprotected'
  | 'locked-or-unavailable'
  | 'corrupt'
  | 'io-error'
  | 'not-found'

export type CredentialResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false
      readonly code: CredentialFailure
      /** A durable vault write may have crossed its atomic commit before invalidation. */
      readonly committed?: boolean
    }
