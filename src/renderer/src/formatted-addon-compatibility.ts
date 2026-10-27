import type { MarkdownFlavor, ToastApi } from '../../addons/api'
import { flavors } from './flavors'
import { formattedCompatibility } from './formatted-compatibility'
import { formattedRegistry } from './formatted-registry'
import { markdownSyntax } from './markdown-syntax'

/** Owned notices for addons that have not migrated their formatted features. */
export function createFormattedCompatibility(
  id: string,
  name: string,
  toasts: ToastApi,
  openSettings: () => void,
) {
  let notice: ReturnType<ToastApi['show']> | undefined
  const syntax = markdownSyntax.subscribe(formattedCompatibility.refresh)
  const registeredFlavors = flavors.subscribe(formattedCompatibility.refresh)
  const formatted = formattedRegistry.subscribe(formattedCompatibility.refresh)
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
      return formattedCompatibility.registerFeatures(id, () => {
        if (!flavors.snapshot().some((entry) => entry.id === flavorId))
          return { rich: [], formatted: [] }
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
          formatted: formattedRegistry
            .entries()
            .some((entry) => entry.id === `flavor:${flavorId}`)
            ? [
                `flavor:${flavor.id}`,
                ...(flavor.render?.flatMap((view) =>
                  view.feature ? [view.feature] : [],
                ) ?? []),
                ...features
                  .filter(
                    (feature) =>
                      feature.nodes?.length &&
                      feature.nodes.every((node) =>
                        flavor.render?.some(
                          (view) => !view.feature && view.nodes.includes(node),
                        ),
                      ),
                  )
                  .map(local),
              ]
            : [],
        }
      })
    },
    dispose() {
      syntax()
      registeredFlavors()
      formatted()
      unsubscribe()
      notice?.dismiss()
    },
  }
}
