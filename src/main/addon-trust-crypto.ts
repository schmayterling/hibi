import { createHash, createPublicKey, verify } from 'node:crypto'
import type { AddonManifest } from '../addons/api'
import {
  ADDON_PACKAGE_TRUST_KEYS,
  ADDON_SIGNATURE_FILE,
  ADDON_TRUST_KEYS,
  type AddonRevocationStatement,
  type AddonTrust,
} from '../shared/addon-trust.ts'
import { type AddonInventory, addonPackageFiles } from './addon-inventory.ts'

const signatureErrors = new WeakSet<Error>()
function signatureError(error: Error): Error {
  signatureErrors.add(error)
  return error
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const date = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))

function base64(value: unknown): Buffer {
  if (typeof value !== 'string' || !value.length)
    throw signatureError(new Error('The signature envelope is invalid.'))
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value)
    throw signatureError(new Error('The signature envelope is invalid.'))
  return bytes
}

/** Verify the exact statement bytes before interpreting any signed fields. */
export function verifySignedEnvelope(
  envelope: unknown,
  keys: Readonly<Record<string, string>> = ADDON_TRUST_KEYS,
): { keyId: string; statement: unknown } {
  if (!object(envelope) || typeof envelope.keyId !== 'string')
    throw signatureError(new Error('The signature envelope is invalid.'))
  const { keyId } = envelope
  if (!Object.hasOwn(keys, keyId))
    throw signatureError(
      new Error('This package was signed with an unknown key.'),
    )
  const raw = base64(keys[keyId])
  if (raw.length !== 32)
    throw signatureError(new Error('The signing key is invalid.'))
  const key = createPublicKey({
    format: 'jwk',
    key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
  })
  const bytes = base64(envelope.statement)
  const signature = base64(envelope.signature)
  if (signature.length !== 64 || !verify(null, bytes, key, signature))
    throw signatureError(new Error("This package's signature is invalid."))
  return {
    keyId,
    statement: JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ),
  }
}

/** The signer and installer use the same inventory, exclusions, and file hashes. */
export async function addonFileHashes(
  inventory: AddonInventory,
  folder = '',
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  for (const path of addonPackageFiles(inventory, folder)) {
    if (path === ADDON_SIGNATURE_FILE) continue
    const bytes = await inventory.read(folder ? `${folder}/${path}` : path)
    hashes[path] = createHash('sha256').update(bytes).digest('hex')
  }
  return hashes
}

export async function verifyAddonSignature(
  inventory: AddonInventory,
  folder: string,
  manifest: Pick<AddonManifest, 'id' | 'version'>,
  keys: Readonly<Record<string, string>> = ADDON_PACKAGE_TRUST_KEYS,
): Promise<AddonTrust> {
  const signaturePath = folder
    ? `${folder}/${ADDON_SIGNATURE_FILE}`
    : ADDON_SIGNATURE_FILE
  if (!inventory.entries.some((entry) => entry.path === signaturePath))
    return { status: 'unsigned' }
  try {
    const envelope: unknown = JSON.parse(
      (await inventory.read(signaturePath)).toString('utf8'),
    )
    const { keyId, statement } = verifySignedEnvelope(envelope, keys)
    if (
      !object(statement) ||
      statement.type !== 'hibi-addon-signature' ||
      statement.version !== 1 ||
      statement.id !== manifest.id ||
      statement.addonVersion !== manifest.version ||
      !date(statement.signedAt) ||
      !object(statement.files)
    )
      throw signatureError(
        new Error('The signed addon details do not match this package.'),
      )
    const hashes = await addonFileHashes(inventory, folder)
    if (
      Object.keys(statement.files).length !== Object.keys(hashes).length ||
      Object.entries(hashes).some(
        ([path, hash]) =>
          !Object.hasOwn(statement.files as object, path) ||
          (statement.files as Record<string, unknown>)[path] !== hash,
      )
    )
      throw signatureError(
        new Error("This package's signature does not match its files."),
      )
    return { status: 'signed', keyId }
  } catch (error) {
    return {
      status: 'invalid',
      reason:
        error instanceof Error && signatureErrors.has(error)
          ? error.message
          : 'This package has an invalid signature file.',
    }
  }
}

export function parseAddonRevocations(
  envelope: unknown,
  keys: Readonly<Record<string, string>> = ADDON_TRUST_KEYS,
  lastSequence = 0,
): AddonRevocationStatement {
  const { statement } = verifySignedEnvelope(envelope, keys)
  if (
    !object(statement) ||
    statement.type !== 'hibi-addon-revocations' ||
    statement.version !== 1 ||
    !Number.isSafeInteger(statement.sequence) ||
    (statement.sequence as number) < 1 ||
    !date(statement.issuedAt) ||
    !Array.isArray(statement.entries) ||
    !statement.entries.every(
      (entry: unknown) =>
        object(entry) &&
        typeof entry.id === 'string' &&
        /^[a-z][a-z0-9-]{0,47}$/.test(entry.id) &&
        typeof entry.reason === 'string' &&
        !!entry.reason.trim() &&
        entry.reason.length <= 2000 &&
        (entry.versions === undefined ||
          (Array.isArray(entry.versions) &&
            entry.versions.length > 0 &&
            entry.versions.every(
              (version: unknown) =>
                typeof version === 'string' &&
                !!version &&
                version.length <= 128,
            ))),
    )
  )
    throw signatureError(new Error('The addon revocation list is invalid.'))
  if ((statement.sequence as number) < lastSequence)
    throw signatureError(
      new Error('The addon revocation list is older than the accepted list.'),
    )
  return statement as AddonRevocationStatement
}

export function revokedAddon(
  manifest: Pick<AddonManifest, 'id' | 'version'>,
  list?: AddonRevocationStatement,
) {
  const entry = list?.entries.find(
    (entry) =>
      entry.id === manifest.id &&
      (!entry.versions || entry.versions.includes(manifest.version)),
  )
  if (!entry) return undefined
  const text = entry.reason.trim().replace(/[.!?]+$/, '')
  return { reason: `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}.` }
}
