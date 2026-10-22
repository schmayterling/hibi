import type { AddonManifest } from '../addons/api'

export const MAX_URL_LENGTH = 2048
export const LOCAL_HOSTNAME_SUFFIX =
  /\.(?:localhost|local|lan|internal|home\.arpa)$/

/** Main-owned, bounded UTF-8 HTTPS requests. */
export const HOST_NETWORK_CHANNELS = {
  getText: 'host-network:get-text',
  requestText: 'host-network:request-text',
} as const

export interface HostTextRequest {
  readonly url: string
  /** Stored under this addon's host credentials; sent once as an HTTPS bearer token. */
  readonly credentialKey?: string
}

/** One consented JSON upload to an exact manifest-declared public HTTPS origin. */
export interface HostTextPostRequest extends HostTextRequest {
  readonly method: 'POST'
  /** UTF-8 JSON text, at most 64 MiB. No custom headers or redirects. */
  readonly body: string
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

/** Keep package declarations canonical so request origins can match exactly. */
export function parseAddonNetwork(
  value: unknown,
): NonNullable<AddonManifest['network']> {
  const invalid = () => {
    throw new Error('The addon must declare exact public HTTPS origins.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid()
  const { origins } = value as Record<string, unknown>
  if (
    Object.keys(value).some((key) => key !== 'origins') ||
    !Array.isArray(origins) ||
    origins.length < 1 ||
    origins.length > 16 ||
    new Set(origins).size !== origins.length
  )
    return invalid()
  for (const origin of origins) {
    if (typeof origin !== 'string' || origin.length > MAX_URL_LENGTH)
      return invalid()
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      return invalid()
    }
    if (
      url.protocol !== 'https:' ||
      url.origin !== origin ||
      url.port === '0' ||
      /^[\d.]+$/.test(url.hostname) ||
      !url.hostname.includes('.') ||
      LOCAL_HOSTNAME_SUFFIX.test(url.hostname) ||
      url.hostname === 'home.arpa' ||
      url.hostname.length > 253 ||
      !url.hostname
        .split('.')
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      return invalid()
  }
  return { origins: [...origins] }
}
