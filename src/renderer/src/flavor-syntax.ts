import type { MarkdownFlavor } from '../../addons/api'
import { errorMessage } from '../../shared/errors'
import { guardMarkdownSyntax } from '../../shared/markdown-flavor-guard'
import { flavorRegistrations } from './flavor-registrations'

const syntax = new WeakMap<MarkdownFlavor, MarkdownFlavor['syntax']>()

/** Source and formatted parsers share one quarantine per registration. */
export function flavorSyntax(flavor: MarkdownFlavor) {
  const registration = flavorRegistrations.get(flavor)
  if (!registration?.external || !flavor.syntax) return flavor.syntax
  if (!syntax.has(flavor))
    syntax.set(
      flavor,
      guardMarkdownSyntax(flavor.syntax, registration.active, (error) =>
        queueMicrotask(() => {
          registration.remove()
          registration.onError(
            new Error(`${flavor.id}: ${errorMessage(error)}`, { cause: error }),
          )
        }),
      ),
    )
  return syntax.get(flavor)
}
