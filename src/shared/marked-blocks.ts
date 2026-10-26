import { type MarkedExtension, Tokenizer } from 'marked'

// Keep each parser's start, interruption and underline grammar, but replace its
// per-character (.|newline)+? backtracking with an iterative line scan.
// The delimiters describe the installed Marked rules; equivalence tests guard them.
const setextRules = new WeakMap<
  RegExp,
  { start: RegExp; interrupt: RegExp; underline: RegExp }
>()

export const blockMarkdown: MarkedExtension = {
  tokenizer: {
    lheading(source) {
      return BlockTokenizer.prototype.lheading.call(
        this,
        source,
        Object.getPrototypeOf(this).lheading,
      )
    },
  },
}

export class BlockTokenizer extends Tokenizer {
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
        interrupt: new RegExp(`^(?:${interrupt})`),
        underline: new RegExp(`^${underline}`),
      }
      setextRules.set(pattern, rule)
    }
    if (!rule.start.test(source)) return
    let from = 0
    for (;;) {
      const end = source.indexOf('\n', from)
      if (end < 0) return
      // A dot in the original text capture excludes these line terminators.
      if (/[\r\u2028\u2029]/.test(source.slice(from, end))) return
      const rest = source.slice(end + 1)
      const underline = rule.underline.exec(rest)
      if (end > 0 && underline) {
        // Let the upstream tokenizer retain its own raw/newline behavior.
        const match = Object.assign(
          [
            source.slice(0, end + 1 + underline[0].length),
            source.slice(0, end),
            underline[1],
          ] as [string, string, string],
          { index: 0, input: source },
        )
        const heading = /(?:)/
        heading.exec = () => match
        const rules = this.rules
        this.rules = {
          ...rules,
          block: { ...rules.block, lheading: heading },
        }
        try {
          return read.call(this, source)
        } finally {
          this.rules = rules
        }
      }
      if (rule.interrupt.test(rest)) return
      from = end + 1
    }
  }
}
