import type { MarkdownFlavor } from '../../addons/api'

/** Registration identity and cleanup stay available before editor modules load. */
export const flavorRegistrations = new WeakMap<
  MarkdownFlavor,
  {
    external: boolean
    active: () => boolean
    remove: () => void
    onError: (error: unknown) => void
  }
>()
