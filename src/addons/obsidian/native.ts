import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { app, dialog } from 'electron'
import { runFileDialog } from '../../main/file-operation-dialog'
import type { NativeAddon, NativeAddonContext } from '../api'
import { createMetadataNative } from './api/metadata/native'
import {
  activatePluginRequestCapability,
  consumePluginScriptLoad,
  mintPluginRequestCapability,
  type PluginRequestScope,
  preparePluginScriptLoad,
} from './api/network/capabilities'
import {
  cancelRequestUrl,
  releaseRequestUrl,
  requestUrlNative,
  stopRequestUrls,
} from './api/network/native'
import {
  cancelObsidianProtocol,
  nextObsidianProtocol,
  stopObsidianProtocol,
} from './api/protocol/native'
import { closeVaultLists, createVaultNative } from './api/vault/native'
import {
  cancelCommunityRequest,
  communityService,
  communityTask,
  stopCommunityInstalls,
} from './community-native'
import {
  type CommunityPluginSource,
  type InstalledPlugin,
  validPluginId,
  wrapObsidianPlugin,
} from './package'
import {
  discoverObsidianPlugins,
  ObsidianStore,
  obsidianVaultIdentity,
  readObsidianPackage,
  type VaultSettingsOffer,
} from './store'

const stores = new Map<string, ObsidianStore>()
const communityCandidates = new Map<
  string,
  {
    createdAt: number
    check: () => void
    packageData: Awaited<ReturnType<typeof readObsidianPackage>>
    source: CommunityPluginSource
  }
>()

const globalStores = new Map<string, Promise<ObsidianStore>>()

export async function obsidianGlobalStore() {
  const base = join(app.getPath('userData'), 'obsidian')
  const root = join(base, 'global')
  let ready = globalStores.get(root)
  if (!ready) {
    const store = new ObsidianStore(root)
    ready = store.migrateLegacy(join(base, 'vaults')).then(() => store)
    globalStores.set(root, ready)
    ready.catch(() => {
      if (globalStores.get(root) === ready) globalStores.delete(root)
    })
  }
  return { store: await ready }
}

function addonCheck(context: NativeAddonContext) {
  const check = () => {
    if (!context.isCurrent())
      throw new Error('The plugin host changed. Try again.')
  }
  check()
  return check
}

async function globalPlace(input: unknown, context: NativeAddonContext) {
  const check = addonCheck(context)
  const place = await obsidianGlobalStore()
  check()
  return { ...place, check, data: (input ?? {}) as { id?: unknown } }
}

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

