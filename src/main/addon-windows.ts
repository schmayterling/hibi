import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  type IpcMainInvokeEvent,
  type Rectangle,
  screen,
} from 'electron'
import type { AddonState } from '../addons/api'
import {
  ADDON_WINDOW_CHANNELS,
  type AddonWindowContext,
  type AddonWindowOptions,
} from '../shared/addon-windows'
import { appearanceColors, titleBarColors } from './appearance'
import { retryRename } from './atomic-rename'
import { isTrustedRendererUrl } from './security'
import { testPause } from './test-pauses'

type Entry = AddonWindowContext & {
  window: BrowserWindow
  keepAlive: boolean
  /** Hidden by the user or `close`, so `closed` was already reported. */
  hidden: boolean
  /** Close for real, even with keepAlive. */
  release: boolean
  idle?: ReturnType<typeof setTimeout>
}
type Options = Required<Omit<AddonWindowOptions, 'title' | 'input'>> & {
  title: string | undefined
  input: unknown
}

const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const url = new URL('addon-window.html', devUrl ?? 'app://hibi/').href
const testing = !app.isPackaged && app.commandLine.hasSwitch('hibi-test')
const boundsPath = () => join(app.getPath('userData'), 'addon-windows.json')
const MAX_WINDOWS = 8
const MAX_INPUT = 64 * 1024
// ponytail: fixed idle limit; a hidden editor window holds about 160 MB. Make it an option if an addon needs a different trade-off.
const KEEP_ALIVE_MS =
  (testing && Number(process.env.HIBI_TEST_KEEP_ALIVE_MS)) || 10 * 60 * 1000
const entries = new Map<string, Entry>()
type Pending = {
  addonId: string
  /** The strongest visibility requested while this creation runs. */
  show: boolean
  /** Set by teardown so the creation stops before making a window. */
  cancelled: boolean
  done: Promise<void>
}
const opening = new Map<string, Pending>()
const closedListeners = new Set<(addonId: string, id: string) => void>()
let writing: Promise<void> = Promise.resolve()

const key = (addonId: string, id: string) => `${addonId}/${id}`

function validate(value: unknown): Options {
  const options = (value ?? {}) as Partial<AddonWindowOptions>
  const size = options.size ?? { width: 640, height: 480 }
  const dimension = (number: unknown) =>
    Number.isInteger(number) &&
    (number as number) >= 240 &&
    (number as number) <= 4096
  let input: unknown = null
  try {
    const json = JSON.stringify(options.input ?? null)
    if (json.length <= MAX_INPUT) input = JSON.parse(json)
    else throw new Error('limit')
  } catch {
    throw new Error('This addon window input must be JSON under 64 KB.')
  }
  if (
    typeof value !== 'object' ||
    typeof options.id !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(options.id) ||
    (options.title !== undefined &&
      (typeof options.title !== 'string' || options.title.length > 120)) ||
    !dimension(size.width) ||
    !dimension(size.height) ||
    ![undefined, 'cursor-display', 'center'].includes(options.position) ||
    ![undefined, 'native', 'hibi'].includes(options.titleBar) ||
    ![undefined, true, false].includes(options.alwaysOnTop) ||
    ![undefined, true, false].includes(options.panel) ||
    ![undefined, true, false].includes(options.keepAlive) ||
    ![undefined, true, false].includes(options.show)
  )
    throw new Error('This addon supplied invalid window options.')
  return {
    id: options.id,
    title: options.title,
    size: { width: size.width, height: size.height },
    position: options.position ?? 'center',
    titleBar: options.titleBar ?? 'native',
    alwaysOnTop: options.alwaysOnTop ?? false,
    panel: options.panel ?? false,
    keepAlive: options.keepAlive ?? false,
    show: options.show ?? true,
    input,
  }
}

async function savedBounds(): Promise<
  Record<string, Record<string, Rectangle>>
> {
  try {
    const value: unknown = JSON.parse(await readFile(boundsPath(), 'utf8'))
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, Record<string, Rectangle>>
  } catch {
    // Missing or damaged positions use the default placement.
  }
  return {}
}

