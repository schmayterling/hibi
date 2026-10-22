import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { AddonManifest } from '../addons/api'
import {
  ADDON_PACKAGE_TRUST_KEYS,
  ADDON_REVOCATIONS_URL,
  ADDON_TRUST_CHANNELS,
  ADDON_TRUST_KEYS,
  type AddonRevocationStatement,
  type AddonTrust,
  type AddonTrustSettings,
} from '../shared/addon-trust'
import { parseAddonRevocations, revokedAddon } from './addon-trust-crypto'
import { retryRename } from './atomic-rename'
import { isTrustedRendererUrl } from './security'

const DAY = 24 * 60 * 60 * 1000
const MAX_LIST_BYTES = 256 * 1024
const defaults: AddonTrustSettings = {
  allowUnsigned: false,
  checkRevocations: true,
}
let settings = { ...defaults }
let keys = ADDON_PACKAGE_TRUST_KEYS
// Package automation keys never authorize revocation lists.
let revocationKeys = ADDON_TRUST_KEYS
let revocations: AddonRevocationStatement | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let request: AbortController | undefined
let lastAttempt = 0
let apply: (() => Promise<void>) | undefined
let saving = Promise.resolve()
const path = (file: string) => join(app.getPath('userData'), file)
const testing = () => !app.isPackaged && app.commandLine?.hasSwitch('hibi-test')

function parseSettings(value: unknown): AddonTrustSettings {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('allowUnsigned' in value) ||
    typeof value.allowUnsigned !== 'boolean' ||
    !('checkRevocations' in value) ||
    typeof value.checkRevocations !== 'boolean' ||
    Object.keys(value).some(
      (key) => key !== 'allowUnsigned' && key !== 'checkRevocations',
    )
  )
    throw new Error('Could not change addon trust settings. Try again.')
  return {
    allowUnsigned: value.allowUnsigned,
    checkRevocations: value.checkRevocations,
  }
}

async function save(file: string, value: unknown) {
  const target = path(file)
  await writeFile(`${target}.tmp`, JSON.stringify(value), { mode: 0o600 })
  await retryRename(() => rename(`${target}.tmp`, target))
}

export async function loadAddonTrust() {
  settings = { ...defaults }
  keys = ADDON_PACKAGE_TRUST_KEYS
  revocationKeys = ADDON_TRUST_KEYS
  revocations = undefined
  if (testing() && process.env.HIBI_TEST_ADDON_TRUST_KEYS) {
    const extra: unknown = JSON.parse(
      await readFile(process.env.HIBI_TEST_ADDON_TRUST_KEYS, 'utf8'),
    )
    if (
      !extra ||
      typeof extra !== 'object' ||
      Array.isArray(extra) ||
      !Object.values(extra).every(
        (value) =>
          typeof value === 'string' &&
          Buffer.from(value, 'base64').length === 32 &&
          Buffer.from(value, 'base64').toString('base64') === value,
      ) ||
      Object.keys(extra).some((key) =>
        Object.hasOwn(ADDON_PACKAGE_TRUST_KEYS, key),
      )
    )
      throw new Error('The addon test keys are invalid.')
    keys = { ...ADDON_PACKAGE_TRUST_KEYS, ...extra }
    revocationKeys = { ...ADDON_TRUST_KEYS, ...extra }
  }
  try {
    settings = parseSettings(
      JSON.parse(await readFile(path('addon-trust-settings.json'), 'utf8')),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('could not load addon trust settings:', error)
  }
  try {
    const bytes = await readFile(path('addon-revocations.json'))
    if (bytes.length > MAX_LIST_BYTES)
      throw new Error('The cached addon revocation list is too large.')
    revocations = parseAddonRevocations(
      JSON.parse(bytes.toString('utf8')),
      revocationKeys,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('could not load addon revocations:', error)
  }
}

function publish() {
  const renderer =
    (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) || 'app://hibi/'
  const urls = [renderer, new URL('addon-window.html', renderer).href]
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents
    if (
      !contents.isDestroyed() &&
      urls.some((url) => isTrustedRendererUrl(contents.getURL(), url))
    )
      contents.send(ADDON_TRUST_CHANNELS.changed)
  }
}

export const addonTrustKeys = () => keys
export const getAddonTrustSettings = (): AddonTrustSettings => ({ ...settings })
export const getAddonRevocation = (
  manifest: Pick<AddonManifest, 'id' | 'version'>,
) => revokedAddon(manifest, revocations)

/** Shared by review and the final staged-file check, including replacements. */
export function addonTrustError(
  trust: AddonTrust,
  manifest: Pick<AddonManifest, 'id' | 'version'>,
): Error | undefined {
  const revoked = getAddonRevocation(manifest)
  if (revoked) return new Error(`Hibi revoked this version. ${revoked.reason}`)
  if (trust.status === 'invalid') return new Error(trust.reason)
  if (trust.status === 'unsigned' && !settings.allowUnsigned)
    return new Error(
      'Turn on "Allow unsigned addons" in Settings → Addon Manager → Security to install this package.',
    )
  return undefined
}

export function setAddonTrustSettings(
  value: unknown,
): Promise<AddonTrustSettings> {
  const next = parseSettings(value)
  const operation = saving.then(async () => {
    await save('addon-trust-settings.json', next)
    settings = next
    if (!settings.checkRevocations) {
      clearTimeout(timer)
      request?.abort()
    } else schedule()
    publish()
    return getAddonTrustSettings()
  })
  saving = operation.then(
    () => {},
    () => {},
  )
  return operation
}

function schedule(initial = false) {
  clearTimeout(timer)
  if (!apply || !settings.checkRevocations) return
  const delay = lastAttempt
    ? Math.max(0, lastAttempt + DAY - Date.now())
    : initial
      ? 5000
      : 0
  timer = setTimeout(() => {
    void refreshRevocations().finally(() => schedule())
  }, delay)
  timer.unref()
}

async function refreshRevocations() {
  if (request || !settings.checkRevocations) return
  lastAttempt = Date.now()
  const controller = new AbortController()
  request = controller
  const timeout = setTimeout(() => controller.abort(), 15_000)
  timeout.unref()
  try {
    const { net } = await import('electron')
    const url =
      testing() && process.env.HIBI_TEST_ADDON_REVOCATIONS_URL
        ? process.env.HIBI_TEST_ADDON_REVOCATIONS_URL
        : ADDON_REVOCATIONS_URL
    const response = await net.fetch(url, {
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok || !response.body)
      throw new Error(`Addon revocations returned HTTP ${response.status}.`)
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.length
        if (size > MAX_LIST_BYTES)
          throw new Error('The addon revocation list exceeds 256 KiB.')
        chunks.push(value)
      }
    } finally {
      await reader.cancel()
    }
    const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const next = parseAddonRevocations(
      envelope,
      revocationKeys,
      revocations?.sequence,
    )
    if (controller.signal.aborted || !settings.checkRevocations) return
    // Equal sequences retain the accepted contents as well as blocking rollback.
    if (revocations && next.sequence === revocations.sequence) return
    await save('addon-revocations.json', envelope)
    revocations = next
    await apply?.()
    publish()
  } catch (error) {
    console.error('could not refresh addon revocations:', error)
  } finally {
    clearTimeout(timeout)
    request = undefined
  }
}

/** Deferred networking never holds up addon discovery or window creation. */
export function startAddonRevocations(onChanged: () => Promise<void>) {
  apply = onChanged
  schedule(true)
  app.once('will-quit', () => {
    clearTimeout(timer)
    apply = undefined
    request?.abort()
  })
}
