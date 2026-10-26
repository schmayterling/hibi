import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import catalog from 'virtual:hibi-addon-catalog/main'
import { app, type BrowserWindow, dialog } from 'electron'
import {
  type AddonState,
  compatibleAddonManifest,
  type NativeAddon,
} from '../addons/api'
import { addonDefaultEnabled } from '../shared/addon-defaults'
import {
  addonDependents,
  requiredAddonDependencies,
  resolveAddonDependencies,
  validateAddonRequirements,
} from '../shared/addon-dependencies'
import { parseDependencies } from '../shared/dependencies'
import { validDocumentExtensions } from '../shared/document-types'
import type { AddonId, AddonOwner } from '../shared/foundation-contracts'
import type { ImportFile, ImportStream } from '../shared/imports'
import { getAddonRevocation, loadAddonTrust } from './addon-trust'
import { exportedAppearance } from './appearance'
import {
  clearDocument,
  getDocument,
  getDocumentPath,
  hasUnsavedDocuments,
  loadDocument,
  newDocument,
  renameDocument,
  updateDocument,
} from './document'
import { setDocumentExtensions } from './document-types'
import { runFileDialog } from './file-operation-dialog'
import { validateMarkdown, writeText } from './files'
import {
  installedAddons,
  installedResources,
  installPackage,
  installPackageSelection,
  loadInstalledAddons,
  removePackage,
} from './sideload'
import { testPause } from './test-pauses'
import {
  refreshWorkspace,
  resolveWorkspaceFile,
  snapshotWorkspace,
  workspaceEntries,
  workspaceId,
  workspaceRoot,
} from './workspace'

const bundledManifests = catalog.map(({ manifest }) => manifest)
const nativeLoaders = new Map(
  catalog.flatMap(({ manifest, loadNative }) =>
    loadNative ? [[manifest.id, loadNative] as const] : [],
  ),
)
const natives = new Map<string, NativeAddon>()
const pendingNatives = new Map<string, Promise<NativeAddon>>()
const generations = new Map<string, number>()
let onAddonDeactivated: (id: string, generation: number) => Promise<void> =
  async () => {}

let onAddonStatesChanged: (states: AddonState[]) => void = () => {}

let windowOwners: () => readonly string[] = () => []

/** Addons whose windows are open; a replacement of one is refused rather than restarted. */
export function setAddonWindowOwners(read: () => readonly string[]): void {
  windowOwners = read
}

/** Called after each accepted addon state change. */
export function setAddonStatesHandler(
  handler: (states: AddonState[]) => void,
): void {
  onAddonStatesChanged = handler
}

/** Register host cleanup before addon state changes are accepted. */
export function setAddonDeactivationHandler(
  handler: (id: string, generation: number) => Promise<void>,
): void {
  onAddonDeactivated = handler
}

async function nativeAddon(id: string) {
  if (natives.has(id)) return natives.get(id)
  const load = nativeLoaders.get(id)
  if (!load) return undefined
  let pending = pendingNatives.get(id)
  if (!pending) {
    pending = load()
      .then((addon) => {
        if (addon.id !== id) throw new Error('Native addon identity mismatch.')
        natives.set(id, addon)
        return addon
      })
      .finally(() => pendingNatives.delete(id))
    pendingNatives.set(id, pending)
  }
  return pending
}
let enabled: Record<string, boolean> = {}
let addonStartupNotices: string[] = []
const manifests = () => [
  ...bundledManifests,
  ...installedAddons().map((addon) => addon.manifest),
]
export const getAddonManifests = manifests

export async function getAddonLicenses() {
  const { default: details } = await import(
    'virtual:hibi-addon-catalog/details'
  )
  return manifests().flatMap((manifest) =>
    (details[manifest.id]?.licenses ?? manifest.licenses ?? []).map(
      (license) => ({
        ...license,
        id: `addon:${manifest.id}:${license.id}`,
      }),
    ),
  )
}

