export const GLOBAL_SHORTCUT_CHANNELS = {
  register: 'global-shortcut:register',
  unregister: 'global-shortcut:unregister',
  invoked: 'global-shortcut:invoked',
} as const

export type GlobalShortcutInvocation = { id: string; token: string }
