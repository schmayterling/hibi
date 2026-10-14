import catalog from 'virtual:hibi-addon-catalog/renderer'
import { type ComponentType, lazy } from 'react'
import type { Addon, AddonManifest, MarkdownFlavor } from '../../addons/api'
import type { ColorschemeInput } from '../../shared/colorschemes'
import type { InstalledAddon } from '../../shared/sideload'
import { startupSpan } from '../../shared/startup'
import { type Definition, normalizeDefinition } from './addon-definition'

const origins = new Map(
  catalog.map(({ manifest, source }) => [manifest.id, source]),
)
/** One descriptor for bundled and installed addons. Nothing is imported until `start` or declared settings render. */
function describeAddon(
  manifest: AddonManifest,
  importer: () => Promise<unknown>,
  declared: {
    flavors?: readonly MarkdownFlavor[] | undefined
    Settings?: ComponentType
    themes?: readonly ColorschemeInput[]
  } = {},
) {
  let pending: Promise<unknown> | undefined
  const load = () =>
    (pending ??= importer().catch((error) => {
      pending = undefined
      throw error
    }))
  let generation = 0
  let instance: Definition | undefined
  const descriptor: Addon = {
    manifest,
    ...(declared.flavors ? { flavors: declared.flavors } : {}),
    ...(declared.Settings ? { Settings: declared.Settings } : {}),
    async start(context) {
      const token = ++generation
      // Declared themes are data owned by this activation; source themes still register colors in `start`.
      for (const theme of declared.themes ?? [])
        context.colorschemes.register(theme)
      if (manifest.kind === 'theme' && declared.themes) return
      const definition = await startupSpan(
        `addon-load:${manifest.id}`,
        async () =>
          normalizeDefinition(
            await load(),
            manifest,
            () => token !== generation,
          ),
        { addonName: manifest.name },
      )
      if (!definition || token !== generation) return
      instance = definition
      let changed = false
      if (
        !declared.flavors &&
        definition.flavors &&
        definition.flavors !== descriptor.flavors
      ) {
        descriptor.flavors = definition.flavors
        changed = true
      }
      if (
        !declared.Settings &&
        definition.Settings &&
        definition.Settings !== descriptor.Settings
      ) {
        descriptor.Settings = definition.Settings
        changed = true
      }
      if (changed) publish()
      await startupSpan(
        `addon-start:${manifest.id}`,
        async () => definition.start(context),
        { addonName: manifest.name },
      )
    },
    stop() {
      generation++
      const previous = instance
      instance = undefined
      // Runtime settings close over the stopped instance; declared settings stay available.
      if (!declared.Settings && descriptor.Settings) {
        delete descriptor.Settings
        publish()
      }
      previous?.stop?.()
    },
  }
  const retire = () => {
    generation++
    pending = undefined
    delete descriptor.Settings
    delete descriptor.flavors
  }
  return { addon: descriptor, retire }
}
const bundled = catalog.map(
  ({ manifest, load, loadSettings, flavors }): Addon => {
    const importer = async () => (await load()).default
    return describeAddon(manifest, importer, {
      flavors,
      ...(loadSettings || manifest.fileExtensions?.length
        ? {
            Settings: lazy(async () => ({
              default: loadSettings
                ? (await loadSettings()).Settings
                : ((await normalizeDefinition(await importer(), manifest))
                    ?.Settings ?? (() => null)),
            })),
          }
        : {}),
    }).addon
  },
)
export let addons = bundled
const installed = new Map<
  string,
  {
    signature: string
    addon: Addon
    retire: () => void
    source: 'local' | 'third-party'
    styles: readonly string[]
  }
>()
const listeners = new Set<() => void>()
const publish = () => {
  addons = [...bundled, ...[...installed.values()].map((entry) => entry.addon)]
  for (const listener of listeners) listener()
}
let details: Promise<void> | undefined
export const addonRegistry = {
  snapshot: () => addons,
  loadDetails() {
    details ??= import('virtual:hibi-addon-catalog/details')
      .then(({ default: metadata }) => {
        for (const { manifest } of bundled)
          Object.assign(manifest, metadata[manifest.id])
        publish()
      })
      .catch((error) => {
        details = undefined
        throw error
      })
    return details
  },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  isInstalled: (id: string) => installed.has(id),
  styles: (id: string) => installed.get(id)?.styles,
  origin: (id: string) =>
    installed.get(id)?.source ?? origins.get(id) ?? 'local',
  hydrate(packages: readonly InstalledAddon[]) {
    const ids = new Set(packages.map((item) => item.manifest.id))
    for (const [id, entry] of installed)
      if (!ids.has(id)) {
        entry.retire()
        installed.delete(id)
      }
    for (const item of packages) {
      const signature = JSON.stringify(item)
      const previous = installed.get(item.manifest.id)
      if (previous?.signature === signature) continue
      previous?.retire()
      const { url } = item
      installed.set(item.manifest.id, {
        signature,
        ...describeAddon(
          item.manifest,
          () =>
            url
              ? import(/* @vite-ignore */ url).then(
                  (module: { default?: unknown }) => module.default,
                )
              : Promise.reject(
                  new Error(
                    'This addon is missing its startup file. Reinstall it.',
                  ),
                ),
          { themes: item.themes },
        ),
        source: item.source ?? 'local',
        styles: item.styles ?? [],
      })
    }
    publish()
  },
}
