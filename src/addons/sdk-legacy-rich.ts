import type { CapabilitySdk } from './sdk-loader'

/** Keep the legacy SDK error out of the shell and do not import Tiptap. */
export function withoutRichSdk(sdk: CapabilitySdk) {
  Object.defineProperty(sdk, 'tiptap', {
    get() {
      throw new Error(
        'This addon uses the previous formatted editor SDK. Update it to addon API 3 before using its formatted-view features.',
      )
    },
  })
}