export async function readAddonDocumentation(id: unknown, path: unknown) {
  if (
    typeof id !== 'string' ||
    !manifests().some((manifest) => manifest.id === id)
  )
    throw new Error('This addon is unavailable.')
  const source = catalog.find(({ manifest }) => manifest.id === id)?.directory
  return (await import('./addon-documentation')).readDocumentation(
    id,
    source,
    path,
  )
}

export async function loadAddons(): Promise<void> {
  await loadAddonTrust()
  validateAddonRequirements(bundledManifests)
  const [notices, stored] = await Promise.all([
    loadInstalledAddons(bundledManifests),
    readFile(join(app.getPath('userData'), 'addons.json'), 'utf8')
      .then((text): Record<string, unknown> => {
        const value: unknown = JSON.parse(text)
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Could not read these addon settings.')
        return value as Record<string, unknown>
      })
      .catch((error: unknown): Record<string, unknown> => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          console.error('could not load addon preferences:', error)
        return {}
      }),
  ])
  const ids = new Set<string>()
  for (const manifest of manifests()) {
    const dependencies = parseDependencies(manifest.dependencies)
    if (
      !/^[a-z][a-z0-9-]*$/.test(manifest.id) ||
      ids.has(manifest.id) ||
      (manifest.kind === 'theme' && dependencies.length > 0) ||
      (manifest.fileExtensions !== undefined &&
        !validDocumentExtensions(manifest.fileExtensions)) ||
      !compatibleAddonManifest(manifest)
    )
      throw new Error(
        'This addon has invalid details or needs a different version of Hibi.',
      )
    ids.add(manifest.id)
  }
  setDocumentExtensions(
    manifests().flatMap((manifest) => manifest.fileExtensions ?? []),
  )
  enabled = Object.fromEntries(
    Object.entries(stored).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
    ),
  )
  addonStartupNotices = notices
  const modal = manifests().filter((manifest) =>
    manifest.capabilities?.includes('modalEditing'),
  )
  const enabledModal = modal.filter((manifest) =>
    getAddonStates().some((state) => state.id === manifest.id && state.enabled),
  )
  if (enabledModal.length > 1) {
    for (const manifest of enabledModal) enabled[manifest.id] = false
    const path = join(app.getPath('userData'), 'addons.json')
    await writeText(path, JSON.stringify(enabled))
    addonStartupNotices.push(
      'Multiple modal addons were enabled. They were disabled to keep regular editing mode safe.',
    )
  }
  await applyAddonRevocations()
}

/** Disable through the normal path so dependents and runtime owners retire cleanly. */
export async function applyAddonRevocations(): Promise<void> {
  const revoked = installedAddons().filter((addon) => addon.revoked)
  if (!revoked.length) return
  const next = { ...enabled }
  for (const addon of revoked) next[addon.manifest.id] = false
  await savePreferences(next)
}

export function getAddonStartupNotices() {
  return [...addonStartupNotices]
}

export function getAddonStates(): AddonState[] {
  setDocumentExtensions(
    manifests().flatMap((manifest) => manifest.fileExtensions ?? []),
  )
  return addonStates(enabled)
}

function addonStates(
  preferences: Record<string, boolean>,
  beforeRevocations = false,
): AddonState[] {
  const revoked = new Set(
    beforeRevocations
      ? []
      : installedAddons()
          .filter((addon) => addon.revoked)
          .map((addon) => addon.manifest.id),
  )
  const all = manifests()
  const states = all.map(({ id, defaultEnabled }) => ({
    id,
    ...(Object.hasOwn(preferences, id)
      ? { savedEnabled: preferences[id] }
      : {}),
    enabled:
      !revoked.has(id) &&
      (id === 'markdown' ||
        ((Object.hasOwn(preferences, id) ? preferences[id] : undefined) ??
          addonDefaultEnabled(
            id,
            defaultEnabled,
            !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL,
          ))),
  }))
  const { blocked } = resolveAddonDependencies(all, states)
  return states.map((state) => {
    const blockedBy = blocked.get(state.id)
    return { ...state, ...(blockedBy?.length ? { blockedBy } : {}) }
  })
}

