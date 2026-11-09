// Swatch colors for Hibi's theme picker, read from a theme's checked CSS.
// Only literal hex values count; anything else keeps Hibi's own colors.
import { tokenize } from './sanitize.ts'

export type Swatches = {
  background?: string
  surface?: string
  ink?: string
  muted?: string
  accent?: string
  border?: string
}
const sources: [keyof Swatches, string[]][] = [
  ['background', ['--background-primary']],
  ['surface', ['--background-secondary', '--background-primary-alt']],
  ['ink', ['--text-normal']],
  ['muted', ['--text-muted']],
  ['accent', ['--interactive-accent', '--color-accent', '--text-accent']],
  ['border', ['--background-modifier-border']],
]

/** Which appearances a theme styles, and its main colors in each. */
export function themePalettes(css: string): {
  modes: ('light' | 'dark')[]
  light: Swatches
  dark: Swatches
} {
  const found = {
    light: new Map<string, string>(),
    dark: new Map<string, string>(),
  }
  const modes = new Set<'light' | 'dark'>()
  let selector = ''
  let depth = 0
  let ruleSelector = ''
  let name = ''
  let value = ''
  let inValue = false
  const commit = () => {
    const hex = value.trim().toLowerCase()
    if (name && /^#[\da-f]{6}$/.test(hex)) {
      const light = /\.theme-light\b/.test(ruleSelector)
      const dark = /\.theme-dark\b/.test(ruleSelector)
      const both =
        !light && !dark && /(^|[\s,])(body|:root)\b/.test(ruleSelector)
      if (light || both) found.light.set(name, hex)
      if (dark || both) found.dark.set(name, hex)
    }
    name = ''
    value = ''
    inValue = false
  }
  for (const token of tokenize(css)) {
    if (token.type === '{') {
      depth++
      ruleSelector = selector
      if (/\.theme-light\b/.test(selector)) modes.add('light')
      if (/\.theme-dark\b/.test(selector)) modes.add('dark')
      selector = ''
    } else if (token.type === '}') {
      commit()
      depth = Math.max(0, depth - 1)
      selector = ''
    } else if (token.type === ';') {
      if (depth) commit()
      else selector = ''
    } else if (
      depth &&
      !inValue &&
      token.type === 'ident' &&
      token.value.startsWith('--')
    )
      name = token.value
    else if (depth && name && !inValue && token.type === ':') inValue = true
    else if (depth && inValue) value += token.raw
    else if (!depth && token.type !== 'comment') selector += token.raw
  }
  const pick = (map: Map<string, string>) => {
    const swatches: Swatches = {}
    for (const [key, names] of sources) {
      const hex = names.map((n) => map.get(n)).find(Boolean)
      if (hex) swatches[key] = hex
    }
    return swatches
  }
  return {
    modes: modes.size ? [...modes].sort() : ['dark', 'light'],
    light: pick(found.light),
    dark: pick(found.dark),
  }
}
