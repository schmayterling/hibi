import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { app, dialog } from 'electron'
import { runFileDialog } from '../../main/file-operation-dialog'
import type { NativeAddon, NativeAddonContext } from '../api'
import { validPluginId, wrapObsidianPlugin } from './package'
import {
  discoverObsidianPlugins,
  ObsidianStore,
  obsidianVaultIdentity,
  readObsidianPackage,
} from './store'

const stores = new Map<string, ObsidianStore>()

export async function obsidianStoreForVault(vault: string) {
  const canonical = await realpath(vault)
  const identity = await obsidianVaultIdentity(canonical)
  const root = join(app.getPath('userData'), 'obsidian', 'vaults', identity)
  let store = stores.get(root)
  if (!store) {
    store = new ObsidianStore(root, canonical)
    stores.set(root, store)
  }
  return { store, identity, canonical }
}

async function captured(input: unknown, context: NativeAddonContext) {
  const data = input as { vaultId?: unknown; id?: unknown } | null
  const vault = context.workspace.directory()
  const id = context.workspace.id()
  if (!data || !vault || !id || data.vaultId !== id)
    throw new Error('Open this plugin’s vault again.')
  const place = await obsidianStoreForVault(vault)
  if (place.identity !== id)
    throw new Error('The vault location changed. Open it again.')
  const check = () => {
    if (
      !context.isCurrent() ||
      context.workspace.id() !== id ||
      context.workspace.directory() !== vault
    )
      throw new Error('The plugin host or vault changed. Try again.')
  }
  check()
  return { ...place, check, data }
}

function pluginId(data: { id?: unknown }) {
  if (!validPluginId(data.id))
    throw new Error('Choose an installed Obsidian plugin.')
  return data.id
}

async function install(
  input: unknown,
  context: NativeAddonContext,
  fromVault: boolean,
) {
  const place = await captured(input, context)
  let source: string
  if (fromVault) {
    const id = pluginId(place.data)
    // Discovery validates .obsidian and plugins as regular directories before reading.
    const candidate = (await discoverObsidianPlugins(place.canonical)).find(
      (entry) => entry.id === id,
    )
    if (!candidate || candidate.error)
      throw new Error(candidate?.error ?? 'This vault plugin is unavailable.')
    source = join(place.canonical, '.obsidian', 'plugins', id)
  } else {
    const choice = await runFileDialog(() =>
      dialog.showOpenDialog({
        title: 'Install Obsidian plugin',
        properties: ['openDirectory'],
      }),
    )
    if (choice.canceled || !choice.filePaths[0]) return null
    source = choice.filePaths[0]
  }
  place.check()
  const packageData = await readObsidianPackage(source)
  const verdict = await runFileDialog(() =>
    dialog.showMessageBox({
      type: 'warning',
      message: `Install ${packageData.manifest.name}?`,
      detail: `${packageData.manifest.description}\n\nObsidian plugins run code inside Hibi and can read or change your notes and interface. Install only plugins you trust. This copy starts disabled. Hibi never writes to .obsidian.\n\nSHA-256: ${packageData.hash}`,
      buttons: ['Cancel', 'Trust and install'],
      defaultId: 0,
      cancelId: 0,
    }),
  )
  place.check()
  if (verdict.response !== 1) return null
  return place.store.install(packageData, place.check)
}

/** Called only by the lazy app-protocol route after addon/vault activation checks. */
export async function obsidianPluginAsset(
  request: Request,
  vault: string,
  vaultId: string,
) {
  const url = new URL(request.url)
  const match =
    /^\/obsidian-plugins\/([a-f0-9]{64})\/([a-z0-9][a-z0-9_-]{0,63})\/([a-f0-9]{64})\/(main\.js|styles\.css)$/.exec(
      url.pathname,
    )
  if (
    request.method !== 'GET' ||
    url.protocol !== 'app:' ||
    url.host !== 'hibi' ||
    url.search ||
    url.hash ||
    !match
  )
    return null
  const [, identity, id, hash, name] = match
  if (identity !== vaultId || !id || !hash) return null
  const place = await obsidianStoreForVault(vault)
  if (place.identity !== identity) return null
  const source = await place.store.enabledPackage(id, hash)
  return name === 'main.js'
    ? {
        body: wrapObsidianPlugin(
          source.main.toString('utf8'),
          `${identity}:${id}:${hash}`,
        ),
        type: 'text/javascript; charset=utf-8',
      }
    : source.styles
      ? {
          body: source.styles.toString('utf8'),
          type: 'text/css; charset=utf-8',
        }
      : null
}

export default {
  id: 'obsidian',
  queries: {
    async list(input, context) {
      const place = await captured(input, context)
      return place.store.list()
    },
    async discover(input, context) {
      const place = await captured(input, context)
      return discoverObsidianPlugins(place.canonical)
    },
    async data(input, context) {
      const place = await captured(input, context)
      const value = await place.store.loadData(
        pluginId(place.data),
        place.check,
      )
      place.check()
      return value
    },
  },
  methods: {
    install: (input, context) => install(input, context, false),
    installVault: (input, context) => install(input, context, true),
    async enable(input, context) {
      const place = await captured(input, context)
      const id = pluginId(place.data)
      const enabled = (input as { enabled?: unknown }).enabled
      if (typeof enabled !== 'boolean')
        throw new Error('Choose whether to enable this plugin.')
      if (enabled) {
        const plugin = (await place.store.list()).find(
          (entry) => entry.manifest.id === id,
        )
        if (!plugin) throw new Error('Choose an installed Obsidian plugin.')
        const verdict = await runFileDialog(() =>
          dialog.showMessageBox({
            type: 'warning',
            message: `Enable ${plugin.manifest.name}?`,
            detail:
              'This plugin can read or change your notes and interface. Enable it only if you trust its code.',
            buttons: ['Cancel', 'Trust and enable'],
            defaultId: 0,
            cancelId: 0,
          }),
        )
        place.check()
        if (verdict.response !== 1) return null
      }
      place.check()
      return place.store.setEnabled(id, enabled, place.check)
    },
    async saveData(input, context) {
      const place = await captured(input, context)
      await place.store.saveData(
        pluginId(place.data),
        (input as { value?: unknown }).value,
        place.check,
      )
      place.check()
    },
    async remove(input, context) {
      const place = await captured(input, context)
      await place.store.remove(pluginId(place.data), place.check)
    },
  },
} satisfies NativeAddon