function fits(bounds: Rectangle | undefined, area: Rectangle) {
  return (
    !!bounds &&
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.x >= area.x &&
    bounds.y >= area.y &&
    bounds.x + bounds.width <= area.x + area.width &&
    bounds.y + bounds.height <= area.y + area.height
  )
}

/** Open on the display under the pointer, where the user last left this window there. */
async function placement(windowKey: string, options: Options) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const area = display.workArea
  const previous = (await savedBounds())[windowKey]?.[display.id]
  if (previous && fits(previous, area)) return previous
  const width = Math.min(options.size.width, area.width)
  const height = Math.min(options.size.height, area.height)
  const y =
    area.y +
    (options.position === 'cursor-display'
      ? area.height * 0.18
      : (area.height - height) / 2)
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    // A tall window moves up rather than past the bottom of the work area.
    y: Math.round(Math.min(y, area.y + area.height - height)),
    width,
    height,
  }
}

function rememberBounds(windowKey: string, bounds: Rectangle) {
  writing = writing
    .then(async () => {
      const saved = await savedBounds()
      saved[windowKey] = {
        ...saved[windowKey],
        [screen.getDisplayMatching(bounds).id]: bounds,
      }
      const path = boundsPath()
      await writeFile(`${path}.tmp`, JSON.stringify(saved), { mode: 0o600 })
      await retryRename(() => rename(`${path}.tmp`, path))
    })
    .catch((error: unknown) =>
      console.error('could not remember addon window position:', error),
    )
}

const notifyClosed = (entry: Entry) => {
  for (const listener of closedListeners) listener(entry.addonId, entry.id)
}

function reveal(entry: Entry) {
  clearTimeout(entry.idle)
  entry.hidden = false
  const { window } = entry
  // Local tests never take desktop focus; CI's launcher shows test windows.
  if (testing) return
  window.show()
  window.focus()
}

/** Close for good, bypassing keepAlive and any beforeunload handler in the window. */
function destroy(entry: Entry) {
  entry.release = true
  clearTimeout(entry.idle)
  if (entry.window.isDestroyed()) return
  rememberBounds(key(entry.addonId, entry.id), entry.window.getBounds())
  entry.window.destroy()
}

async function create(
  addonId: string,
  name: string,
  options: Options,
  request: Pending,
) {
  const windowKey = key(addonId, options.id)
  const panel = options.panel && process.platform === 'darwin'
  const bounds = await placement(windowKey, options)
  await testPause('addon-window-placement')
  if (request.cancelled)
    throw new Error('This addon window was closed before it opened.')
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 240,
    minHeight: 240,
    show: false,
    // Linux cannot change focusability after creation; CI shows test windows.
    focusable: !testing || process.platform === 'linux',
    title: options.title ?? name,
    fullscreenable: !panel,
    // Panels take keyboard focus without activating Hibi, so its main window
    // stays where it is. Electron also floats them over full-screen apps.
    ...(panel ? { type: 'panel', minimizable: false, maximizable: false } : {}),
    alwaysOnTop: options.alwaysOnTop,
    ...(options.titleBar === 'native'
      ? {}
      : process.platform === 'darwin'
        ? {
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { x: 12, y: 11 },
          }
        : { titleBarStyle: 'hidden', titleBarOverlay: titleBarColors() }),
    ...(process.platform === 'darwin' ? {} : { autoHideMenuBar: true }),
    backgroundColor: appearanceColors().background,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/addon-window.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    },
  })
  const entry: Entry = {
    addonId,
    id: options.id,
    input: options.input,
    title: options.title ?? name,
    titleBar: options.titleBar,
    platform: process.platform,
    window,
    keepAlive: options.keepAlive,
    hidden: !request.show,
    release: false,
  }
  entries.set(windowKey, entry)
  if (process.platform !== 'darwin') window.removeMenu()
  // Keep the addon's title instead of the page's.
  window.on('page-title-updated', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || !isTrustedRendererUrl(event.url, url))
      event.preventDefault()
  })
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) =>
    event.preventDefault(),
  )
  window.once('ready-to-show', () => {
    if (!entry.hidden) reveal(entry)
  })
  window.on('close', (event) => {
    rememberBounds(windowKey, window.getBounds())
    // Quitting and disabling destroy windows directly; this only hides.
    if (!entry.keepAlive || entry.release) return
    event.preventDefault()
    window.hide()
    clearTimeout(entry.idle)
    entry.idle = setTimeout(() => destroy(entry), KEEP_ALIVE_MS)
    if (entry.hidden) return
    entry.hidden = true
    notifyClosed(entry)
  })
  window.on('closed', () => {
    clearTimeout(entry.idle)
    if (entries.get(windowKey) !== entry) return
    entries.delete(windowKey)
    if (!entry.hidden) notifyClosed(entry)
  })
  await window.loadURL(url)
  await testPause('addon-window-loaded')
}

