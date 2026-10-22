import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { app, type BrowserWindow, dialog, shell } from 'electron'
import type { AddonManifest } from '../addons/api'
import {
  isAddonInDependencyCycle,
  validateAddonRequirements,
} from '../shared/addon-dependencies'
import {
  type AddonDirectoryEntry,
  directoryManifestMatches,
} from '../shared/addon-directory'
import {
  admitInstalledAddon,
  parseAddonManifest,
  validId,
} from '../shared/addon-manifest'
import {
  MAX_ADDON_ENTRIES,
  MAX_ADDON_FILE_BYTES,
  MAX_ADDON_MANIFEST_BYTES,
  validAddonPath as validPath,
} from '../shared/addon-package'
import { ADDON_SIGNATURE_FILE } from '../shared/addon-trust'
import type {
  AddonInstallResult,
  AddonInstallSession,
  InstalledAddon,
} from '../shared/sideload'
import {
  type InstallCandidate,
  inspectAddonCandidates,
  sameAddonAccess,
  validateCandidateSelection,
  validateGraph,
} from './addon-install-candidates'
import {
  type AddonInventory,
  copyAddonPackage,
  inventoryAddonArchive,
  inventoryAddonDirectory,
  withAddonFile,
} from './addon-inventory'
import { downloadRepository, repositoryUrl } from './addon-repository'
import {
  addonTrustError,
  addonTrustKeys,
  getAddonRevocation,
} from './addon-trust'
import { verifyAddonSignature } from './addon-trust-crypto'
import { runFileDialog } from './file-operation-dialog'

