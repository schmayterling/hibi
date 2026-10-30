import type { MarkedExtension } from 'marked'

/** UTF-16 units a formula may have, as in ./grammar.ts. */
const formulaLimit = 10_000

/** Positions the math scans examined, for complexity tests. */
export const inlineMathWork = { positions: 0 }

/**
 * The end of display math opened by the `$$` at `open` inside a line, or -1.
 * As in Obsidian 1.13.7, the first `$$` outside a backslash pair closes it,
 * also on a later line of its paragraph. The formula between can hold `$`
 * signs or be blank.
 */
export function inlineDisplayMathEnd(
  text: string,
  open: number,
  end = text.length,
) {
  const last = Math.min(end - 2, open + 2 + formulaLimit)
  for (let at = open + 2; at <= last; at++) {
    inlineMathWork.positions++
    const code = text.charCodeAt(at)
    if (code === 92) at++
    else if (code === 36 && text.charCodeAt(at + 1) === 36) return at + 2
  }
  return -1
}

/**
 * `$$…$$` inside a line, which Obsidian draws as display math there. The rich
 * editor keeps the raw token as text; formatted views and exports render it.
 */
export function inlineDisplayMath(source: string) {
  const end = source.startsWith('$$') ? inlineDisplayMathEnd(source, 0) : -1
  if (end < 0) return
  return {
    type: 'inlineMath',
    raw: source.slice(0, end),
    latex: source.slice(2, end - 2).trim(),
    display: true,
  }
}

export const inlineDisplayMathTokens: MarkedExtension = {
  extensions: [
    {
      name: 'inlineDisplayMath',
      level: 'inline',
      start: (source) => source.indexOf('$$'),
      tokenizer: inlineDisplayMath,
    },
  ],
}
