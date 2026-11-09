export const COLOR_TOKENS = [
  'background',
  'surface',
  'sidebar',
  'ink',
  'muted',
  'accent',
  'border',
  'overlay',
  'hover',
  'active',
  'selection',
  'selection-ink',
  'caret',
  'code-background',
  'code-ink',
  'syntax-heading',
  'syntax-link',
  'syntax-code',
  'syntax-meta',
  'syntax-quote',
  'syntax-strong',
  'syntax-emphasis',
  'syntax-keyword',
  'syntax-string',
  'syntax-number',
  'syntax-comment',
  'syntax-type',
  'syntax-function',
  'syntax-variable',
  'syntax-operator',
  'status-success',
  'status-warning',
  'status-danger',
  'status-info',
] as const
export type ColorToken = (typeof COLOR_TOKENS)[number]
export type ColorschemeColors = Record<ColorToken, string>
export type Colorscheme = {
  id: string
  name: string
  appearance: 'light' | 'dark'
  author: string
  license: { name: string; text: string; source?: string }
  /** Heading the theme picker lists the colorscheme under; the picker checks it. */
  group?: string
  colors: ColorschemeColors
}
export type ColorschemeInput = Omit<Colorscheme, 'colors'> & {
  colors: Pick<
    ColorschemeColors,
    'background' | 'surface' | 'ink' | 'muted' | 'accent' | 'border'
  > &
    Partial<ColorschemeColors>
}
export type ThemePreferences = {
  mode: 'system' | 'light' | 'dark'
  light: string
  dark: string
}
export const DEFAULT_THEME: ThemePreferences = {
  mode: 'system',
  light: 'hibi-light',
  dark: 'hibi-dark',
}
export const APPEARANCE_CHANNEL = 'app:appearance'
export type NativeAppearance = {
  preferences: ThemePreferences
  light: { background: string; foreground: string }
  dark: { background: string; foreground: string }
}

export function themePreferences(value: unknown): ThemePreferences {
  const item = value as Partial<ThemePreferences> | null
  const validId = (id: unknown): id is string =>
    typeof id === 'string' && /^[a-z][a-z0-9.-]{0,127}$/.test(id)
  return {
    mode:
      item?.mode === 'light' || item?.mode === 'dark' ? item.mode : 'system',
    light: validId(item?.light) ? item.light : DEFAULT_THEME.light,
    dark: validId(item?.dark) ? item.dark : DEFAULT_THEME.dark,
  }
}

function mix(a: string, b: string, amount: number) {
  return `#${[1, 3, 5]
    .map((index) =>
      Math.round(
        Number.parseInt(a.slice(index, index + 2), 16) * amount +
          Number.parseInt(b.slice(index, index + 2), 16) * (1 - amount),
      )
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

/** Only literal colors are accepted; scheme data cannot load CSS or external URLs. */
export function defineColorscheme(input: ColorschemeInput): Colorscheme {
  if (
    !/^[a-z][a-z0-9.-]{0,127}$/.test(input.id) ||
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.length > 100 ||
    !['light', 'dark'].includes(input.appearance) ||
    typeof input.author !== 'string' ||
    !input.author.trim() ||
    typeof input.license?.name !== 'string' ||
    !input.license.name.trim() ||
    typeof input.license.text !== 'string' ||
    !input.license.text.trim() ||
    input.license.text.length > 32000 ||
    (input.license.source !== undefined &&
      !/^https:\/\//.test(input.license.source))
  )
    throw new Error(
      'This color scheme has an invalid ID, name, author, appearance, or license details.',
    )
  const c = input.colors
  for (const required of [
    'background',
    'surface',
    'ink',
    'muted',
    'accent',
    'border',
  ] as const)
    if (!/^#[\da-f]{6}$/i.test(c[required]))
      throw new Error(
        `This color scheme needs a six-digit hex color for ${required}.`,
      )
  for (const [key, color] of Object.entries(c))
    if (
      !COLOR_TOKENS.includes(key as ColorToken) ||
      !/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color)
    )
      throw new Error(
        `This color scheme has an unknown color name or invalid hex value: ${key}.`,
      )
  return Object.freeze({
    ...input,
    license: Object.freeze({ ...input.license }),
    colors: Object.freeze({
      sidebar: c.surface,
      overlay: input.appearance === 'dark' ? '#00000066' : '#00000033',
      hover: c.surface,
      active: c.border,
      selection: mix(c.accent, c.background, 0.22),
      'selection-ink': c.ink,
      caret: c.ink,
      'code-background': c.surface,
      'code-ink': c.ink,
      'syntax-heading': c.ink,
      'syntax-link': c.accent,
      'syntax-code': c.accent,
      'syntax-meta': c.muted,
      'syntax-quote': c.muted,
      'syntax-strong': c.ink,
      'syntax-emphasis': c.ink,
      'syntax-keyword': c['syntax-heading'] ?? c.accent,
      'syntax-string':
        c['syntax-code'] ??
        (input.appearance === 'dark' ? '#b4e6a4' : '#236032'),
      'syntax-number': c['syntax-link'] ?? c.accent,
      'syntax-comment': c['syntax-meta'] ?? c.muted,
      'syntax-type': c['syntax-link'] ?? c.accent,
      'syntax-function': c['syntax-heading'] ?? c.accent,
      'syntax-variable': c.ink,
      'syntax-operator': c.ink,
      'status-success': input.appearance === 'dark' ? '#b4e6a4' : '#236032',
      'status-warning': input.appearance === 'dark' ? '#edcf8f' : '#704600',
      'status-danger': input.appearance === 'dark' ? '#ffb0b0' : '#aa2233',
      'status-info': input.appearance === 'dark' ? '#a4cbff' : '#254d9e',
      ...c,
    }),
  })
}
