import type { NodeType } from '@lezer/common'
import { parser } from '@lezer/markdown'
import type { MarkdownFlavor, ToastApi } from '../../addons/api'
import { flavorSyntax } from './flavor-syntax'
import { flavors } from './flavors'
import { formattedCompatibility } from './formatted-compatibility'
import { formattedRegistry } from './formatted-registry'
import { markdownSyntax } from './markdown-syntax'

// These singleton stores outlive individual addon scopes.
markdownSyntax.subscribe(formattedCompatibility.refresh)
flavors.subscribe(formattedCompatibility.refresh)
formattedRegistry.subscribe(formattedCompatibility.refresh)

/** Owned notices for addons that have not migrated their formatted features. */
export function createFormattedCompatibility(
  id: string,
  name: string,
  toasts: ToastApi,
  openSettings: () => void,
) {
  let notice: ReturnType<ToastApi['show']> | undefined
  const unsubscribe = formattedCompatibility.subscribe(() => {
    if (formattedCompatibility.snapshot().includes(id)) {
      notice ??= toasts.show({
        message: `${name} has features made for the previous formatted editor. Those features are off until it is updated; source view is unaffected.`,
        duration: 0,
        action: { label: 'Open addon settings', run: openSettings },
      })
    } else {
      notice?.dismiss()
      notice = undefined
    }
  })
  return {
    register: (kind: 'rich' | 'formatted', feature: string) =>
      formattedCompatibility.register(id, kind, feature),
    registerFlavor(flavor: MarkdownFlavor) {
      const flavorId = `${id}.${flavor.id}`
      let seenFormatted = false
      let types: readonly NodeType[] | undefined
      return formattedCompatibility.registerFeatures(id, () => {
        const registered = flavors
          .snapshot()
          .find((entry) => entry.id === flavorId)
        if (!registered) return { rich: [], formatted: [] }
        if (!types) {
          try {
            types = parser.configure(flavorSyntax(registered) ?? {}).nodeSet
              .types
          } catch {
            // The formatted loader reports invalid syntax through its existing error route.
            types = parser.nodeSet.types
          }
        }
        const present = formattedRegistry
          .entries()
          .some((entry) => entry.id === `flavor:${flavorId}`)
        seenFormatted ||= present
        const covered =
          present || (!seenFormatted && (flavor.syntax || flavor.render))
        const features = markdownSyntax
          .snapshot()
          .filter(
            (feature) => feature.owner === id && feature.scope !== 'document',
          )
        const local = (feature: (typeof features)[number]) =>
          feature.id.slice(id.length + 1)
        return {
          rich:
            flavor.richExtensions?.flatMap((extension) => {
              const matching = features.filter((feature) =>
                feature.extensions?.includes(extension.name),
              )
              return matching.length
                ? matching.map(local)
                : [`flavor:${flavor.id}`]
            }) ?? [],
          formatted: covered
            ? [
                `flavor:${flavor.id}`,
                ...(flavor.render?.flatMap((view) =>
                  view.feature ? [view.feature] : [],
                ) ?? []),
                ...features
                  .filter(
                    (feature) =>
                      feature.nodes?.length &&
                      feature.nodes.every((node) => {
                        const type = types?.find((type) => type.name === node)
                        return flavor.render?.some(
                          (view) =>
                            !view.feature &&
                            view.nodes.some((name) =>
                              type ? type.is(name) : node === name,
                            ),
                        )
                      }),
                  )
                  .map(local),
              ]
            : [],
        }
      })
    },
    dispose() {
      unsubscribe()
      notice?.dismiss()
    },
  }
}
