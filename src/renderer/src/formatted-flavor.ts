import type { FormattedNodeView, MarkdownFlavor } from '../../addons/api'
import { flavorSyntax } from './flavor-syntax'
import { formattedRegistry } from './formatted-registry'

/** Public flavors use the same lazy contribution registry as bundled features. */
export function registerFormattedFlavor(
  addonId: string,
  flavor: MarkdownFlavor,
  onError: (error: unknown) => void,
) {
  const id = flavor.id.startsWith(`${addonId}.`)
    ? flavor.id
    : `${addonId}.${flavor.id}`
  const syntax = flavorSyntax(flavor)
  let failed = false
  let remove = () => {}
  const guard =
    <Args extends unknown[], Result>(callback: (...args: Args) => Result) =>
    (...args: Args): Result | undefined => {
      if (failed) return
      try {
        return callback(...args)
      } catch (error) {
        failed = true
        queueMicrotask(() => {
          remove()
          onError(error)
        })
      }
    }
  remove = formattedRegistry.register({
    id: `flavor:${id}`,
    load: () => ({
      id,
      flavor: id,
      ...(syntax ? { syntax } : {}),
      views:
        flavor.render?.map((view): FormattedNodeView => {
          const container = view.container && guard(view.container)
          return {
            ...view,
            ...(view.decorate ? { decorate: guard(view.decorate) } : {}),
            ...(view.layout ? { layout: guard(view.layout) } : {}),
            ...(container
              ? {
                  container(node, context) {
                    const shape = container(node, context)
                    if (!shape?.paint) return shape
                    const paint = guard(shape.paint)
                    return {
                      ...shape,
                      paint: (left, top) => paint(left, top) ?? '',
                    }
                  },
                }
              : {}),
            ...(view.feature ? { feature: `${addonId}.${view.feature}` } : {}),
          }
        }) ?? [],
    }),
  })
  return remove
}
