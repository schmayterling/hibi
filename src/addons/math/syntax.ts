import { Marked, type MarkedExtension } from 'marked'
import { blockStart } from '../_shared/block-start.ts'
import type { MarkdownFlavor, MarkdownParagraphRule } from '../api'

export function inlineMath(source: string) {
  const match = /^\$(?!\$)((?:\\.|[^$\n])+?)\$(?!\$)/.exec(source)
  const latex = match?.[1]
  if (!match || !latex || latex.length > 10000 || latex.trim() !== latex) return
  return { type: 'inlineMath', raw: match[0], latex }
}
// The tokenizer handles the current line itself.
export const blockMathStart = blockStart(/ {0,3}\$\$/)
export function blockMath(source: string) {
  const match =
    /^ {0,3}\$\$[ \t]*\n?((?:\\[\s\S]|(?!\$\$)[^\\])+?)\$\$(?:[ \t]*(?:\n|$))/.exec(
      source,
    )
  if (!match?.[1]?.trim() || match[1].length > 10000) return
  return { type: 'blockMath', raw: match[0], latex: match[1].trim() }
}
export const mathParagraphRule: MarkdownParagraphRule = {
  characters: '$',
  escape(source, { literals, parentType }) {
    const marker = [...literals].find(([, value]) => value === '$')?.[0]
    if (!marker || !source.includes(marker)) return source
    // Added escapes can expose another match; each pass consumes a marker.
    const limit = source.split(marker).length - 1
    for (let pass = 0; pass < limit; pass++) {
      const dollars = new Set<number>()
      const restored = source.replaceAll(marker, (_, index) => {
        dollars.add(index - dollars.size * (marker.length - 1))
        return '$'
      })
      const escaped = new Set<number>()
      let lineStart = 0
      for (let index = 0; index < restored.length; index++) {
        if (restored[index] === '\n') lineStart = index + 1
        if (restored[index] !== '$') continue
        const block =
          parentType !== 'table' &&
          index - lineStart <= 3 &&
          /^ *$/.test(restored.slice(lineStart, index))
            ? blockMath(restored.slice(index))
            : undefined
        const token = block ?? inlineMath(restored.slice(index))
        if (token)
          for (let at = index; at < index + token.raw.length; at++)
            if (dollars.has(at)) escaped.add(at)
        // A literal dollar beside an equation delimiter can prevent its parsing.
        if (
          dollars.has(index) &&
          ((restored[index - 1] === '$' && !dollars.has(index - 1)) ||
            (restored[index + 1] === '$' && !dollars.has(index + 1)))
        )
          escaped.add(index)
      }
      if (!escaped.size) break
      let occurrence = 0
      source = source.replaceAll(marker, (_, index) =>
        escaped.has(index - occurrence++ * (marker.length - 1))
          ? '\\$'
          : marker,
      )
    }
    return source
  },
}

export const mathTokens: MarkedExtension = {
  extensions: [
    {
      name: 'blockMath',
      level: 'block',
      start: blockMathStart,
      tokenizer: blockMath,
    },
    {
      name: 'inlineMath',
      level: 'inline',
      start: (source) => source.indexOf('$'),
      tokenizer: inlineMath,
    },
  ],
}
export const detector = new Marked(mathTokens)
export const mathFlavor: MarkdownFlavor = {
  id: 'latex',
  name: 'Math',
  kind: 'syntax',
  description: 'LaTeX math: $…$ within a line or $$…$$ in a separate block.',
  paragraphRules: [mathParagraphRule],
  detect(source) {
    if (!source.includes('$')) return false
    let found = false
    detector.walkTokens(detector.lexer(source), (token) => {
      found ||= token.type === 'inlineMath' || token.type === 'blockMath'
    })
    return found
  },
}
