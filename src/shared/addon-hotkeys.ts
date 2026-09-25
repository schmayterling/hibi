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

export type AddonHotkeyRegistration = {
  /** Fully qualified addon command id. */
  id: string
  label: string
  defaultShortcut?: string
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