/** Open or focus one window per addon and local ID. The caller checks that the addon is enabled. */
export async function openAddonWindow(
  addonId: string,
  name: string,
  value: unknown,
): Promise<void> {
  const options = validate(value)
  const windowKey = key(addonId, options.id)
  const existing = entries.get(windowKey)
  if (existing) {
    if (options.show) reveal(existing)
    return
  }
  const pending = opening.get(windowKey)
  if (pending) {
    if (options.show) pending.show = true
    return pending.done
  }
  // A loading window is both pending and registered; count each key once.
  const keys = new Set(
    [...entries, ...opening]
      .filter(([, item]) => item.addonId === addonId)
      .map(([windowKey]) => windowKey),
  )
  if (keys.size >= MAX_WINDOWS)
    throw new Error('This addon already has eight windows open.')
  const request: Pending = {
    addonId,
    show: options.show,
    cancelled: false,
    done: Promise.resolve(),
  }
  opening.set(windowKey, request)
  request.done = create(addonId, name, options, request).finally(() =>
    opening.delete(windowKey),
  )
  return request.done
}

export function focusAddonWindow(addonId: string, id: unknown): void {
  const entry = typeof id === 'string' && entries.get(key(addonId, id))
  if (entry) reveal(entry)
}

export function closeAddonWindow(addonId: string, id: unknown): void {
  if (typeof id === 'string') entries.get(key(addonId, id))?.window.close()
}

/** Stop matching creations first, then destroy matching windows. */
function teardown(
  matches: (item: { addonId: string; hidden: boolean }) => boolean,
) {
  for (const request of opening.values())
    if (matches({ addonId: request.addonId, hidden: !request.show }))
      request.cancelled = true
  for (const entry of [...entries.values()]) if (matches(entry)) destroy(entry)
}

/** Tear down every window of an addon, including kept-alive and pending ones. */
export function closeAddonWindows(addonId: string): void {
  teardown((item) => item.addonId === addonId)
}

/** Addons whose windows are open, loading, or kept alive while hidden. */
export function addonWindowOwners(): string[] {
  return [
    ...new Set(
      [...entries.values(), ...opening.values()].map(({ addonId }) => addonId),
    ),
  ]
}

/** Call once quitting is confirmed, or with `hidden` when only hidden windows would keep Hibi running. */
export function releaseAddonWindows(hidden = false): void {
  teardown((item) => !hidden || item.hidden)
}

/** Follow appearance changes in window backgrounds and Hibi-drawn window controls. */
export function refreshAddonWindowColors(): void {
  for (const { window, titleBar } of entries.values()) {
    window.setBackgroundColor(appearanceColors().background)
    if (titleBar === 'hibi' && process.platform !== 'darwin')
      window.setTitleBarOverlay(titleBarColors())
  }
}

/** Editor windows, including hidden kept-alive ones, start and stop addons with the main window's settings. */
export function sendAddonWindowStates(states: AddonState[]): void {
  for (const { window } of entries.values())
    if (!window.webContents.isDestroyed())
      window.webContents.send(ADDON_WINDOW_CHANNELS.statesChanged, states)
}

export function onAddonWindowClosed(
  listener: (addonId: string, id: string) => void,
): void {
  closedListeners.add(listener)
}

/** Identify the addon window that sent a request. Throws for every other sender. */
export function addonWindowSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
): Entry {
  const entry = [...entries.values()].find(
    (candidate) => candidate.window.webContents === event.sender,
  )
  if (
    !entry ||
    event.senderFrame !== event.sender.mainFrame ||
    !isTrustedRendererUrl(event.senderFrame.url, url)
  )
    throw new Error('untrusted ipc sender')
  return entry
}