async function captured(
  input: unknown,
  context: NativeAddonContext,
  requireIdentity = true,
) {
  const data = input as { vaultId?: unknown; id?: unknown } | null
  const vault = context.workspace.directory()
  const id = context.workspace.id()
  if (
    !data ||
    !vault ||
    !id ||
    ((requireIdentity || data.vaultId !== undefined) && data.vaultId !== id)
  )
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

function settingsImport(input: unknown): VaultSettingsOffer {
  const offer = input as VaultSettingsOffer | null
  if (
    !offer ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof offer.overwrite !== 'boolean' ||
    typeof offer.sourceHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(offer.sourceHash) ||
    (offer.globalHash !== null &&
      (typeof offer.globalHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(offer.globalHash)))
  )
    throw new Error('Invalid vault settings request.')
  return offer
}

async function install(
  input: unknown,
  context: NativeAddonContext,
  fromVault: boolean,
) {
  const place = await globalPlace(input, context)
  let check = place.check
  let source: string
  if (fromVault) {
    const folder = await captured(input ?? {}, context, false)
    check = folder.check
    const id = pluginId(place.data)
    // Discovery validates .obsidian and plugins as regular directories before reading.
    const candidate = (await discoverObsidianPlugins(folder.canonical)).find(
      (entry) => entry.id === id,
    )
    if (!candidate || candidate.error)
      throw new Error(candidate?.error ?? 'This vault plugin is unavailable.')
    source = join(folder.canonical, '.obsidian', 'plugins', id)
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
  check()
  const packageData = await readObsidianPackage(source)
  check()
  return trustPackage(
    { ...place, check },
    packageData,
    undefined,
    fromVault ? 'vault' : 'folder',
  )
}

async function trustPackage(
  place: Pick<Awaited<ReturnType<typeof globalPlace>>, 'store' | 'check'>,
  packageData: Awaited<ReturnType<typeof readObsidianPackage>>,
  source?: CommunityPluginSource,
  origin: NonNullable<InstalledPlugin['origin']> = source
    ? 'community'
    : 'folder',
) {
  place.check()
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
  return place.store.install(packageData, place.check, source, origin)
}

/** Called only by the lazy app-protocol route after addon activation checks. */
export async function obsidianPluginAsset(
  request: Request,
  scope: PluginRequestScope,
) {
  const url = new URL(request.url)
  const match =
    /^\/obsidian-plugins\/(global)\/([a-z0-9][a-z0-9_-]{0,63})\/([a-f0-9]{64})\/(main\.js|styles\.css)$/.exec(
      url.pathname,
    )
  if (
    request.method !== 'GET' ||
    url.protocol !== 'app:' ||
    !['hibi', 'obsidian-plugins'].includes(url.host) ||
    url.hash ||
    !match
  )
    return null
  const [, identity, id, hash, name] = match
  if (!id || !hash) return null
  // The script origin is outside renderer connect-src, so fetch cannot read its capability.
  if (url.host !== (name === 'main.js' ? 'obsidian-plugins' : 'hibi'))
    return null
  if (!scope.isCurrent()) return null
  if (name === 'styles.css' && url.search) return null
  const nonce = url.searchParams.get('load')
  if (name === 'main.js' && (url.searchParams.size !== 1 || !nonce)) return null
  const place = await obsidianGlobalStore()
  const source = await place.store.enabledPackage(id, hash)
  if (!scope.isCurrent()) return null
  // Consume after authorization: concurrent tickets cannot replace a live grant.
  const load =
    name === 'main.js'
      ? consumePluginScriptLoad(id, hash, nonce, scope)
      : undefined
  if (name === 'main.js' && !load) return null
  return name === 'main.js' && load
    ? {
        body: wrapObsidianPlugin(
          source.main.toString('utf8'),
          `${identity}:${id}:${hash}:${nonce}`,
          mintPluginRequestCapability(id, hash, load, false),
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
    stopRequestUrls()
    stopObsidianProtocol()
    stopCommunityInstalls()
    communityCandidates.clear()
    closeVaultLists()
  },
  queries: {
    async nextObsidianProtocol(input, context) {
      addonCheck(context)
      return nextObsidianProtocol(input, context.isCurrent)
    },
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
      const place = await globalPlace(input, context)
      const result = await place.store.list()
      place.check()
      return result
    },
    async discover(input, context) {
      addonCheck(context)
      if (!context.workspace.directory()) return []
      const place = await captured(input ?? {}, context, false)
      const result = await discoverObsidianPlugins(place.canonical)
      place.check()
      return result
    },
    async settingsOffer(input, context) {
      const place = await globalPlace(input, context)
      const id = pluginId(place.data)
      if (!context.workspace.directory()) return false
      const folder = await captured(input, context, false)
      return place.store.settingsOffer(id, folder.canonical, folder.check)
    },
    async data(input, context) {
      const place = await globalPlace(input, context)
      const value = await place.store.loadData(
        pluginId(place.data),
        place.check,
      )
      place.check()
      return value
    },
  },
  profileMethods: {
    async activateRequestUrl(input, context) {
      addonCheck(context)
      const data = input as { id?: unknown; capability?: unknown } | null
      activatePluginRequestCapability(
        data?.id,
        data?.capability,
        context.senderId,
      )
    },
    async preparePluginLoad(input, context) {
      const place = await globalPlace(input, context)
      const id = pluginId(place.data)
      const hash = (input as { hash?: unknown }).hash
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
        throw new Error('Choose the current plugin package.')
      const plugins = await place.store.list()
      place.check()
      if (
        !plugins.some(
          (plugin) =>
            plugin.manifest.id === id && plugin.hash === hash && plugin.enabled,
        )
      )
        throw new Error('This plugin is disabled or uninstalled.')
      return preparePluginScriptLoad(id, hash, {
        senderId: context.senderId,
        isCurrent: context.isCurrent,
      })
    },
    async requestUrl(input, context) {
      const check = addonCheck(context)
      return requestUrlNative(
        input,
        async (id, hash) => {
          const { store } = await obsidianGlobalStore()
          const plugins = await store.list()
          check()
          if (
            !plugins.some(
              (plugin) =>
                plugin.manifest.id === id &&
                plugin.hash === hash &&
                plugin.enabled,
            )
          )
            throw new Error('This plugin is disabled or uninstalled.')
        },
        context.senderId,
      )
    },
    async cancelRequestUrl(input, context) {
      addonCheck(context)
      return cancelRequestUrl(input, context.senderId)
    },
    async releaseRequestUrl(input, context) {
      addonCheck(context)
      return releaseRequestUrl(input, context.senderId)
    },
    cancelObsidianProtocol,
    async downloadCommunity(input, context) {
      const place = await globalPlace(input, context)
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
      const place = await globalPlace(input, context)
      const key = (input as { key?: unknown }).key
      if (typeof key !== 'string')
        throw new Error('Download this plugin again.')
      const candidate = communityCandidates.get(key)
      communityCandidates.delete(key)
      if (
        !candidate ||
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
      const place = await globalPlace(input, context)
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
    async importVaultData(input, context) {
      const offer = settingsImport(input)
      const place = await globalPlace(input, context)
      const folder = await captured(input, context)
      return place.store.importVaultData(
        pluginId(place.data),
        folder.canonical,
        offer,
        folder.check,
      )
    },
    async dismissVaultData(input, context) {
      const place = await globalPlace(input, context)
      const folder = await captured(input, context)
      await place.store.dismissVaultData(
        pluginId(place.data),
        folder.canonical,
        folder.check,
      )
    },
    async saveData(input, context) {
      const place = await globalPlace(input, context)
      await place.store.saveData(
        pluginId(place.data),
        (input as { value?: unknown }).value,
        place.check,
      )
      place.check()
    },
    async remove(input, context) {
      const place = await globalPlace(input, context)
      await place.store.remove(pluginId(place.data), place.check)
    },
  },
} satisfies NativeAddon
