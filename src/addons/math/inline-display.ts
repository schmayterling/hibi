import type { MarkedExtension } from 'marked'

/**
 * `$$…$$` inside a line, which Obsidian draws as display math there. The rich
 * editor reads such a line as text, and its parser shares the math export
 * tokenizers, so only the source and formatted views' parsers read this.
 */
export function inlineDisplayMath(source: string) {
  const match = /^\$\$((?:\\.|[^\\$\n])+?)\$\$(?!\$)/.exec(source)
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
