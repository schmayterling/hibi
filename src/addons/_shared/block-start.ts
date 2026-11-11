import { Lexer, type TokenizerThis } from 'marked'

/**
 * The line each block start looks for, at any line start: as a paragraph's
 * interruption, it also ends a quote's lazy lines and setext heading text.
 */
export const blockStartLines = new WeakMap<
  object,
  Pick<RegExp, 'test'> & { lazyItem: boolean; line: RegExp }
>()

/** A new item, heading, fence or rule ends an unindented lazy item tail. */
export const lazyItemEnd =
  /^ {0,3}(?:(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)|#{1,6}(?:[ \t]|$)|`{3,}[^`]*$|~{3,}|([-*_])[ \t]*(?:\1[ \t]*){2,}$)/

const noStarts: readonly object[] = []

/** Calls, source units read, and the largest single read, for complexity checks. */
export const blockStartCounters = { calls: 0, units: 0, max: 0 }

// Marked continues a paragraph onto the next line unless the line is empty or
// one of its paragraph rule's own interruptions matches there.
const head = '^([^\\n]+(?:\\n(?!'
const tail = ')[^\\n]+)*)'
// A gfm table interrupts once its header and delimiter rows match; its body
// is optional there, so never read it.
const table = Lexer.rules.block.gfm.table.source.slice(1)
const body = table.indexOf('(?:\\n((?:(?!')
const tableStart = body > 0 ? `${table.slice(0, body)}(?:\\n|$)` : table
function interruptions(paragraph: RegExp) {
  const { source } = paragraph
  return source.startsWith(head) && source.endsWith(tail)
    ? `|${source.slice(head.length, -tail.length).replace(table, () => tableStart)}`
    : ''
}

/**
 * Marked asks block extensions, before each top-level paragraph, where their
 * block could start in the rest of the note, and only uses the answer to end
 * that paragraph early. Look for `line` at real line starts (Marked drops the
 * first character) only until the paragraph ends, so each paragraph is read
 * once instead of the whole remaining note. Flags on `line` are ignored, as
 * they would also change Marked's interruptions; spell out letter case.
 */
export function blockStart(
  line: RegExp,
  enabled = () => true,
  lazyItem = false,
) {
  const probes = new WeakMap<RegExp, WeakMap<object, RegExp>>()
  // Other extensions' start lines also end the paragraph, so stop there too.
  const probe = (paragraph: RegExp, starts: readonly object[]) => {
    let forStarts = probes.get(paragraph)
    if (!forStarts) probes.set(paragraph, (forStarts = new WeakMap()))
    let regex = forStarts.get(starts)
    if (!regex) {
      const others = starts
        .map((other) => blockStartLines.get(other)?.line)
        .filter((other) => other && other !== line)
        .map((other) => `(?:${other!.source})`)
      regex = new RegExp(
        `\\n(?:(${line.source})|\\n${interruptions(paragraph)}${
          others.length ? `|${others.join('|')}` : ''
        })`,
      )
      forStarts.set(starts, regex)
    }
    return regex
  }
  const start = function (this: TokenizerThis | undefined, source: string) {
    const lexer = this?.lexer
    blockStartCounters.calls++
    // Outside top-level paragraphs, such as in list items, Marked ignores it.
    if (lexer?.state.top === false) return -1
    // The same rule selection as Marked's lexer.
    const { block } = Lexer.rules
    const starts = lexer?.options.extensions?.startBlock ?? noStarts
    const regex = probe(
      lexer?.options.pedantic
        ? block.pedantic.paragraph
        : lexer?.options.gfm
          ? block.gfm.paragraph
          : block.normal.paragraph,
      starts,
    )
    const match = regex.exec(source)
    const units = match ? match.index + match[0].length : source.length
    blockStartCounters.units += units
    blockStartCounters.max = Math.max(blockStartCounters.max, units)
    return match?.[1] === undefined ? -1 : match.index + 1
  }
  const boundary = new RegExp(`^(?:${line.source})`, 'm')
  blockStartLines.set(start, {
    lazyItem,
    line,
    test: (source) => enabled() && boundary.test(source),
  })
  return start
}
