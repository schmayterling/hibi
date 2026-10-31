import { shortcutError } from './hotkeys.ts'

export const ADDON_HOTKEY_CHANNELS = {
  get: 'addon-hotkeys:get',
  register: 'addon-hotkeys:register',
  unregister: 'addon-hotkeys:unregister',
  save: 'addon-hotkeys:save',
  reset: 'addon-hotkeys:reset',
  changed: 'addon-hotkeys:changed',
  invoke: 'addon-hotkeys:invoke',
} as const

export type AddonMenuContribution = {
  location: 'app'
  group?: string
  order?: number
}

export function validCommandMenu(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const menu = value as Record<string, unknown>
  return (
    (menu.location === 'app' ||
      menu.location === 'explorer' ||
      menu.location === 'editor') &&
    (menu.group === undefined ||
      (typeof menu.group === 'string' &&
        menu.group.length <= 40 &&
        /^[a-z][a-z0-9-]*$/.test(menu.group))) &&
    (menu.order === undefined ||
      (Number.isInteger(menu.order) && Math.abs(menu.order as number) <= 10000))
  )
}

/** A declared default shortcut that main binds on every platform, where `mod` becomes Command or Control. */
export function validCommandShortcut(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    ['darwin', 'linux', 'win32'].every((platform) => {
      const shortcut = value.replace(
        /^mod\+/i,
        platform === 'darwin' ? 'meta+' : 'ctrl+',
      )
      return (
        !!shortcut &&
        shortcut.length <= 60 &&
        !shortcutError(shortcut, platform)
      )
    })
  )
}

export type AddonHotkeyRegistration = {
  /** Fully qualified addon command id. */
  id: string
  label: string
  defaultShortcut?: string
  /** Exposes command invocation without adding a configurable shortcut. */
  runnableOnly?: boolean
  menu?: AddonMenuContribution
  /** Identifies one addon activation so an old disposer cannot remove its replacement. */
  token: string
}

export type AddonMenuItem = Pick<
  AddonHotkeyRegistration,
  'id' | 'label' | 'token'
> & { menu: AddonMenuContribution }

export type AddonCommandInvocation = {
  id: string
  token: string
  source: 'menu' | 'shortcut'
}

export type AddonHotkeyBinding = {
  id: string
  label: string
  defaultShortcut: string
  /** User override, if present, or the addon's current default. */
  shortcut: string
  /** Empty when another command owns the shortcut. */
  effectiveShortcut: string
  overridden: boolean
  conflictWith?: { id: string; label: string }
}
