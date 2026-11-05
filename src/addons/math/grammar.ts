import { Marked, type MarkedExtension } from 'marked'
import { blockStart } from '../_shared/block-start.ts'
import type { MarkdownFlavor } from '../api'
import {
  type Closers,
  formulaLimit,
  inlineDisplayMath,
  inlineMathEnd,
  literalPair,
} from './inline-display.ts'

/** Each inline section's closer search, by the token list Marked fills for it. */
const closersOf = new WeakMap<object, Closers>()

/**
 * Inline math as Obsidian reads it (./inline-display.ts), or a pair over the
 * formula limit as text, whose closer opens nothing. A `$$` reads as display
 * math first, so the second `$` of a pair opens nothing.
 */
function inlineMathOrText(source: string, tokens?: object) {
  if (source.charCodeAt(0) !== 36) return
  if (source.charCodeAt(1) === 36) return inlineDisplayMath(source)
  let closers = tokens && closersOf.get(tokens)
  if (tokens && !closers) {
    closers = { from: -1, at: -1 }
    closersOf.set(tokens, closers)
  }
  const end = inlineMathEnd(source, 0, closers)
  if (end < 0) return
  const raw = source.slice(0, end)
  if (end - 2 > formulaLimit) return literalPair(raw)
  return { type: 'inlineMath' as const, raw, latex: raw.slice(1, -1) }
}
export function inlineMath(source: string) {
  const token = inlineMathOrText(source)
  return token?.type === 'inlineMath' ? token : undefined
}
// The tokenizer handles the current line itself.
export const blockMathStart = blockStart(/ {0,3}\$\$/)
export function blockMath(source: string) {
  const match =
    /^ {0,3}\$\$[ \t]*\n?((?:\\[\s\S]|(?!\$\$)[^\\]){1,10000}?)\$\$(?:[ \t]*(?:\n|$))/.exec(
      source,
    )
  if (!match?.[1]?.trim() || match[1].length > 10000) return
  return { type: 'blockMath', raw: match[0], latex: match[1].trim() }
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
      tokenizer: inlineMathOrText,
    },
  ],
}
export const detector = new Marked(mathTokens)
export const mathFlavor: MarkdownFlavor = {
  id: 'latex',
  name: 'Math',
  kind: 'syntax',
  description: 'LaTeX math: $…$ within a line or $$…$$ in a separate block.',
  detect(source) {
    if (!source.includes('$')) return false
    let found = false
    detector.walkTokens(detector.lexer(source), (token) => {
      found ||= token.type === 'inlineMath' || token.type === 'blockMath'
    })
    return found
  },
}
