import { type ComponentType, lazy } from 'react'
import type { Addon, AddonManifest, MarkdownFlavor } from '../../addons/api'
import { loadAddonSdk } from '../../addons/sdk-loader'
import type { ColorschemeInput } from '../../shared/colorschemes'
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
type Definition = Omit<Addon, 'manifest'> & { manifest?: AddonManifest }
// Elements also carry `$$typeof`, so only React's component wrappers qualify.
const wrappers = new Set(
  ['react.memo', 'react.forward_ref', 'react.lazy'].map((name) =>
    Symbol.for(name),
  ),
)
const component = (value: unknown) =>
  typeof value === 'function' ||
  (typeof value === 'object' &&
    value !== null &&
    wrappers.has((value as { $$typeof: symbol }).$$typeof))
/** Accepts a direct `Addon` or a factory; only factories load an SDK, chosen by the canonical manifest. */
async function normalizeDefinition(
  exported: unknown,
  manifest: AddonManifest,
  cancelled = () => false,
): Promise<Definition | undefined> {
  if (
    typeof exported !== 'function' &&
    (typeof exported !== 'object' || exported === null)
  )
    throw new Error(
      'This addon has no valid startup function. Contact its author.',
    )
  // Capabilities select the optional SDK; omitting them keeps the legacy factory contract.
  const sdk =
    typeof exported === 'function'
      ? await loadAddonSdk(manifest.capabilities)
      : undefined
  // A stop during loading must not run factory code that would own resources.
  if (cancelled()) return
  const definition: Partial<Definition> | null | undefined =
    typeof exported === 'function'
      ? (exported as (sdk: unknown) => Definition)(sdk)
      : exported
  if (
    !definition ||
    typeof definition.start !== 'function' ||
    (definition.stop !== undefined && typeof definition.stop !== 'function') ||
    (definition.Settings !== undefined && !component(definition.Settings)) ||
    (definition.windows !== undefined &&
      (typeof definition.windows !== 'object' ||
        definition.windows === null ||
        !Object.values(definition.windows).every(component)))
  )
    throw new Error(
      'This addon cannot start. Contact its author for an updated version.',
    )
  if (definition.manifest && definition.manifest.id !== manifest.id)
    throw new Error(
      'This addon’s files do not match its manifest. Reinstall it.',
    )
  return definition as Definition
}
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
const bundled = Object.entries(manifests).map(([path, manifest]): Addon => {
  const directory = path.slice(0, path.lastIndexOf('/'))
  origins.set(manifest.id, path.includes('/useraddons/') ? 'local' : 'built-in')
  const loader =
    implementations[`${directory}/index.ts`] ??
    implementations[`${directory}/index.tsx`]
  const importer = () =>
    loader
      ? loader()
      : Promise.reject(
          new Error(
            `The ${manifest.id} addon is missing its startup file. Reinstall it.`,
          ),
        )
  const settingsLoader = settings[`${directory}/Settings.tsx`]
  return describeAddon(manifest, importer, {
    flavors: flavorInfo[`${directory}/flavor-info.ts`],
    ...(settingsLoader || manifest.fileExtensions?.length
      ? {
          Settings: lazy(async () => ({
            default: settingsLoader
              ? (await settingsLoader()).Settings
              : ((await normalizeDefinition(await importer(), manifest))
                  ?.Settings ?? (() => null)),
          })),
        }
      : {}),
  }).addon
})
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
export const addonRegistry = {
  snapshot: () => addons,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  isInstalled: (id: string) => installed.has(id),
  styles: (id: string) => installed.get(id)?.styles ?? [],
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
