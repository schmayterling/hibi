import { type ComponentType, lazy } from 'react'
import type { Addon, AddonManifest, MarkdownFlavor } from '../../addons/api'
import type { SideloadFactory } from '../../addons/sdk'
import { type CapabilitySdk, loadAddonSdk } from '../../addons/sdk-loader'
import type { InstalledAddon } from '../../shared/sideload'
import { startupSpan } from '../../shared/startup'

const manifests = import.meta.glob<AddonManifest>(
  ['../../addons/*/manifest.ts', '../../useraddons/*/manifest.ts'],
  { eager: true, import: 'default' },
)
const implementations = import.meta.glob<Addon>(
  ['../../addons/*/index.{ts,tsx}', '../../useraddons/*/index.{ts,tsx}'],
  { import: 'default' },
)
const settings = import.meta.glob<{ Settings: ComponentType }>([
  '../../addons/*/Settings.tsx',
  '../../useraddons/*/Settings.tsx',
])
const flavorInfo = import.meta.glob<readonly MarkdownFlavor[]>(
  ['../../addons/*/flavor-info.ts', '../../useraddons/*/flavor-info.ts'],
  { eager: true, import: 'default' },
)
const origins = new Map<string, string>()
const bundled = Object.entries(manifests).map(([path, manifest]): Addon => {
  const directory = path.slice(0, path.lastIndexOf('/'))
  origins.set(manifest.id, path.includes('/useraddons/') ? 'local' : 'built-in')
  const loader =
    implementations[`${directory}/index.ts`] ??
    implementations[`${directory}/index.tsx`]
  let pending: Promise<Addon> | undefined
  const load = () =>
    (pending ??= (
      loader
        ? loader()
        : Promise.reject(
            new Error(
              `The ${manifest.id} addon is missing its startup file. Reinstall it.`,
            ),
          )
    ).catch((error) => {
      pending = undefined
      throw error
    }))
  let generation = 0
  let instance: Addon | undefined
  const settingsLoader = settings[`${directory}/Settings.tsx`]
  const descriptor: Addon = {
    manifest,
    ...(flavorInfo[`${directory}/flavor-info.ts`]
      ? { flavors: flavorInfo[`${directory}/flavor-info.ts`] }
      : {}),
    ...(settingsLoader || manifest.fileExtensions?.length
      ? {
          Settings: lazy(async () => ({
            default: settingsLoader
              ? (await settingsLoader()).Settings
              : ((await load()).Settings ?? (() => null)),
          })),
        }
      : {}),
    async start(context) {
      const token = ++generation
      const addon = await startupSpan(`addon-load:${manifest.id}`, load, {
        addonName: manifest.name,
      })
      if (token !== generation) return
      if (addon.manifest.id !== manifest.id)
        throw new Error(
          'This addon’s files do not match its manifest. Reinstall it.',
        )
      instance = addon
      let changed = false
      if (!descriptor.flavors && addon.flavors) {
        descriptor.flavors = addon.flavors
        changed = true
      }
      if (!descriptor.Settings && addon.Settings) {
        descriptor.Settings = addon.Settings
        changed = true
      }
      if (changed) publish()
      await startupSpan(
        `addon-start:${manifest.id}`,
        async () => addon.start(context),
        { addonName: manifest.name },
      )
    },
    stop() {
      generation++
      const previous = instance
      instance = undefined
      previous?.stop?.()
    },
  }
  return descriptor
})
export let addons = bundled
const installed = new Map<
  string,
  { signature: string; addon: Addon; source: 'local' | 'third-party' }
>()
const listeners = new Set<() => void>()
const publish = () => {
  addons = [...bundled, ...[...installed.values()].map((entry) => entry.addon)]
  for (const listener of listeners) listener()
}
function installedAddon(item: InstalledAddon): Addon {
  let generation = 0
  let instance: Omit<Addon, 'manifest'> | null = null
  const addon: Addon = {
    manifest: item.manifest,
    async start(context) {
      const token = ++generation
      if (item.manifest.kind === 'theme') {
        for (const theme of item.themes) context.colorschemes.register(theme)
        return
      }
      if (!item.url)
        throw new Error('This addon is missing its startup file. Reinstall it.')
      const url = item.url
      const [module, sdk] = await startupSpan(
        `addon-load:${item.manifest.id}`,
        () =>
          Promise.all([
            import(/* @vite-ignore */ url) as Promise<{
              default?:
                | SideloadFactory
                | ((sdk: CapabilitySdk) => Omit<Addon, 'manifest'>)
            }>,
            loadAddonSdk(item.manifest.capabilities),
          ]),
        { addonName: item.manifest.name },
      )
      if (token !== generation) return
      if (typeof module.default !== 'function')
        throw new Error(
          'This addon has no valid startup function. Contact its author.',
        )
      // The manifest selects the new optional SDK or the unchanged legacy factory contract.
      const definition = (
        module.default as (host: typeof sdk) => Omit<Addon, 'manifest'>
      )(sdk)
      if (
        !definition ||
        typeof definition.start !== 'function' ||
        (definition.stop !== undefined &&
          typeof definition.stop !== 'function') ||
        (definition.Settings !== undefined &&
          typeof definition.Settings !== 'function')
      )
        throw new Error(
          'This addon cannot start. Contact its author for an updated version.',
        )
      instance = definition
      if (definition.Settings) addon.Settings = definition.Settings
      if (definition.flavors) addon.flavors = definition.flavors
      publish()
      await startupSpan(
        `addon-start:${item.manifest.id}`,
        async () => definition.start(context),
        { addonName: item.manifest.name },
      )
    },
    stop() {
      generation++
      const previous = instance
      instance = null
      if (addon.Settings) {
        delete addon.Settings
        publish()
      }
      previous?.stop?.()
    },
  }
  return addon
}
export const addonRegistry = {
  snapshot: () => addons,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  isInstalled: (id: string) => installed.has(id),
  origin: (id: string) =>
    installed.get(id)?.source ?? origins.get(id) ?? 'local',
  hydrate(packages: readonly InstalledAddon[]) {
    const ids = new Set(packages.map((item) => item.manifest.id))
    for (const id of installed.keys()) if (!ids.has(id)) installed.delete(id)
    for (const item of packages) {
      const signature = JSON.stringify(item)
      if (installed.get(item.manifest.id)?.signature !== signature)
        installed.set(item.manifest.id, {
          signature,
          addon: installedAddon(item),
          source: item.source ?? 'local',
        })
    }
    publish()
  },
}
