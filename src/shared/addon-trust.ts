/** Offline root Ed25519 public keys (raw 32 bytes, base64) by key id; only these sign revocation lists. */
export const ADDON_TRUST_KEYS: Readonly<Record<string, string>> = {
  '1b43eadedb48d51d': 'JZEDarSlRAFAdC9WC++vLgpLVWI8pi9yBG8Wm73/S1w=',
}

/** Keys whose package signatures mark an addon as signed: the root keys and the Hibi garden automation key. */
export const ADDON_PACKAGE_TRUST_KEYS: Readonly<Record<string, string>> = {
  ...ADDON_TRUST_KEYS,
  '8dc7673025d00464': '+COFs2NeRFH27glN2PuJsyAHuMur86WTJT6HoaQliqY=',
}

/** Signature file shipped next to hibi-addon.json; excluded from the signed file list. */
export const ADDON_SIGNATURE_FILE = 'hibi-addon.sig.json'

/** Signed revocation list, checked at most once a day while enabled. The apex domain redirects to www and redirects are refused. */
export const ADDON_REVOCATIONS_URL =
  'https://www.hibi.garden/addons/revocations.json'

/**
 * Envelope for both signature files. `statement` is base64 of the exact UTF-8 JSON
 * bytes that were signed, so verification never re-serializes JSON.
 */
export type SignedEnvelope = {
  keyId: string
  statement: string
  signature: string
}

export type AddonSignatureStatement = {
  type: 'hibi-addon-signature'
  version: 1
  id: string
  addonVersion: string
  /** Every package file except the signature file: POSIX path -> lowercase hex SHA-256. */
  files: Record<string, string>
  signedAt: string
}

export type AddonRevocationStatement = {
  type: 'hibi-addon-revocations'
  version: 1
  /** Must never decrease; older lists are ignored to prevent rollback. */
  sequence: number
  issuedAt: string
  entries: AddonRevocationEntry[]
}

export type AddonRevocationEntry = {
  id: string
  /** Revoked versions; omit to revoke every version of the addon. */
  versions?: string[]
  reason: string
}

export type AddonTrust =
  | { status: 'signed'; keyId: string }
  | { status: 'unsigned' }
  | { status: 'invalid'; reason: string }

export type AddonRevocation = { reason: string }

export type AddonTrustSettings = {
  /** Install unsigned packages. Off by default; existing unsigned installs keep working. */
  allowUnsigned: boolean
  /** Fetch the signed revocation list. On by default. */
  checkRevocations: boolean
}

export const ADDON_TRUST_CHANNELS = {
  get: 'addons:trust-settings',
  set: 'addons:trust-settings-set',
  /** Main -> renderer: revocations or trust settings changed; refetch addon states and installs. */
  changed: 'addons:trust-changed',
} as const
