import { type MarkedExtension, marked, Tokenizer } from 'marked'

// Keep each parser's block grammar, but scan lines without a backtracking frame
// per character or continuation line. Equivalence tests guard the rule delimiters.
const setextRules = new WeakMap<RegExp, { start: RegExp; candidate: RegExp }>()
const paragraphRules = new WeakMap<RegExp, RegExp>()

// Candidate calls and source spans, including title interruption windows.
export const blockScanCounters = { calls: 0, units: 0 }

const tableTokenizer = new Tokenizer()
const tableLexer = new marked.Lexer({ gfm: true, tokenizer: tableTokenizer })
// Boundary validation only needs cell counts, so retain no pending inline work.
tableLexer.inline = () => []

function paragraphRule(pattern: RegExp) {
  let interrupt = paragraphRules.get(pattern)
  if (!interrupt) {
    const start = '^([^\\n]+(?:\\n(?!'
    const tail = ')[^\\n]+)*)'
    if (!pattern.source.startsWith(start) || !pattern.source.endsWith(tail))
      return
    interrupt = new RegExp(
      `^(?:${pattern.source.slice(start.length, -tail.length)})`,
    )
    paragraphRules.set(pattern, interrupt)
  }
  return interrupt
}

/** Reference titles cannot cross CommonMark paragraph boundaries. */
export function endsReferenceTitle(
  source: string,
  paragraph = marked.Lexer.rules.block.normal.paragraph,
) {
  blockScanCounters.calls++
  blockScanCounters.units += source.length
  if (
    /^[ \t]*(?:\r?\n|$)/.test(source) ||
    /^ {0,3}(?:=+|-+)[ \t]*(?:\r?\n|$)/.test(source)
  )
    return true
  if (!paragraphRule(paragraph)?.test(source)) return false
  if (
    paragraph !== marked.Lexer.rules.block.gfm.paragraph ||
    paragraphRule(marked.Lexer.rules.block.normal.paragraph)?.test(source)
  )
    return true
  // The GFM paragraph rule only finds table candidates; cell counts must agree.
  const end = source.indexOf('\n', source.indexOf('\n') + 1)
  return !!tableTokenizer.table(end < 0 ? source : source.slice(0, end))
}

export function lexMarkdown(source: string) {
  return marked.lexer(source, {
    ...marked.defaults,
    tokenizer: new BlockTokenizer(),
  })
}

export function parseMarkdown(source: string) {
  return marked.parse(source, {
    async: false,
    tokenizer: new BlockTokenizer(),
  })
}

export const blockMarkdown: MarkedExtension = {
  tokenizer: {
    def(source) {
      return BlockTokenizer.prototype.def.call(
        this,
        source,
        Object.getPrototypeOf(this).def,
      )
    },
    lheading(source) {
      return BlockTokenizer.prototype.lheading.call(
        this,
        source,
        Object.getPrototypeOf(this).lheading,
      )
    },
    paragraph(source) {
      return BlockTokenizer.prototype.paragraph.call(
        this,
        source,
        Object.getPrototypeOf(this).paragraph,
      )
    },
  },
}

// Let upstream construct tokens, including its version-specific newline behavior.
function blockToken<Result>(
  tokenizer: Tokenizer,
  name: 'lheading' | 'paragraph',
  source: string,
  parts: [string, ...string[]],
  read: (source: string) => Result,
): Result {
  const match = Object.assign(parts, { index: 0, input: source })
  const rule = /(?:)/
  rule.exec = () => match
  const rules = tokenizer.rules
  tokenizer.rules = {
    ...rules,
    block: { ...rules.block, [name]: rule },
  }
  try {
    return read.call(tokenizer, source)
  } finally {
    tokenizer.rules = rules
  }
}

export class BlockTokenizer extends Tokenizer {
  override def(source: string, read = Tokenizer.prototype.def) {
    const token = read.call(this, source)
    if (!token?.title) return token
    const title = this.rules.block.def.exec(token.raw)?.[3]
    if (!title) return token
    const from = token.raw.lastIndexOf(title)
    for (
      let end = title.indexOf('\n');
      end >= 0;
      end = title.indexOf('\n', end + 1)
    ) {
      // Interruptions need at most this line and the next (a table header and
      // its delimiter row); a longer window rescans the rest of the title.
      const next = title.indexOf('\n', end + 1)
      const window = next < 0 ? -1 : title.indexOf('\n', next + 1)
      if (
        endsReferenceTitle(
          title.slice(end + 1, window < 0 ? undefined : window),
          this.rules.block.paragraph,
        )
      )
        // A failed next-line title can leave a destination-only definition.
        return read.call(this, source.slice(0, from + end))
    }
    return token
  }

  override lheading(source: string, read = Tokenizer.prototype.lheading) {
    const pattern = this.rules.block.lheading
    let rule = setextRules.get(pattern)
    if (!rule) {
      const [start, body] = pattern.source.split('((?:.|\\n(?!')
      if (!start || !body) return read.call(this, source)
      const [interrupt, underline] = body.split('))+?)\\n')
      if (!interrupt || !underline) return read.call(this, source)
      rule = {
        start: new RegExp(start),
        candidate: new RegExp(`\\n(?:(${underline})|${interrupt})`),
      }
      setextRules.set(pattern, rule)
    }
    if (!rule.start.test(source)) return
    // Stop at the first underline or interruption without a frame per character.
    blockScanCounters.calls++
    const candidate = rule.candidate.exec(source)
    blockScanCounters.units += candidate
      ? candidate.index + candidate[0].length
      : source.length
    if (!candidate?.[1] || !candidate.index) return
    blockScanCounters.units += candidate.index
    if (/[\r\u2028\u2029]/.test(source.slice(0, candidate.index))) return
    return blockToken(
      this,
      'lheading',
      source,
      [
        source.slice(0, candidate.index + candidate[0].length),
        source.slice(0, candidate.index),
        candidate[2] as string,
      ],
      read,
    )
  }

  override paragraph(source: string, read = Tokenizer.prototype.paragraph) {
    let end = source.indexOf('\n')
    // One physical line needs no repeated continuation match.
    if (end < 0) return read.call(this, source)
    if (!end) return
    const firstLine = end
    const interrupt = paragraphRule(this.rules.block.paragraph)
    if (!interrupt) return read.call(this, source)
    while (end < source.length) {
      const from = end + 1
      if (
        from === source.length ||
        source.charCodeAt(from) === 10 ||
        interrupt.test(source.slice(from))
      )
        break
      const newline = source.indexOf('\n', from)
      end = newline < 0 ? source.length : newline
    }
    if (end === firstLine) return read.call(this, source)
    const text = source.slice(0, end)
    return blockToken(this, 'paragraph', source, [text, text], read)
  }
}
