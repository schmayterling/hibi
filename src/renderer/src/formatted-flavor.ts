import type { FormattedNodeView, MarkdownFlavor } from '../../addons/api'
import { formattedRegistry } from './formatted-registry'

/** Public flavors use the same lazy contribution registry as bundled features. */
export function registerFormattedFlavor(
  addonId: string,
  flavor: MarkdownFlavor,
  onError: (error: unknown) => void,
) {
  const id = `${addonId}.${flavor.id}`
  let failed = false
  let remove = () => {}
  const guard = <Args extends unknown[], Result>(
    callback: ((...args: Args) => Result) | undefined,
  ) =>
    callback &&
    ((...args: Args): Result | undefined => {
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
    })
  remove = formattedRegistry.register({
    id: `flavor:${id}`,
    load: () => ({
      id,
      flavor: id,
      ...(flavor.syntax ? { syntax: flavor.syntax } : {}),
      views:
        flavor.render?.map((view): FormattedNodeView => {
          const container = guard(view.container)
          return {
            ...view,
            decorate: guard(view.decorate),
            layout: guard(view.layout),
            container:
              container &&
              ((node, context) => {
                const shape = container(node, context)
                if (!shape?.paint) return shape
                const paint = guard(shape.paint)
                return {
                  ...shape,
                  paint: (left, top) => paint?.(left, top) ?? '',
                }
              }),
            ...(view.feature ? { feature: `${addonId}.${view.feature}` } : {}),
          }
        }) ?? [],
    }),
  })
  return remove
}