const active = (state: AddonState) => state.enabled && !state.blockedBy?.length

/** Main-owned token for requests admitted during one addon activation. */
export function getAddonActivationGeneration(id: string): number | null {
  return getAddonStates().some((state) => state.id === id && active(state))
    ? (generations.get(id) ?? 0)
    : null
}

export function currentAddonOwner(id: string): AddonOwner | null {
  const activationGeneration = getAddonActivationGeneration(id)
  return activationGeneration === null
    ? null
    : { addonId: id as AddonId, activationGeneration }
}

export function isAddonActivationCurrent(
  id: string,
  generation: number,
): boolean {
  return (
    Number.isSafeInteger(generation) &&
    generation >= 0 &&
    getAddonActivationGeneration(id) === generation
  )
}

/** Invalidate pending renderer requests before clearing sessions on renderer restart. */
export function invalidateAddonActivations(): void {
  for (const state of getAddonStates())
    if (state.enabled)
      generations.set(state.id, (generations.get(state.id) ?? 0) + 1)
}

export function getImporters(): import('../shared/imports').Importer[] {
  const enabled = new Set(
    getAddonStates()
      .filter(active)
      .map((state) => state.id),
  )
  return bundledManifests.flatMap((manifest) =>
    manifest.importer && enabled.has(manifest.id)
      ? [
          {
            id: manifest.id,
            name: manifest.name.replace(/^Import from /, ''),
            ...manifest.importer,
          },
        ]
      : [],
  )
}
export async function convertImport(
  id: string,
  files: readonly ImportFile[],
  stream?: ImportStream,
) {
  const generation = getAddonActivationGeneration(id)
  if (
    generation === null ||
    !getImporters().some((importer) => importer.id === id)
  )
    throw new Error('Enable this importer in Settings → Addons first.')
  const addon = await nativeAddon(id)
  if (!isAddonActivationCurrent(id, generation))
    throw new Error(
      'This importer is no longer enabled or its required addons are unavailable.',
    )
  if (!addon?.import)
    throw new Error('This addon does not provide an importer.')
  const streamConvert = (
    addon as NativeAddon & {
      importStream?: (stream: ImportStream) => Promise<string[]>
    }
  ).importStream
  let result: Awaited<ReturnType<NonNullable<NativeAddon['import']>>>
  if (stream && streamConvert)
    result = { files: [], warnings: await streamConvert(stream) }
  else {
    let input = files
    if (stream) {
      // Older compiled importers require all bytes at once; bound that legacy contract.
      const buffered: ImportFile[] = []
      let size = 0
      for (let index = 0; index < stream.paths.length; index++) {
        stream.signal?.throwIfAborted()
        const data = await stream.read(index)
        size += data.byteLength
        if (size > 256 * 1024 * 1024)
          throw new Error(
            'This importer requires an in-memory export under 256 MiB.',
          )
        buffered.push({ path: stream.paths[index] as string, data })
      }
      input = buffered
    }
    result = await addon.import(input)
    if (stream)
      for (const file of result.files) {
        stream.signal?.throwIfAborted()
        await stream.write(file)
      }
  }
  if (!isAddonActivationCurrent(id, generation))
    throw new Error(
      'This importer is no longer enabled or its required addons are unavailable.',
    )
  return result
}

/** Name of an enabled addon compiled with Hibi; only these can open addon windows. */
export function windowAddonName(id: unknown): string {
  const manifest = bundledManifests.find((entry) => entry.id === id)
  if (!manifest || getAddonActivationGeneration(manifest.id) === null)
    throw new Error('Enable this addon in Settings → Addons first.')
  return manifest.name
}

