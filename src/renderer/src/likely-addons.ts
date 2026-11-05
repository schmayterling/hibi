import type { ToastApi, ToastHandle } from '../../ui/toasts'

/** Past this, a notice counts the rest, and the error stays in view. */
const LISTED = 5

const notice = (addons: readonly string[], reason: string) => {
  const names = addons.slice(0, LISTED).join(', ')
  const more = addons.length - LISTED
  return {
    variant: 'error' as const,
    message:
      more > 0
        ? `Likely addons behind this error: ${names} and ${more} more: ${reason}`
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
 * Shows each error in one toast that lists every addon named for it while it
 * shows, in whatever passes they are named. A new name gets the toast's full
 * time; each addon joins once, so this ends.
 */
export function likelyAddonsNotices(service: {
  api: ToastApi
  snapshot: () => {
    items: readonly { message: string; closing: boolean }[]
  }
}) {
  const shown = new Map<
    string,
    { addons: string[]; message: string; handle: ToastHandle }
  >()
  return ({ addon, reason }: LikelyAddonError) => {
    const current = shown.get(reason)
    if (
      !current ||
      !service
        .snapshot()
        .items.some((item) => !item.closing && item.message === current.message)
    ) {
      const options = notice([addon], reason)
      shown.set(reason, {
        addons: [addon],
        message: options.message,
        handle: service.api.show(options),
      })
      return
    }
    if (current.addons.includes(addon)) return
    current.addons.push(addon)
    const options = notice(current.addons, reason)
    current.message = options.message
    current.handle.update({
      ...options,
      duration: service.api.getPreferences().duration,
    })
  }
}
