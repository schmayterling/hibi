import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, nativeTheme } from 'electron'
import {
  DEFAULT_THEME,
  type NativeAppearance,
  themePreferences,
} from '../shared/colorschemes'
import { writeText } from './files'

let appearance: NativeAppearance = {
  preferences: DEFAULT_THEME,
  light: { background: '#ffffff', foreground: '#1b2021' },
  dark: { background: '#181818', foreground: '#e4e9e9' },
}
let writing: Promise<void> = Promise.resolve()
function validate(value: unknown): NativeAppearance {
  const input = value as NativeAppearance | null
  const preferences = themePreferences(input?.preferences)
  if (
    !input?.preferences ||
    ['mode', 'light', 'dark'].some(
      (key) =>
        input.preferences[key as keyof typeof preferences] !==
        preferences[key as keyof typeof preferences],
    )
  )
    throw new Error(
      'Could not read these appearance settings. Choose them again.',
    )
  for (const mode of ['light', 'dark'] as const)
    if (
      !/^#[\da-f]{6}$/i.test(input[mode]?.background) ||
      !/^#[\da-f]{6}$/i.test(input[mode]?.foreground)
    )
      throw new Error('This theme has invalid colors. Choose another theme.')
  return {
    preferences,
    light: {
      background: input.light.background,
      foreground: input.light.foreground,
    },
    dark: {
      background: input.dark.background,
      foreground: input.dark.foreground,
    },
  }
}
export async function loadAppearance() {
  try {
    appearance = validate(
      JSON.parse(
        await readFile(
          join(app.getPath('userData'), 'appearance.json'),
          'utf8',
        ),
      ),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('could not load appearance:', error)
  }
  nativeTheme.themeSource = appearance.preferences.mode
}
export function appearanceColors() {
  const mode =
    appearance.preferences.mode === 'system'
      ? nativeTheme.shouldUseDarkColors
        ? 'dark'
        : 'light'
      : appearance.preferences.mode
  return appearance[mode]
}
/** Window-control colors for frameless windows on Windows and Linux. */
export function titleBarColors() {
  return {
    color: appearanceColors().background,
    symbolColor: appearanceColors().foreground,
    height: 36,
  }
}
export function exportedAppearance() {
  return { ...appearance.preferences }
}
export function saveAppearance(value: unknown) {
  const next = validate(value)
  if (JSON.stringify(next) === JSON.stringify(appearance)) return writing
  appearance = next
  if (nativeTheme.themeSource !== next.preferences.mode)
    nativeTheme.themeSource = next.preferences.mode
  const path = join(app.getPath('userData'), 'appearance.json')
  writing = writing
    .catch(() => {})
    .then(async () => {
      await writeText(path, JSON.stringify(next))
    })
  return writing
}
