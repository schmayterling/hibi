export const APP_ICON_CHANNELS = {
  get: 'app-icon:get',
  set: 'app-icon:set',
} as const

export const APP_ICON_MODES = ['app', 'system', 'light', 'dark'] as const
export type AppIconMode = (typeof APP_ICON_MODES)[number]

export function isAppIconMode(value: unknown): value is AppIconMode {
  return APP_ICON_MODES.some((mode) => mode === value)
}

export function darkAppIcon(
  mode: AppIconMode,
  appDark: boolean,
  systemDark: boolean,
): boolean {
  if (mode === 'app') return appDark
  if (mode === 'system') return systemDark
  return mode === 'dark'
}
