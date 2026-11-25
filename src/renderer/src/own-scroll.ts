/**
 * Scroll writes hibi makes to keep a pane's place or line panes up, as
 * opposed to a script scrolling a pane. A split view with scrolling unlinked
 * tells them apart where the write happens.
 */
let depth = 0

export function ownScroll<T>(write: () => T): T {
  depth++
  try {
    return write()
  } finally {
    depth--
  }
}

export const inOwnScroll = () => depth > 0

/** Runs code an addon or another script handed hibi as not hibi's own. */
export function foreignScroll<T>(run: () => T): T {
  const outer = depth
  depth = 0
  try {
    return run()
  } finally {
    depth = outer
  }
}
