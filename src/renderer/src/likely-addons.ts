import type { ToastApi, ToastHandle } from '../../ui/toasts'

/** Past this, a notice counts the rest, and the error stays in view. */
const LISTED = 5

const notice = (addons: readonly string[], reason: string, moreErrors = 0) => {
  const more = addons.length - LISTED
  const names = `${addons.slice(0, LISTED).join(', ')}${more > 0 ? ` and ${more} more` : ''}`
  return {
    variant: 'error' as const,
    message: moreErrors
      ? `Likely addons behind these errors: ${names}: ${reason} and ${moreErrors} more`
      : addons.length > 1
        ? `Likely addons behind this error: ${names}: ${reason}`
        : `Likely addon behind this error: ${names}: ${reason}`,
  }
}

/**
 * A failure that names an addon by a guess. A healthy one can be named, as when
 * the failure depends on focus, so what the user reads says likely.
 */
export class LikelyAddonError extends Error {
  addon: string
  reason: string
  constructor(addon: string, reason: string, cause: unknown) {
    super(notice([addon], reason).message, { cause })
    this.addon = addon
    this.reason = reason
  }
}

/**
 * Lists names in one toast, even when their errors differ. A new name gets its
 * full time; each joins once. A closed toast's names and errors are discarded.
 */
export function likelyAddonsNotices(service: {
  api: ToastApi
  snapshot: () => {
    items: readonly { message: string; closing: boolean }[]
  }
}) {
  let current:
    | {
        addons: string[]
        reason: string
        errors: Set<string>
        message: string
        handle: ToastHandle
      }
    | undefined
  return ({ addon, reason }: LikelyAddonError) => {
    if (
      !current ||
      !service
        .snapshot()
        .items.some(
          (item) => !item.closing && item.message === current?.message,
        )
    ) {
      const options = notice([addon], reason)
      current = {
        addons: [addon],
        reason,
        errors: new Set([reason]),
        message: options.message,
        handle: service.api.show(options),
      }
      return
    }
    if (current.addons.includes(addon)) return
    current.addons.push(addon)
    current.errors.add(reason)
    const options = notice(
      current.addons,
      current.reason,
      current.errors.size - 1,
    )
    current.message = options.message
    current.handle.update({
      ...options,
      duration: service.api.getPreferences().duration,
    })
  }
}
