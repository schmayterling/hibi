import type { MarkedExtension } from 'marked'

/**
 * `$$…$$` inside a line, which Obsidian draws as display math there. The rich
 * editor keeps the raw token as text; formatted views and exports render it.
 */
export function inlineDisplayMath(source: string) {
  const match = /^\$\$((?:\\.|[^\\$\n])+?)\$\$/.exec(source)
  const body = match?.[1]
  if (!match || !body?.trim() || body.length > 10000) return
  return {
    type: 'inlineMath',
    raw: match[0],
    latex: body.trim(),
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
