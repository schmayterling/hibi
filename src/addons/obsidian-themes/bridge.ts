// Obsidian themes set Obsidian's variables on `body`; Hibi's elements read
// Hibi's tokens. `:root` captures Hibi's current values in carriers, `body`
// gets Obsidian's default environment from those carriers (as Obsidian itself
// defines it on body), and Hibi's tokens are then read back from Obsidian's
// variables on body. Nothing refers back to a token on its own element, so
// there are no cycles, and an unset Obsidian variable keeps Hibi's look.

/** Obsidian variable → its default, from a Hibi carrier or another Obsidian variable. */
export const OBSIDIAN_DEFAULTS: Readonly<Record<string, string>> = {
  '--background-primary': 'var(--hibi-o-background)',
  '--background-primary-alt': 'var(--hibi-o-surface)',
  '--background-secondary': 'var(--hibi-o-sidebar)',
  '--background-secondary-alt': 'var(--hibi-o-surface)',
  '--background-modifier-border': 'var(--hibi-o-border)',
  '--background-modifier-hover': 'var(--hibi-o-hover)',
  '--background-modifier-active-hover': 'var(--hibi-o-active)',
  '--background-modifier-cover': 'var(--hibi-o-overlay)',
  '--background-modifier-form-field': 'var(--hibi-o-field-background)',
  '--text-normal': 'var(--hibi-o-ink)',
  '--text-muted': 'var(--hibi-o-muted)',
  '--text-faint': 'var(--hibi-o-muted)',
  '--color-accent': 'var(--hibi-o-accent)',
  '--text-accent': 'var(--hibi-o-syntax-link)',
  '--text-accent-hover': 'var(--text-accent)',
  '--interactive-accent': 'var(--color-accent)',
  '--interactive-normal': 'var(--background-primary-alt)',
  '--interactive-hover': 'var(--background-modifier-hover)',
  '--text-selection': 'var(--hibi-o-selection)',
  '--caret-color': 'var(--text-normal)',
  '--link-color': 'var(--text-accent)',
  '--link-external-color': 'var(--text-accent)',
  '--code-normal': 'var(--hibi-o-code-ink)',
  '--code-comment': 'var(--hibi-o-syntax-comment)',
  '--code-keyword': 'var(--hibi-o-syntax-keyword)',
  '--code-string': 'var(--hibi-o-syntax-string)',
  '--code-function': 'var(--hibi-o-syntax-function)',
  '--code-operator': 'var(--hibi-o-syntax-operator)',
  '--code-value': 'var(--hibi-o-syntax-number)',
  '--code-property': 'var(--hibi-o-syntax-variable)',
  '--code-tag': 'var(--hibi-o-syntax-type)',
  '--blockquote-color': 'var(--hibi-o-syntax-quote)',
  '--bold-color': 'var(--hibi-o-syntax-strong)',
  '--italic-color': 'var(--hibi-o-syntax-emphasis)',
  '--text-error': 'var(--hibi-o-status-danger)',
  '--text-success': 'var(--hibi-o-status-success)',
  '--text-warning': 'var(--hibi-o-status-warning)',
  '--color-red': 'var(--hibi-o-status-danger)',
  '--color-green': 'var(--hibi-o-status-success)',
  '--color-yellow': 'var(--hibi-o-status-warning)',
  '--color-blue': 'var(--hibi-o-status-info)',
  '--font-monospace': 'var(--hibi-o-font-mono)',
  '--font-text': 'var(--hibi-o-font-ui)',
  '--font-text-size': 'var(--hibi-o-text-editor)',
  // Sizes themes refer to without defining them.
  '--size-4-1': 'var(--hibi-o-space-1)',
  '--size-4-2': 'var(--hibi-o-space-2)',
  '--size-4-3': 'var(--hibi-o-space-3)',
  '--size-4-4': 'var(--hibi-o-space-4)',
  '--size-4-6': 'var(--hibi-o-space-5)',
  '--size-4-8': 'var(--hibi-o-space-6)',
  '--radius-s': 'var(--hibi-o-radius-control)',
  '--radius-m': 'var(--hibi-o-radius-panel)',
  '--font-ui-smaller': 'var(--hibi-o-text-sm)',
  '--font-ui-small': 'var(--hibi-o-text-ui)',
  '--text-on-accent': 'var(--hibi-o-background)',
  '--interactive-accent-hover': 'var(--interactive-accent)',
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6].map((level) => [
      `--h${level}-color`,
      'var(--hibi-o-syntax-heading)',
    ]),
  ),
}

