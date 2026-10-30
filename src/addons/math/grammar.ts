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

/** The rich editor's inline math: within a line, before no `$`, without spaces at its ends. */
export function richInlineMath(source: string) {
  const match = /^\$(?!\$)((?:\\.|[^$\n])+?)\$(?!\$)/.exec(source)
  const latex = match?.[1]
  if (!match || !latex || latex.length > formulaLimit || latex.trim() !== latex)
    return
  return { type: 'inlineMath' as const, raw: match[0], latex }
}

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
/**
 * The length of the `$` run at `at` when it opens display math on its line,
 * which ends at `end`, or 0. As Obsidian 1.13.7 reads block math: two or
 * more `$`, and no other `$` on the line.
 */
export function blockMathRun(text: string, at: number, end = text.length) {
  let run = at
  while (text.charCodeAt(run) === 36) run++
  const other = text.indexOf('$', run)
  return run - at >= 2 && (other < 0 || other >= end) ? run - at : 0
}

/**
 * Where the `$` run closing display math that `size` signs opened starts on
 * the line `from`-`to`, or -1: the line ends, apart from spaces, in at least
 * `size` `$` and holds no other `$`. A backslash before them escapes nothing.
 */
export function blockMathClose(
  text: string,
  from: number,
  to: number,
  size: number,
) {
  let end = to
  // A carriage return ends a line as Obsidian reads it.
  while (end > from && / |\r/.test(text.charAt(end - 1))) end--
  let run = end
  while (run > from && text.charCodeAt(run - 1) === 36) run--
  return end - run >= size && text.indexOf('$', from) === run ? run : -1
}

// The tokenizer handles the current line itself.
export const blockMathStart = blockStart(/ {0,3}\${2,}[^$\n]*\n/)
/**
 * A display block as Obsidian 1.13.7 reads it: a `$$` line opens it when a
 * line follows in its quote, list item or note, and it runs to its closing
 * line (blockMathClose) or, without one, to the end of them.
 * Opening with more `$` needs as many to close. A formula over the limit
 * stays text whole, so its lines open nothing.
 */
export function blockMath(source: string) {
  const open = /^ {0,3}(\${2,}) *([^$\n]*)\n/.exec(source)
  if (!open) return
  const [line, run = '', rest = ''] = open
  const size = run.length
  const lines = [rest]
  let raw = source
  for (let at = line.length; at < source.length; ) {
    let end = source.indexOf('\n', at)
    if (end < 0) end = source.length
    const close = blockMathClose(source, at, end, size)
    lines.push(source.slice(at, close < 0 ? end : close))
    if (close >= 0) {
      raw = source.slice(0, end + 1)
      break
    }
    at = end + 1
  }
  const body = lines.join('\n')
  if (body.length > formulaLimit)
    return { type: 'blockMathText', raw, tokens: [literalPair(raw.trimEnd())] }
  return { type: 'blockMath', raw, latex: body.trim() }
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
    {
      // A display block over the formula limit, which blockMath keeps as text.
      name: 'blockMathText',
      renderer(token) {
        return `<p>${this.parser.parseInline(token.tokens ?? [])}</p>\n`
      },
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
