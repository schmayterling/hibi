/** This first network capability reads bounded UTF-8 text over HTTPS GET. */
export const HOST_NETWORK_CHANNELS = {
  getText: 'host-network:get-text',
} as const

export interface HostTextRequest {
  readonly url: string
  /** Stored under this addon's host credentials; sent once as an HTTPS bearer token. */
  readonly credentialKey?: string
}

export interface HostTextResponse {
  readonly url: string
  readonly status: number
  readonly text: string
}

export type HostNetworkFailure =
  | 'invalid-request'
  | 'permission-denied'
  | 'limit-exceeded'
  | 'timeout'
  | 'cancelled'
  | 'stale'
  | 'busy'
  | 'unavailable'
  | 'http-status'

export type HostTextResult =
  | { readonly ok: true; readonly value: HostTextResponse }
  | {
      readonly ok: false
      readonly code: HostNetworkFailure
      readonly status?: number
    }