/** Run an enabled native handler for a global shortcut id such as `quick-note.capture`. */
export async function runNativeGlobalShortcut(
  id: string,
  openWindow: (addonId: string, options: unknown) => Promise<void>,
): Promise<boolean> {
  const [owner = '', local = ''] = id.split('.')
  const generation = getAddonActivationGeneration(owner)
  if (generation === null) return false
  const handlers = (await nativeAddon(owner))?.globalShortcuts
  const handler = handlers && Object.hasOwn(handlers, local) && handlers[local]
  if (!handler) return false
  // Disabling or re-enabling while the module loads retires this press.
  const current = () => getAddonActivationGeneration(owner) === generation
  await testPause('global-shortcut-loaded')
  if (!current()) return true
  await testPause('global-shortcut-handler')
  await handler({
    windows: {
      open: async (options) => {
        if (!current())
          throw new Error('This addon was disabled. Enable it to continue.')
        await openWindow(owner, options)
      },
    },
  })
  return true
}

export async function enableAddon(
  id: unknown,
  value: unknown,
  includeRequired: unknown = false,
): Promise<AddonState[]> {
  if (
    typeof id !== 'string' ||
    !manifests().some((manifest) => manifest.id === id) ||
    typeof value !== 'boolean' ||
    typeof includeRequired !== 'boolean'
  )
    throw new Error('Could not change this addon setting. Try again.')
  const enable = id === 'markdown' || value
  const all = manifests()
  const next = { ...enabled, [id]: enable }
  if (enable) {
    const required = requiredAddonDependencies(all, id)
    const missing = required.filter(
      (dependency) => !all.some((manifest) => manifest.id === dependency),
    )
    if (missing.length)
      throw new Error(
        `This addon requires missing addons: ${missing.join(', ')}.`,
      )
    for (const owner of [id, ...required]) {
      const addon = installedAddons().find(
        (addon) => addon.manifest.id === owner,
      )
      const revoked = addon && getAddonRevocation(addon.manifest)
      if (revoked)
        throw new Error(`Hibi revoked this version. ${revoked.reason}`)
    }
    const closure = new Set([id, ...required])
    const modal = all.filter(
      (manifest) =>
        closure.has(manifest.id) &&
        manifest.capabilities?.includes('modalEditing'),
    )
    if (modal.length > 1)
      throw new Error(
        `Required addons use mutually exclusive modal editing: ${modal.map((manifest) => manifest.id).join(', ')}.`,
      )
    if (includeRequired)
      for (const dependency of required) next[dependency] = true
    else {
      const states = getAddonStates()
      const disabled = required.filter(
        (dependency) =>
          !states.some((state) => state.id === dependency && active(state)),
      )
      if (disabled.length)
        throw new Error(
          `Enable required addons first, or include required addons: ${disabled.join(', ')}.`,
        )
    }
    const selectedModal = modal[0]
    if (selectedModal)
      for (const other of all)
        if (
          other.id !== selectedModal.id &&
          other.capabilities?.includes('modalEditing')
        )
          next[other.id] = false
    const target = addonStates(next).find((state) => state.id === id)
    if (!target || !active(target))
      throw new Error(
        `This addon is blocked by required addons: ${target?.blockedBy?.join(', ')}.`,
      )
  }
  return savePreferences(next)
}

let savingPreferences = Promise.resolve()
function savePreferences(next: Record<string, boolean>): Promise<AddonState[]> {
  const operation = savingPreferences.then(() => commitPreferences(next))
  savingPreferences = operation.then(
    () => {},
    () => {},
  )
  return operation
}

async function commitPreferences(
  next: Record<string, boolean>,
): Promise<AddonState[]> {
  for (const addon of installedAddons())
    if (addon.revoked) next[addon.manifest.id] = false
  // The list already masks revoked states; retain the previous preference for runtime cleanup.
  const before = addonStates(enabled, true)
  const path = join(app.getPath('userData'), 'addons.json')
  await writeText(path, JSON.stringify(next))
  enabled = next
  await deactivateUnavailable(before)
  const states = getAddonStates()
  onAddonStatesChanged(states)
  return states
}