type Package = InstalledAddon & { entry: string; hash: string; files: string[] }
let installed: Package[] = []
const root = () => join(app.getPath('userData'), 'installed-addons')
/** `files` is the recorded inventory; declared resources must appear in it. */
async function readManifest(
  folder: string,
  compiledIds: readonly string[],
  phase: 'install' | 'load' = 'install',
  files?: readonly string[],
) {
  const path = join(folder, 'hibi-addon.json')
  const stat = await lstat(path)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > MAX_ADDON_MANIFEST_BYTES
  )
    throw new Error(
      'hibi-addon.json must be a JSON file no larger than 64 KiB.',
    )
  const value = JSON.parse(await readFile(path, 'utf8'))
  const themeFiles = new Map<string, unknown>()
  if (phase === 'install')
    for (const theme of parseAddonManifest(value).themes) {
      if (typeof theme !== 'string') continue
      const file = await packageFile(folder, theme, files)
      if (!file || file.size > MAX_ADDON_MANIFEST_BYTES)
        throw new Error(
          `The theme file ${theme} must be a JSON file in the addon no larger than 64 KiB.`,
        )
      try {
        themeFiles.set(theme, JSON.parse(await readFile(file.path, 'utf8')))
      } catch {
        throw new Error(`The theme file ${theme} is not valid JSON.`)
      }
    }
  const data = admitInstalledAddon(value, compiledIds, phase, { themeFiles })
  for (const style of data.styles ?? [])
    if (!(await packageFile(folder, style, files)))
      throw new Error(`The stylesheet ${style} is missing from the addon.`)
  return data
}
/** A regular file reached without symbolic links, listed in `files` when given. */
async function packageFile(
  folder: string,
  relative: string,
  files?: readonly string[],
) {
  if (files && !files.includes(relative)) return null
  let path = folder
  try {
    for (const part of relative.split('/')) {
      path = join(path, part)
      if ((await lstat(path)).isSymbolicLink()) return null
    }
    const stat = await lstat(path)
    return stat.isFile() ? { path, size: stat.size } : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
function descriptor(data: Omit<Package, 'url'>): Package {
  const base = `app://hibi/installed-addons/${data.manifest.id}/${data.hash}/`
  return {
    ...data,
    url: data.entry ? base + data.entry : null,
    ...(data.styles ? { styles: data.styles.map((path) => base + path) } : {}),
  }
}
export function installedAddons(): InstalledAddon[] {
  return installed.map(({ manifest, url, themes, styles, source, trust }) => {
    const revoked = getAddonRevocation(manifest)
    return {
      manifest,
      url,
      themes,
      ...(styles ? { styles } : {}),
      source: source ?? 'local',
      trust: trust ?? 'unsigned',
      ...(revoked ? { revoked } : {}),
    }
  })
}
/** An installed addon's declared stylesheets and themes, read again from its files and validated as at load. */
export async function installedResources(
  id: unknown,
  builtins: readonly string[],
): Promise<Pick<InstalledAddon, 'styles' | 'themes'>> {
  const entry = installed.find((item) => item.manifest.id === id)
  if (!entry) throw new Error('Only installed addons can update in place.')
  const folder = join(root(), entry.manifest.id)
  const record = JSON.parse(
    await readFile(join(folder, '.hibi-install.json'), 'utf8'),
  )
  if (record.hash !== entry.hash)
    throw new Error('The addon installation changed. Reinstall the addon.')
  const data = await readManifest(
    folder,
    builtins,
    record.resources === true ? 'install' : 'load',
    entry.files,
  )
  if (data.manifest.id !== entry.manifest.id)
    throw new Error(
      'The addon installation record is invalid. Reinstall the addon.',
    )
  // A manifest that no longer lists styles must not inherit the installed URLs.
  const { styles = [], themes } = descriptor({
    ...entry,
    ...data,
    styles: data.styles ?? [],
  })
  return { styles, themes }
}
export function installedDocumentationPath(id: string, path: string) {
  const entry = installed.find((item) => item.manifest.id === id)
  if (!entry || !validPath(path)) return Promise.resolve(null)
  return installedAsset(
    `app://hibi/installed-addons/${id}/${entry.hash}/${path}`,
  )
}
export async function loadInstalledAddons(
  builtins: readonly AddonManifest[],
): Promise<string[]> {
  const builtinIds = builtins.map((manifest) => manifest.id)
  const notices: string[] = []
  const entries = await readdir(root(), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return []
    },
  )
  const next: Package[] = []
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !validId(entry.name) ||
      builtinIds.includes(entry.name)
    )
      continue
    try {
      const folder = join(root(), entry.name)
      const record = JSON.parse(
        await readFile(join(folder, '.hibi-install.json'), 'utf8'),
      )
      if (
        !/^[a-f\d]{64}$/.test(record.hash) ||
        !Array.isArray(record.files) ||
        record.files.length > MAX_ADDON_ENTRIES ||
        !record.files.every(validPath)
      )
        throw new Error(
          'The addon installation record is invalid. Reinstall the addon.',
        )
      // Older installs never validated styles or theme files, so they keep ignoring them.
      const data = await readManifest(
        folder,
        builtinIds,
        record.resources === true ? 'install' : 'load',
        record.files,
      )
      if (data.manifest.id !== entry.name)
        throw new Error(
          'The addon installation record is invalid. Reinstall the addon.',
        )
      next.push(
        descriptor({
          ...data,
          hash: record.hash,
          files: record.files,
          source: record.source === 'third-party' ? 'third-party' : 'local',
          trust: record.trust === 'signed' ? 'signed' : 'unsigned',
        }),
      )
    } catch (error) {
      console.error(`could not load installed addon ${entry.name}:`, error)
      notices.push(
        `Could not load addon "${entry.name}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const all = [...builtins, ...next.map((addon) => addon.manifest)]
  try {
    validateAddonRequirements(all, { allowMissing: true })
  } catch (error) {
    const graph = new Map(all.map((manifest) => [manifest.id, manifest]))
    const rejected = next.filter((addon) =>
      isAddonInDependencyCycle(graph, addon.manifest.id),
    )
    if (!rejected.length) throw error
    const reason = `Addons with dependency cycles were not loaded: ${rejected.map((addon) => addon.manifest.id).join(', ')}. ${error instanceof Error ? error.message : String(error)}`
    console.error(reason)
    notices.push(reason)
    const rejectedIds = new Set(rejected.map((addon) => addon.manifest.id))
    installed = next.filter((addon) => !rejectedIds.has(addon.manifest.id))
    validateAddonRequirements(
      [...builtins, ...installed.map((addon) => addon.manifest)],
      { allowMissing: true },
    )
    return notices
  }
  installed = next
  return notices
}
type InstallSession = {
  id: string
  window: BrowserWindow
  abort: AbortController
  temporary: string
  inventory?: AddonInventory
  refresh?: () => Promise<AddonInventory>
  candidates: InstallCandidate[]
  source: 'local' | 'third-party'
  host?: string
  /** Hibi garden installs must keep their detached Hibi signature. */
  signed?: true
  active: boolean
  timer: ReturnType<typeof setTimeout>
  closed: () => void
}
const installSessions = new Map<number, InstallSession>()
const installError = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

async function disposeInstallSession(session: InstallSession) {
  if (installSessions.get(session.window.id) === session)
    installSessions.delete(session.window.id)
  clearTimeout(session.timer)
  session.window.removeListener('closed', session.closed)
  session.abort.abort(new Error('Addon installation canceled.'))
  if (!session.active)
    await rm(session.temporary, { recursive: true, force: true })
}

export async function cancelPackageInstall(
  window: BrowserWindow,
  id: unknown,
): Promise<void> {
  const session = installSessions.get(window.id)
  if (session && session.id === id) await disposeInstallSession(session)
}

export async function installPackage(
  window: BrowserWindow,
  builtins: readonly AddonManifest[],
  disable: (id: string, keep: boolean) => Promise<() => Promise<void>>,
  url?: unknown,
  expected?: AddonDirectoryEntry,
  signature?: Buffer,
): Promise<AddonInstallSession | null> {
  const previous = installSessions.get(window.id)
  if (previous) await disposeInstallSession(previous)
  const temporary = await mkdtemp(join(app.getPath('temp'), 'hibi-addon-'))
  const abort = new AbortController()
  const closed = () => {
    void disposeInstallSession(session).catch(console.error)
  }
  const session: InstallSession = {
    id: randomUUID(),
    window,
    abort,
    temporary,
    candidates: [],
    source: url === undefined ? 'local' : 'third-party',
    active: true,
    timer: setTimeout(closed, 10 * 60 * 1000),
    closed,
  }
  session.timer.unref()
  installSessions.set(window.id, session)
  window.once('closed', closed)
  let reviewing = false
  try {
    if (window.isDestroyed()) throw new Error('Addon installation canceled.')
    if (url !== undefined) {
      const { downloadAddon } = await import('./addon-download')
      let download =
        !expected?.download && repositoryUrl(url)
          ? await downloadRepository(url, temporary, undefined, abort.signal)
          : await downloadAddon(url, abort.signal)
      if (
        expected?.download &&
        (download.zip.length !== expected.download.size ||
          createHash('sha256').update(download.zip).digest('hex') !==
            expected.download.sha256)
      )
        throw new Error(
          'The downloaded addon does not match its Hibi garden listing. Refresh the directory and try again.',
        )
      if (
        !expected?.download &&
        (download.zip.length < 4 || download.zip.readUInt32LE(0) !== 0x04034b50)
      )
        download = await downloadRepository(
          url,
          temporary,
          undefined,
          abort.signal,
        )
      session.inventory = await inventoryAddonArchive(
        download.zip,
        abort.signal,
      )
      session.host = download.host
    } else {
      const selection = await runFileDialog(() =>
        dialog.showOpenDialog(window, {
          title: 'Choose an addon folder',
          properties: ['openDirectory'],
        }),
      )
      if (selection.canceled || !selection.filePaths[0]) return null
      const source = selection.filePaths[0]
      session.refresh = () => inventoryAddonDirectory(source, abort.signal)
      session.inventory = await session.refresh()
    }
    session.candidates = await inspectAddonCandidates(
      session.inventory,
      builtins,
      installed,
    )
    if (expected) {
      session.candidates = session.candidates.filter(
        (candidate) => candidate.review.manifest?.id === expected.id,
      )
      const candidate = session.candidates[0]
      // Admission upgrades legacy API manifests; bind against the publisher's original metadata.
      const manifest: AddonManifest | undefined =
        candidate?.review.manifest &&
        JSON.parse(
          (
            await session.inventory.read(
              candidate.folder
                ? `${candidate.folder}/hibi-addon.json`
                : 'hibi-addon.json',
            )
          ).toString('utf8'),
        )
      if (
        !candidate ||
        session.candidates.length !== 1 ||
        !manifest ||
        !directoryManifestMatches(expected, manifest)
      )
        throw new Error(
          'The downloaded addon does not match its Hibi garden listing. Refresh the directory and try again.',
        )
      // The detached signature replaces any packaged one; the usual review must still verify it.
      if (!signature)
        throw new Error(
          'Could not download the Hibi signature for this addon. Refresh the directory and try again.',
        )
      session.inventory = withAddonFile(
        session.inventory,
        candidate.folder
          ? `${candidate.folder}/${ADDON_SIGNATURE_FILE}`
          : ADDON_SIGNATURE_FILE,
        signature,
      )
      session.candidates = (
        await inspectAddonCandidates(session.inventory, builtins, installed)
      ).filter((item) => item.folder === candidate.folder)
      const trust = session.candidates[0]?.review.trust
      if (trust?.status !== 'signed')
        throw new Error(
          trust?.status === 'invalid'
            ? trust.reason
            : "This addon's Hibi signature is missing.",
        )
      session.signed = true
    }
    abort.signal.throwIfAborted()
    if (session.candidates.length === 1) {
      const candidate = session.candidates[0]!
      if (candidate.review.status !== 'installable') {
        if (candidate.data)
          validateGraph([candidate.data.manifest], builtins, installed)
        throw new Error(candidate.review.reasons.join('\n'))
      }
      const data = candidate.data!
      const verdict = await runFileDialog(() =>
        dialog.showMessageBox(window, {
          type: data.manifest.kind === 'extension' ? 'warning' : 'question',
          message: `Install ${data.manifest.name} ${data.manifest.version}?`,
          detail: `${data.manifest.description}\n\n${candidate.review.trust.status === 'signed' ? 'Signed by Hibi.' : 'Unsigned. Hibi cannot confirm who made this addon.'}\n\nBy ${data.manifest.authors?.map((author) => author.displayName).join(', ')}${session.host ? `\n\nDownloaded from ${session.host}` : ''}${candidate.review.replaces ? `\n\nReplaces ${candidate.review.replaces.version} (${candidate.review.replaces.source}).` : ''}${data.manifest.network ? `\n\nConnects to: ${data.manifest.network.origins.join(', ')}` : ''}\n\n${data.manifest.kind === 'extension' ? 'Extensions can run code and read or edit documents in Hibi. Only install addons you trust. ' : ''}${candidate.review.replaces?.keepsSetting ? 'Its access is unchanged, so it keeps its current setting.' : 'This addon will stay disabled until you enable it.'}`,
          buttons: [
            'Cancel',
            candidate.review.replaces ? 'Replace addon' : 'Install',
          ],
          defaultId: 0,
          cancelId: 0,
        }),
      )
      if (verdict.response !== 1) return null
      await refreshInstallSession(session, builtins)
      await installDirectory(session, candidate, builtins, disable)
      return null
    }
    reviewing = true
    return {
      id: session.id,
      source: session.source,
      ...(session.host ? { host: session.host } : {}),
      candidates: session.candidates.map((candidate) => candidate.review),
      providers: [
        ...builtins,
        ...installed.map(({ manifest }) => manifest),
      ].map(({ id, requires }) => ({ id, ...(requires ? { requires } : {}) })),
    }
  } finally {
    session.active = false
    if (!reviewing || abort.signal.aborted) await disposeInstallSession(session)
  }
}

async function refreshInstallSession(
  session: InstallSession,
  builtins: readonly AddonManifest[],
) {
  session.abort.signal.throwIfAborted()
  if (session.refresh) session.inventory = await session.refresh()
  const current = await inspectAddonCandidates(
    session.inventory!,
    builtins,
    installed,
  )
  for (const candidate of session.candidates) {
    const updated = current.find((item) => item.folder === candidate.folder)
    if (
      !updated ||
      updated.review.status !== 'installable' ||
      JSON.stringify(updated.data) !== JSON.stringify(candidate.data)
    ) {
      candidate.review.status =
        updated?.review.status === 'invalid' ? 'invalid' : 'blocked'
      candidate.review.reasons = updated?.review.reasons.length
        ? updated.review.reasons
        : ['The addon files changed during installation. Try again.']
    } else {
      candidate.review.trust = updated.review.trust
      delete candidate.review.revoked
      if (updated.review.revoked)
        candidate.review.revoked = updated.review.revoked
      candidate.review.status = 'installable'
      candidate.review.reasons = []
    }
  }
  session.abort.signal.throwIfAborted()
}

export async function installPackageSelection(
  window: BrowserWindow,
  id: unknown,
  keys: unknown,
  builtins: readonly AddonManifest[],
  disable: (id: string, keep: boolean) => Promise<() => Promise<void>>,
): Promise<AddonInstallResult[]> {
  const session = installSessions.get(window.id)
  if (!session || session.id !== id || session.active)
    throw new Error(
      'This addon selection has expired. Choose the source again.',
    )
  if (
    !Array.isArray(keys) ||
    !keys.length ||
    keys.length > session.candidates.length ||
    keys.some((key) => typeof key !== 'string') ||
    new Set(keys).size !== keys.length
  )
    throw new Error('Choose at least one available addon.')
  const selected = keys.map((key) =>
    session.candidates.find((candidate) => candidate.review.key === key),
  )
  if (selected.some((candidate) => !candidate))
    throw new Error('Choose only available addons from this source.')
  const candidates = selected as InstallCandidate[]
  session.active = true
  const results = new Map<string, AddonInstallResult>()
  try {
    await refreshInstallSession(session, builtins)
    const proposed = candidates.map((candidate) => ({
      ...candidate,
      review: { ...candidate.review, reasons: [...candidate.review.reasons] },
    }))
    const order = validateCandidateSelection(proposed, builtins, installed)
    for (const candidate of proposed)
      if (candidate.review.status !== 'installable')
        results.set(candidate.review.key, {
          key: candidate.review.key,
          status: 'failed',
          error: candidate.review.reasons.join('\n'),
        })
    for (const addonId of order) {
      const candidate = proposed.find(
        (item) => item.data?.manifest.id === addonId,
      )!
      try {
        session.abort.signal.throwIfAborted()
        await installDirectory(session, candidate, builtins, disable)
        results.set(candidate.review.key, {
          key: candidate.review.key,
          status: 'installed',
        })
      } catch (error) {
        results.set(candidate.review.key, {
          key: candidate.review.key,
          status: 'failed',
          error: installError(error),
        })
      }
    }
  } catch (error) {
    for (const candidate of candidates)
      results.set(candidate.review.key, {
        key: candidate.review.key,
        status: 'failed',
        error: installError(error),
      })
  } finally {
    session.active = false
    if (session.abort.signal.aborted) await disposeInstallSession(session)
  }
  return candidates.map((candidate) => results.get(candidate.review.key)!)
}

async function installDirectory(
  session: InstallSession,
  candidate: InstallCandidate,
  builtins: readonly AddonManifest[],
  disable: (id: string, keep: boolean) => Promise<() => Promise<void>>,
): Promise<void> {
  if (candidate.review.status !== 'installable')
    throw new Error(candidate.review.reasons.join('\n'))
  const data = candidate.data!
  const compiledIds = builtins.map((manifest) => manifest.id)
  const validate = () => validateGraph([data.manifest], builtins, installed)
  validate()
  await mkdir(root(), { recursive: true, mode: 0o700 })
  const staging = join(root(), `.staging-${randomUUID()}`)
  await mkdir(staging, { mode: 0o700 })
  let restore: (() => Promise<void>) | undefined
  const destination = join(root(), data.manifest.id),
    backup = join(root(), `.backup-${randomUUID()}`)
  let backedUp = false,
    replaced = false
  try {
    const { files, hash: fingerprint } = await copyAddonPackage(
      session.inventory!,
      candidate.folder,
      staging,
    )
    if (
      !files.includes('README.md') ||
      (data.entry && !files.includes(data.entry)) ||
      (data.manifest.analysis && !files.includes(data.manifest.analysis.entry))
    )
      throw new Error(
        'The addon needs README.md and the entry file listed in hibi-addon.json.',
      )
    const copied = await readManifest(staging, compiledIds, 'install', files)
    if (JSON.stringify(copied) !== JSON.stringify(data))
      throw new Error('The addon files changed during installation. Try again.')
    const trust = await verifyAddonSignature(
      await inventoryAddonDirectory(staging),
      '',
      copied.manifest,
      addonTrustKeys(),
    )
    const trustError = addonTrustError(trust, copied.manifest)
    if (trustError) throw trustError
    if (trust.status === 'invalid') throw new Error(trust.reason)
    if (session.signed && trust.status !== 'signed')
      throw new Error("This addon's Hibi signature is missing.")
    await writeFile(
      join(staging, '.hibi-install.json'),
      JSON.stringify({
        hash: fingerprint,
        files,
        source: session.source,
        trust: trust.status,
        resources: true,
      }),
      { mode: 0o600 },
    )
    const exists = await lstat(destination).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      },
    )
    const previous = installed.find(
      (item) => item.manifest.id === data.manifest.id,
    )
    if (exists && !previous)
      throw new Error(
        'An unrecognized addon already uses this ID. Check the addons folder before installing.',
      )
    session.abort.signal.throwIfAborted()
    validate()
    restore = await disable(
      data.manifest.id,
      !!previous && sameAddonAccess(previous.manifest, data.manifest),
    )
    session.abort.signal.throwIfAborted()
    const currentError = addonTrustError(trust, copied.manifest)
    if (currentError) throw currentError
    if (exists) {
      await rename(destination, backup)
      backedUp = true
    }
    session.abort.signal.throwIfAborted()
    await rename(staging, destination)
    replaced = true
    installed = [
      ...installed.filter((item) => item.manifest.id !== data.manifest.id),
      descriptor({
        ...copied,
        hash: fingerprint,
        files,
        source: session.source,
        trust: trust.status,
      }),
    ]
    if (backedUp)
      await shell
        .trashItem(backup)
        .catch((error) => console.error('old addon package retained:', error))
  } catch (error) {
    if (!replaced && backedUp) await rename(backup, destination)
    if (!replaced) await restore?.()
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
export async function removePackage(id: unknown): Promise<void> {
  const packageInfo = installed.find((item) => item.manifest.id === id)
  if (!packageInfo)
    throw new Error(
      'Only addons you installed can be removed. Disable built-in addons instead.',
    )
  await shell.trashItem(join(root(), packageInfo.manifest.id))
  installed = installed.filter((item) => item !== packageInfo)
}
export async function openAddonsFolder(): Promise<void> {
  await mkdir(root(), { recursive: true, mode: 0o700 })
  const error = await shell.openPath(root())
  if (error) throw new Error(error)
}
export async function installedAsset(url: string): Promise<string | null> {
  const parsed = new URL(url)
  if (
    parsed.protocol !== 'app:' ||
    parsed.host !== 'hibi' ||
    parsed.username ||
    parsed.password
  )
    return null
  const [, prefix, id, hash, ...parts] = decodeURIComponent(
    parsed.pathname,
  ).split('/')
  if (prefix !== 'installed-addons') return null
  const entry = installed.find(
    (item) => item.manifest.id === id && item.hash === hash,
  )
  const relative = parts.join('/')
  if (!entry || !validPath(relative) || !entry.files.includes(relative))
    return null
  let path = join(root(), entry.manifest.id)
  if ((await lstat(path)).isSymbolicLink()) return null
  for (const part of parts) {
    path = join(path, part)
    if ((await lstat(path)).isSymbolicLink()) return null
  }
  const stat = await lstat(path)
  return stat.isFile() && stat.size <= MAX_ADDON_FILE_BYTES ? path : null
}