/** Hibi token → the Obsidian variable it is read from while a theme is on. */
export const HIBI_FROM_OBSIDIAN: Readonly<Record<string, string>> = {
  '--background': '--background-primary',
  '--surface': '--background-primary-alt',
  '--sidebar': '--background-secondary',
  '--border': '--background-modifier-border',
  '--hover': '--background-modifier-hover',
  '--active': '--background-modifier-active-hover',
  '--overlay': '--background-modifier-cover',
  '--field-background': '--background-modifier-form-field',
  '--field-border': '--background-modifier-border',
  '--field-placeholder': '--text-faint',
  '--ink': '--text-normal',
  '--muted': '--text-muted',
  '--accent': '--interactive-accent',
  '--selection': '--text-selection',
  '--caret': '--caret-color',
  '--syntax-link': '--link-color',
  '--syntax-meta': '--text-faint',
  '--syntax-quote': '--blockquote-color',
  '--syntax-strong': '--bold-color',
  '--syntax-emphasis': '--italic-color',
  '--code-ink': '--code-normal',
  '--syntax-code': '--code-normal',
  '--syntax-comment': '--code-comment',
  '--syntax-keyword': '--code-keyword',
  '--syntax-string': '--code-string',
  '--syntax-function': '--code-function',
  '--syntax-operator': '--code-operator',
  '--syntax-number': '--code-value',
  '--syntax-variable': '--code-property',
  '--syntax-type': '--code-tag',
  '--status-danger': '--text-error',
  '--status-success': '--text-success',
  '--status-warning': '--text-warning',
  '--font-mono': '--font-monospace',
  '--text-editor': '--font-text-size',
}

const carried = [
  ...new Set(
    Object.values(OBSIDIAN_DEFAULTS).flatMap((value) =>
      [...value.matchAll(/var\(--hibi-o-([\w-]+)\)/g)].map((match) => match[1]),
    ),
  ),
]

const guard = [
  'display: block',
  'visibility: visible',
  'opacity: 1',
  'filter: none',
  'backdrop-filter: none',
  'transform: none',
  'translate: none',
  'scale: none',
  'rotate: none',
  'zoom: 1',
  'clip-path: none',
  'mask: none',
  'contain: none',
  'content-visibility: visible',
  'pointer-events: auto',
  'perspective: none',
]
  .map((rule) => `${rule} !important;`)
  .join(' ')

export type VaultAppearance = {
  accentColor?: string
  baseFontSize?: number
}

/** The variable layer that goes before the theme's own CSS. */
export function bridgeCss(appearance: VaultAppearance = {}): string {
  const vault: string[] = []
  if (appearance.accentColor && /^#[\da-f]{6}$/i.test(appearance.accentColor))
    vault.push(`--color-accent: ${appearance.accentColor};`)
  if (
    typeof appearance.baseFontSize === 'number' &&
    appearance.baseFontSize >= 8 &&
    appearance.baseFontSize <= 40
  )
    vault.push(`--font-text-size: ${Math.round(appearance.baseFontSize)}px;`)
  const declare = (entries: [string, string][]) =>
    entries.map(([name, value]) => `${name}: ${value};`).join(' ')
  // For !important, any layer beats unlayered rules and the earliest layer
  // beats later ones. obsidian-guard is declared first and theme layers are
  // renamed to obsidian-theme-*, so they can't nest inside it: no theme rule,
  // !important or not, can hide the page root.
  return `@layer obsidian-guard, obsidian-compat;
@layer obsidian-guard {
html, :root { ${guard} }
html::before, html::after, :root::before, :root::after { content: none !important; display: none !important; }
}
@layer obsidian-compat {
:root { ${carried.map((token) => `--hibi-o-${token}: var(--${token});`).join(' ')} }
body { ${declare(Object.entries(OBSIDIAN_DEFAULTS))} ${vault.join(' ')} }
body { ${declare(Object.entries(HIBI_FROM_OBSIDIAN).map(([hibi, obsidian]) => [hibi, `var(${obsidian})`]))} }
${[1, 2, 3, 4, 5, 6].map((level) => `.hibi-lp-h${level} { --syntax-heading: var(--h${level}-color); }`).join('\n')}
.formatted-editor .cm-content { font-family: var(--font-text); }
}
`
}
