import type { ToastApi } from '../../addons/api'
import { formattedCompatibility } from './formatted-compatibility'

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
        message: `${name} was made for the previous formatted editor. Its formatted-view features are off until it is updated; source view is unaffected.`,
        duration: 0,
        action: { label: 'Open addon settings', run: openSettings },
      })
    } else {
      notice?.dismiss()
      notice = undefined
    }
  })
  return {
    register: (kind: 'rich' | 'formatted') =>
      formattedCompatibility.register(id, kind),
    dispose() {
      unsubscribe()
      notice?.dismiss()
    },
  }
}
