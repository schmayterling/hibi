import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { app, dialog } from 'electron'
import { runFileDialog } from '../../main/file-operation-dialog'
import type { NativeAddon, NativeAddonContext } from '../api'
import { createMetadataNative } from './api/metadata/native'
import { closeVaultLists, createVaultNative } from './api/vault/native'
import {
  cancelCommunityRequest,
  communityService,
  communityTask,
  stopCommunityInstalls,
} from './community-native'
import {
  type CommunityPluginSource,
  validPluginId,
  wrapObsidianPlugin,
} from './package'
import {
  discoverObsidianPlugins,
  ObsidianStore,
  obsidianVaultIdentity,
  readObsidianPackage,
} from './store'

const stores = new Map<string, ObsidianStore>()
const communityCandidates = new Map<
  string,
  {
    vaultId: string
    createdAt: number
    check: () => void
    packageData: Awaited<ReturnType<typeof readObsidianPackage>>
    source: CommunityPluginSource
  }
>()

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
  return trustPackage(place, packageData)
}

async function trustPackage(
  place: Awaited<ReturnType<typeof captured>>,
  packageData: Awaited<ReturnType<typeof readObsidianPackage>>,
  source?: CommunityPluginSource,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const verdict = await runFileDialog(() =>
    dialog.showMessageBox({
      type: 'warning',
      message: `Install ${packageData.manifest.name}?`,
      detail: `${packageData.manifest.description}\n\nAuthor: ${source?.author ?? packageData.manifest.author}${source ? `\nRepository: ${source.repo}\nRelease: ${source.release}` : ''}\nRequires Obsidian ${packageData.manifest.minAppVersion} or later. Hibi provides a partial compatibility API.\n\nObsidian plugins run with Hibi's renderer access and can read or change your notes and interface. Install only plugins you trust. This copy starts disabled. Hibi never writes to .obsidian.\n\nSHA-256: ${packageData.hash}`,
      buttons: ['Cancel', 'Trust and install'],
      defaultId: 0,
      cancelId: 0,
    }),
  )
  place.check()
  if (verdict.response !== 1) return null
  const check = () => {
    signal?.throwIfAborted()
    place.check()
  }
  check()
  return place.store.install(packageData, check, source)
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

function vaultQuery(
  name: keyof ReturnType<typeof createVaultNative>['queries'],
) {
  return async (input: unknown, context: NativeAddonContext) => {
    const place = await captured(input, context)
    return createVaultNative(context, place.check).queries[name](input)
  }
}
function vaultMethod(
  name: keyof ReturnType<typeof createVaultNative>['methods'],
) {
  return async (input: unknown, context: NativeAddonContext) => {
    const place = await captured(input, context)
    return createVaultNative(context, place.check).methods[name](input)
  }
}

export default {
  id: 'obsidian',
  stop() {
    stopCommunityInstalls()
    communityCandidates.clear()
    closeVaultLists()
  },
  queries: {
    vaultInfo: vaultQuery('vaultInfo'),
    vaultStat: vaultQuery('vaultStat'),
    vaultList: vaultQuery('vaultList'),
    async obsidianMetadataFile(input, context) {
      const place = await captured(input, context)
      return createMetadataNative(
        context,
        place.check,
      ).queries.obsidianMetadataFile(input)
    },
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
  profileMethods: {
    async downloadCommunity(input, context) {
      const place = await captured(input, context)
      return communityTask(
        input,
        async (signal) => {
          for (const [key, candidate] of communityCandidates)
            if (Date.now() - candidate.createdAt > 120000)
              communityCandidates.delete(key)
          if (communityCandidates.size >= 6)
            throw new Error(
              'Too many downloaded plugins. Finish or cancel an install first.',
            )
          const directory = communityService()
          const entry = await directory.entry(
            'plugin',
            pluginId(place.data),
            signal,
          )
          const result = await directory.plugin(entry, signal)
          signal.throwIfAborted()
          place.check()
          const key = (input as { requestId: string }).requestId
          communityCandidates.set(key, {
            ...result,
            vaultId: place.identity,
            check: place.check,
            createdAt: Date.now(),
          })
          return {
            key,
            manifest: result.packageData.manifest,
            hash: result.packageData.hash,
            source: result.source,
          }
        },
        true,
      )
    },
    async cancelCommunity(input) {
      const result = cancelCommunityRequest(input)
      communityCandidates.delete((input as { requestId: string }).requestId)
      return result
    },
  },
  methods: {
    vaultUpdateText: vaultMethod('vaultUpdateText'),
    vaultCreateFolder: vaultMethod('vaultCreateFolder'),
    vaultAction: vaultMethod('vaultAction'),
    async installCommunity(input, context) {
      const place = await captured(input, context)
      const key = (input as { key?: unknown }).key
      if (typeof key !== 'string')
        throw new Error('Download this plugin again.')
      const candidate = communityCandidates.get(key)
      communityCandidates.delete(key)
      if (
        !candidate ||
        candidate.vaultId !== place.identity ||
        candidate.packageData.manifest.id !== pluginId(place.data) ||
        Date.now() - candidate.createdAt > 120000
      )
        throw new Error('This download expired. Download the plugin again.')
      candidate.check()
      return trustPackage(place, candidate.packageData, candidate.source)
    },
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
