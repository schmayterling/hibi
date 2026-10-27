// Kept apart from tab-indent.ts so settings and the CodeMirror editors never load Tiptap.
import { stored } from '../../ui/stored-preference.ts'

const indentUnits = ['\t', '  ', '    '] as const
type Preferences = { enabled: boolean; unit: (typeof indentUnits)[number] }
const key = 'hibi:tab-indent'
const preferences = stored<Preferences>(
  key,
  () => {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? '{}')
      return {
        enabled: value.enabled !== false,
        unit: indentUnits.includes(value.unit) ? value.unit : '\t',
      }
    } catch {
      return { enabled: true, unit: '\t' }
    }
  },
  JSON.stringify,
)
export const tabIndent = {
  snapshot: preferences.get,
  subscribe: preferences.subscribe,
  set(next: { enabled?: boolean; unit?: string }) {
    const current = preferences.get()
    preferences.set({
      enabled: next.enabled ?? current.enabled,
      unit: indentUnits.find((unit) => unit === next.unit) ?? current.unit,
    })
  },
}

/** Code blocks indent like an indented line among their first this many lines; later ones are not read. */
export const codeIndentLines = 1000

const indented = /\t| {2,}(?=[^ \n])/y
/** The first indented line's unit among at most `lines` lines, scanning only as far as that line. */
export function detectIndentUnit(text: string, lines = Infinity) {
  for (let at = 0, line = 1; ; line++) {
    indented.lastIndex = at
    const match = indented.exec(text)?.[0]
    if (match)
      return match === '\t' ? match : ' '.repeat(Math.min(match.length, 4))
    if (line >= lines) return undefined
    at = text.indexOf('\n', at) + 1
    if (!at) return undefined
  }
}
