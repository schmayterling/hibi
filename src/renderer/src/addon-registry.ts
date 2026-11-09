import catalog from 'virtual:hibi-addon-catalog/renderer'
import { type ComponentType, lazy } from 'react'
import type { Addon, AddonManifest, MarkdownFlavor } from '../../addons/api'
import type { ColorschemeInput } from '../../shared/colorschemes'
import type { InstalledAddon } from '../../shared/sideload'
import { startupSpan } from '../../shared/startup'
import type { Definition } from './addon-definition'

const normalizeDefinition: typeof import('./addon-definition').normalizeDefinition =
  async (...args) =>
    (await import('./addon-definition')).normalizeDefinition(...args)

const trustedWorkspace = () =>
  typeof window !== 'undefined' && !!window.hibiObsidianDesktop

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
      // The host registers declared themes; a theme package has no code to load.
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
const describeBundled = ({
  manifest,
  load,
  loadSettings,
  flavors,
}: (typeof catalog)[number]): Addon => {
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
}
const bundled = catalog.map(describeBundled)

/** Prepared descriptors publish only after the reload operation accepts them. */
export function prepareBundledAddon(
  item: (typeof catalog)[number],
  scope: 'code' | 'styles',
) {
  const index = catalog.findIndex(
    (entry) => entry.manifest.id === item.manifest.id,
  )
  const next = scope === 'code' ? describeBundled(item) : undefined
  return () => {
    catalog[index] = item
    if (next) bundled[index] = next
    details = undefined
    if (next) publish()
  }
}
export let addons = bundled
const installed = new Map<
  string,
  {
    signature: string
    addon: Addon
    retire: () => void
    source: 'local' | 'third-party'
    styles: readonly string[]
    themes: readonly ColorschemeInput[]
    trust: InstalledAddon['trust']
    revoked: InstalledAddon['revoked']
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
    if (import.meta.hot) return Promise.resolve()
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
  paused(id: string) {
    const entry = installed.get(id)
    return !!(
      trustedWorkspace() &&
      entry &&
      entry.addon.manifest.kind !== 'theme'
    )
  },
  /** Declared stylesheet URLs and color schemes; `reread` validates an installed package's current files again. */
  resources: async (
    id: string,
    reread = false,
  ): Promise<{
    styles: readonly string[]
    themes: readonly ColorschemeInput[]
  }> => {
    const entry = installed.get(id)
    if (entry && reread) {
      const { styles = [], themes } =
        await window.hibi.getInstalledAddonResources(id)
      // Later activations keep the updated resources.
      Object.assign(entry, { styles, themes })
    }
    if (entry) return { styles: entry.styles, themes: entry.themes }
    const resources = await catalog
      .find((item) => item.manifest.id === id)
      ?.loadResources?.()
    return { styles: resources?.styles ?? [], themes: resources?.themes ?? [] }
  },
  origin: (id: string) =>
    installed.get(id)?.source ?? origins.get(id) ?? 'local',
  /** Installed addons only; installs that predate signing count as unsigned. */
  trust: (id: string) =>
    installed.has(id) ? (installed.get(id)?.trust ?? 'unsigned') : undefined,
  revoked: (id: string) => installed.get(id)?.revoked,
  /** Returns the ids whose installed files were replaced. */
  hydrate(packages: readonly InstalledAddon[]) {
    const ids = new Set(packages.map((item) => item.manifest.id))
    const replaced: string[] = []
    for (const [id, entry] of installed)
      if (!ids.has(id)) {
        entry.retire()
        installed.delete(id)
      }
    for (const item of packages) {
      const signature = JSON.stringify(item)
      const previous = installed.get(item.manifest.id)
      if (previous?.signature === signature) continue
      if (previous) {
        previous.retire()
        replaced.push(item.manifest.id)
      }
      const { url } = item
      installed.set(item.manifest.id, {
        signature,
        ...describeAddon(
          item.manifest,
          async () => {
            if (trustedWorkspace())
              throw new Error(
                'Installed addons are paused while full computer access is on. Turn off full access or disable this addon.',
              )
            if (!url)
              throw new Error(
                'This addon is missing its startup file. Reinstall it.',
              )
            return (await import(/* @vite-ignore */ url)).default
          },
          { themes: item.themes },
        ),
        source: item.source ?? 'local',
        styles: item.styles ?? [],
        themes: item.themes,
        trust: item.trust,
        revoked: item.revoked,
      })
    }
    publish()
    return replaced
  },
}
