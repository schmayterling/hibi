import type { Addon, AddonManifest } from '../../addons/api'
import { loadAddonSdk } from '../../addons/sdk-loader'

export type Definition = Omit<Addon, 'manifest'> & { manifest?: AddonManifest }
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
export async function normalizeDefinition(
  exported: unknown,
  manifest: { id: string; capabilities?: AddonManifest['capabilities'] },
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
