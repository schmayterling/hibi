/** UTF-16 units a formula may have, as in ./grammar.ts. */
export const formulaLimit = 10_000

/**
 * How far past its opener a closing `$$` is looked for. A pair found within
 * it pairs even past the formula limit and then stays text whole, so its
 * closer opens nothing; giant paragraphs read their seams this far ahead.
 *
 * ponytail: only a paragraph over the giant block size can hold a pair this
 * long. Its opener then pairs nothing, so the later pairs of that paragraph
 * pair one off; Obsidian pairs it at any distance. Whether a `$$` closes
 * depends on every opener before it in the paragraph, so matching that needs
 * windows to read seams from openers past this limit, and an edit inside
 * such a pair to read again from its opener.
 */
export const pairLimit = 65_536

/** Positions the math scans examined, for complexity tests. */
export const inlineMathWork = { positions: 0 }

/** How far a text's closer search got, by distance from its end, so later openers reuse it. */
export type Closers = { from: number; at: number }

/**
 * Whether the `$` at `at` can close inline math, wherever it opened before.
 * `lineStart` tells where a line's content starts inside quotes and lists,
 * whose markers Obsidian strips.
 */
function closes(text: string, at: number, lineStart?: (at: number) => boolean) {
  const before = text.charCodeAt(at - 1),
    after = text.charCodeAt(at + 1)
  if (after >= 48 && after <= 57) return false
  if ((before === 32 || before === 9) && !lineStart?.(at)) return false
  // A backslash pairs with the next unit, so an odd run escapes this dollar.
  let slashes = 0
  while (text.charCodeAt(at - 1 - slashes) === 92) slashes++
  return slashes % 2 === 0
}

/**
 * The end of inline math opened by the `$` at `open`, or -1, as Obsidian
 * 1.13.7 reads it: the formula starts with neither a space nor a tab, and
 * the first `$` outside a backslash pair closes it unless a space or tab
 * comes before that `$` or a digit after it. The formula can span the lines
 * of its paragraph and end right before another `$`; one over the formula
 * limit ends there too and stays text. `closers`, kept for one text whose
 * openers are read in order, finds each closer once.
 */
export function inlineMathEnd(
  text: string,
  open: number,
  closers?: Closers,
  lineStart?: (at: number) => boolean,
) {
  const first = text.charCodeAt(open + 1)
  if (open + 1 >= text.length || first === 36 || first === 32 || first === 9)
    return -1
  // The first unit is not a dollar, so the closer comes after it.
  const from = open + 2,
    length = text.length
  let at = -1
  if (
    closers &&
    length - closers.from <= from &&
    (closers.at < 0 || length - closers.at >= from)
  )
    at = closers.at < 0 ? -1 : length - closers.at
  else {
    for (
      let i = text.indexOf('$', from);
      i >= 0;
      i = text.indexOf('$', i + 1)
    ) {
      inlineMathWork.positions++
      if (closes(text, i, lineStart)) {
        at = i
        break
      }
    }
    if (closers) {
      closers.from = length - from
      closers.at = at < 0 ? -1 : length - at
    }
  }
  return at < 0 || at - open > pairLimit ? -1 : at + 1
}

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
  const last = Math.min(end - 2, open + 2 + pairLimit)
  for (let at = open + 2; at <= last; at++) {
    inlineMathWork.positions++
    const code = text.charCodeAt(at)
    if (code === 92) at++
    else if (code === 36 && text.charCodeAt(at + 1) === 36) return at + 2
  }
  return -1
}

/** A pair over the formula limit, delimiters included, as text. */
export const literalPair = (raw: string) => ({
  type: 'text' as const,
  raw,
  text: raw,
})

/**
 * `$$…$$` inside a line, which Obsidian draws as display math there. The rich
 * editor keeps the raw token as text; formatted views and exports render it.
 */
export function inlineDisplayMath(source: string) {
  const end = source.startsWith('$$') ? inlineDisplayMathEnd(source, 0) : -1
  if (end < 0) return
  const raw = source.slice(0, end)
  if (end - 4 > formulaLimit) return literalPair(raw)
  return {
    type: 'inlineMath' as const,
    raw,
    latex: source.slice(2, end - 2).trim(),
    display: true,
  }
}
