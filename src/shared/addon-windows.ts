export const ADDON_WINDOW_CHANNELS = {
  open: 'addon-windows:open',
  focus: 'addon-windows:focus',
  close: 'addon-windows:close',
  closed: 'addon-windows:closed',
  owners: 'addon-windows:owners',
  /** Requests from inside an addon window, scoped to the addon that owns it. */
  context: 'addon-windows:context',
  states: 'addon-windows:states',
  statesChanged: 'addon-windows:states-changed',
  closeSelf: 'addon-windows:close-self',
  invoke: 'addon-windows:invoke',
  query: 'addon-windows:query',
} as const

export type AddonWindowOptions = {
  /** Local window ID. Opening the same ID again focuses the existing window. */
  id: string
  /** Defaults to the addon name. */
  title?: string
  /** Initial content size in pixels. Hibi keeps the size the user last chose on each display. */
  size?: { width: number; height: number }
  /** `cursor-display` opens near the top of the display with the pointer; `center` centers on that display. Defaults to `center`. */
  position?: 'cursor-display' | 'center'
  /** `hibi` replaces the system title bar with Hibi's compact bar and window controls, as in the main window. Defaults to `native`. */
  titleBar?: 'native' | 'hibi'
  /** Keep the window above other applications. */
  alwaysOnTop?: boolean
  /** On macOS, float over full-screen apps on every Space and take keyboard focus without bringing Hibi forward. Ignored elsewhere. */
  panel?: boolean
  /** Closing hides the window and keeps its renderer for ten minutes, so reopening is immediate. Disabling the addon or quitting still closes it. */
  keepAlive?: boolean
  /** Set to false to prepare the window without showing it, for example at idle. Defaults to true. */
  show?: boolean
  /** JSON value passed to the window component. Limited to 64 KB. */
  input?: unknown
}

/** Identity and input sent to an addon window's renderer. */
export type AddonWindowContext = {
  addonId: string
  id: string
  input: unknown
  title: string
  titleBar: 'native' | 'hibi'
  platform: string
  /** Whether Hibi's window controls are hidden for this app session. */
  windowControlsHidden?: boolean
}

/** The only desktop requests available inside an addon window. */
export type AddonWindowBridge = {
  context: () => Promise<AddonWindowContext>
  /** Enabled and disabled addons, so an editor window can start the same editor addons. */
  states: () => Promise<import('../addons/api').AddonState[]>
  /** Addon state changes accepted after `states` was read. */
  onStates: (
    listener: (states: import('../addons/api').AddonState[]) => void,
  ) => () => void
  /** Close this window the way its close button does, so kept-alive windows hide. */
  close: () => Promise<void>
  query: (method: string, input?: unknown) => Promise<unknown>
  invoke: (method: string, input?: unknown) => Promise<unknown>
}
/** `window.hibiAddonWindow`. `seal` hands the bridge over once; afterwards only `context` and `close` answer. */
export type AddonWindowGlobal = AddonWindowBridge & {
  seal: () => AddonWindowBridge | undefined
}