async function deactivateUnavailable(before: readonly AddonState[]) {
  const current = new Set(
    getAddonStates()
      .filter(active)
      .map((state) => state.id),
  )
  const lost = new Set(
    before
      .filter((state) => active(state) && !current.has(state.id))
      .map((state) => state.id),
  )
  const ids = new Set(
    [...lost].flatMap((id) => [...addonDependents(manifests(), id), id]),
  )
  const owners = [...ids]
    .filter((id) => lost.has(id))
    .map((id) => {
      const generation = generations.get(id) ?? 0
      generations.set(id, generation + 1)
      return { id, generation }
    })
  for (const { id, generation } of owners) {
    try {
      natives.get(id)?.stop?.()
    } catch (error) {
      console.error(`could not stop native addon ${id}:`, error)
    }
    await onAddonDeactivated(id, generation)
  }
}

async function disableAddonForReplacement(
  id: string,
  keep = false,
  openSettings: readonly string[] = [],
): Promise<() => Promise<void>> {
  if (keep) {
    await testPause('addon-replacement')
    // Restarting would discard what these show, so refuse before anything is retired or replaced.
    const name = (owner: string) =>
      manifests().find((manifest) => manifest.id === owner)?.name ?? owner
    const affected = [id, ...addonDependents(manifests(), id)]
    const windows = windowOwners()
    const windowed = affected.find((owner) => windows.includes(owner))
    if (windowed)
      throw new Error(
        `Close the ${name(windowed)} windows, then install the replacement again.`,
      )
    const visible = affected.find((owner) => openSettings.includes(owner))
    if (visible)
      throw new Error(
        `Leave the ${name(visible)} settings, then install the replacement again.`,
      )
    // The setting stays; work admitted for the old files retires and the renderer reloads the addon.
    const generation = getAddonActivationGeneration(id)
    if (generation !== null) {
      generations.set(id, generation + 1)
      await onAddonDeactivated(id, generation)
    }
    return async () => {}
  }
  const previous = Object.hasOwn(enabled, id) ? enabled[id] : undefined
  await savePreferences({ ...enabled, [id]: false })
  return async () => {
    const next = { ...enabled }
    if (previous === undefined) delete next[id]
    else next[id] = previous
    await savePreferences(next)
  }
}

/** Addons whose settings the requesting window shows; anything malformed counts as none. */
const replacing = (openSettings: unknown) => (id: string, keep: boolean) =>
  disableAddonForReplacement(
    id,
    keep,
    Array.isArray(openSettings) &&
      openSettings.length <= 64 &&
      openSettings.every((owner) => typeof owner === 'string')
      ? openSettings
      : [],
  )

export async function installDirectoryAddon(
  window: BrowserWindow,
  id: unknown,
  openSettings?: unknown,
) {
  const { directoryAddon, directorySignature } = await import(
    './addon-directory'
  )
  const { directoryInstallUrl } = await import('../shared/addon-directory')
  const entry = await directoryAddon(id)
  const result = await installPackage(
    window,
    bundledManifests,
    replacing(openSettings),
    directoryInstallUrl(entry),
    entry,
    await directorySignature(entry.id),
  )
  await applyAddonRevocations()
  return result
}

export async function installAddon(
  window: BrowserWindow,
  url?: unknown,
  openSettings?: unknown,
) {
  const result = await installPackage(
    window,
    bundledManifests,
    replacing(openSettings),
    url,
  )
  await applyAddonRevocations()
  return result
}

export async function installAddonSelection(
  window: BrowserWindow,
  id: unknown,
  keys: unknown,
  openSettings?: unknown,
) {
  const result = await installPackageSelection(
    window,
    id,
    keys,
    bundledManifests,
    replacing(openSettings),
  )
  await applyAddonRevocations()
  return result
}

/** Current declared stylesheets and themes of an installed addon, read again from its files. */
export function installedAddonResources(id: unknown) {
  return installedResources(
    id,
    bundledManifests.map((manifest) => manifest.id),
  )
}

export async function removeAddon(id: unknown): Promise<void> {
  if (
    typeof id !== 'string' ||
    !installedAddons().some((addon) => addon.manifest.id === id)
  )
    throw new Error(
      'Only addons you installed can be removed. Disable built-in addons instead.',
    )
  const restore = await disableAddonForReplacement(id)
  try {
    await removePackage(id)
  } catch (error) {
    await restore()
    throw error
  }
}

