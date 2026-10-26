import type { MarkdownFlavor } from '../../addons/api'
import { formattedRegistry } from './formatted-registry'

/** Public flavors use the same lazy contribution registry as bundled features. */
export function registerFormattedFlavor(
  addonId: string,
  flavor: MarkdownFlavor,
) {
  const id = `${addonId}.${flavor.id}`
  return formattedRegistry.register({
    id: `flavor:${id}`,
    load: () => ({
      id,
      flavor: id,
      ...(flavor.syntax ? { syntax: flavor.syntax } : {}),
      views:
        flavor.render?.map((view) => ({
          ...view,
          ...(view.feature ? { feature: `${addonId}.${view.feature}` } : {}),
        })) ?? [],
    }),
  })
}
