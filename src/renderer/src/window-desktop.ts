import type { AddonWindowBridge } from '../../shared/addon-windows'
import type { DesktopApi } from '../../shared/desktop'

/**
 * Stand-in for `window.hibi` in an addon editor window. It holds no privileges:
 * document edits stay in this renderer, addon states come from the window's
 * read-only bridge, listeners never fire, and every other request rejects.
 */
export function windowDesktop(bridge: AddonWindowBridge): DesktopApi {
  const unavailable = (name: string) => () =>
    Promise.reject(new Error(`${name} is not available in this window.`))
  const known: Partial<DesktopApi> = {
    bootstrap: {
      document: unavailable('bootstrap.document'),
      addons: async () => ({
        states: await bridge.states(),
        packages: [],
        notices: [],
      }),
      recentWorkspaces: async () => [],
      knownWorkspaces: async () => [],
    },
    admitSourceOperation: () => {},
    appendSourceOperation: async (operation) => ({
      tabId: operation.document.tabId,
      revision: operation.document.revision,
      contentVersion: operation.contentVersion,
      operationId: operation.operationId,
    }),
    flushDocumentChanges: async () => {},
    getWorkspace: async () => null,
    setHotkeyRecording: async () => {},
  }
  return new Proxy(known, {
    get(target, key) {
      if (typeof key !== 'string') return undefined
      if (Object.hasOwn(target, key)) return target[key as keyof DesktopApi]
      if (/^on[A-Z]/.test(key)) return () => () => {}
      return unavailable(key)
    },
  }) as DesktopApi
}