export async function invokeAddon(
  window: BrowserWindow,
  id: unknown,
  method: unknown,
  input: unknown,
  query = false,
): Promise<unknown> {
  if (typeof id !== 'string' || typeof method !== 'string')
    throw new Error('Enable this addon in Settings → Addons first.')
  const generation = getAddonActivationGeneration(id)
  if (generation === null)
    throw new Error('Enable this addon in Settings → Addons first.')
  const addon = await nativeAddon(id)
  if (!isAddonActivationCurrent(id, generation))
    throw new Error(
      'This addon was disabled. Enable it in Settings → Addons to continue.',
    )
  const handlers = query ? addon?.queries : addon?.methods
  if (!handlers || !Object.hasOwn(handlers, method))
    throw new Error('This addon does not support the requested action.')
  const handler = handlers[method]
  if (!handler)
    throw new Error('This addon does not support the requested action.')
  return handler(input, {
    dependencies: {
      resolve: async (dependency) =>
        (await import('./dependencies')).resolveDependency(id, dependency),
    },
    document: {
      get: getDocument,
      async path(id) {
        if (!id || id === getDocument().id) return getDocumentPath()
        const base = workspaceRoot()
        if (!base)
          throw new Error(
            'This document is no longer in the workspace. Open it again.',
          )
        async function find(
          entries: readonly import('../shared/workspace').WorkspaceEntry[],
        ): Promise<string | null> {
          for (const entry of entries) {
            if (entry.children) {
              const match = await find(entry.children)
              if (match) return match
            } else {
              const path = await resolveWorkspaceFile(base!, entry.path)
              if (createHash('sha256').update(path).digest('hex') === id)
                return path
            }
          }
          return null
        }
        const path = await find(workspaceEntries())
        if (!path)
          throw new Error(
            'This document is no longer in the workspace. Open it again.',
          )
        return path
      },
      async create(name, source) {
        validateMarkdown(source)
        if (!(await newDocument(window))) return false
        await renameDocument(name)
        updateDocument(source)
        window.setDocumentEdited(getDocument().dirty)
        return true
      },
    },
    async exportFile(bytes, suggestedName, extension) {
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength > 64 * 1024 * 1024 ||
        !/^[a-z0-9]{1,12}$/.test(extension)
      )
        throw new Error('The addon returned an invalid export file.')
      const result = await runFileDialog(() =>
        dialog.showSaveDialog(window, {
          title: 'Export document',
          defaultPath: basename(suggestedName),
          filters: [{ name: extension, extensions: [extension] }],
        }),
      )
      if (result.canceled || !result.filePath) return null
      if (
        (await realpath(result.filePath).catch(() => result.filePath)) ===
        getDocumentPath()
      )
        throw new Error(
          'Choose a different file name to keep the open document.',
        )
      await writeText(result.filePath, bytes)
      return result.filePath
    },
    workspace: {
      id: workspaceId,
      directory: workspaceRoot,
      hasUnsavedChanges: hasUnsavedDocuments,
      async reload() {
        if (hasUnsavedDocuments())
          throw new Error(
            'Save or discard your changes before reloading files.',
          )
        const path = getDocumentPath()
        if (path) {
          const exists = await lstat(path).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error
              return null
            },
          )
          if (exists?.isFile()) await loadDocument(window, path)
          else clearDocument(window)
        }
        await refreshWorkspace()
      },
      snapshot: async () => ({
        ...(await snapshotWorkspace()),
        appearance: exportedAppearance(),
      }),
    },
    async exportHtml(html, suggestedName, pages) {
      const result = await runFileDialog(() =>
        dialog.showSaveDialog(window, {
          title: 'Export workspace to HTML',
          defaultPath: basename(suggestedName),
          filters: [{ name: 'HTML', extensions: ['html'] }],
        }),
      )
      if (result.canceled || !result.filePath) return null
      const path = result.filePath
      await writeText(path, html)
      return { path, pages }
    },
  })
}
