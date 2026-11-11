import type { Lexer, Token, TokenizerExtensionFunction } from 'marked'

/** Cache each next candidate within the token array owning an inline run. */
export function inlineStart(marker: string, read: TokenizerExtensionFunction) {
  const runs = new WeakMap<Lexer, Token[]>()
  const candidates = new WeakMap<Token[], number>()
  return {
    start(this: { lexer: Lexer }, source: string) {
      const tokens = runs.get(this.lexer)!
      let remaining = candidates.get(tokens)
      if (remaining === undefined || source.length < remaining) {
        const next = source.indexOf(marker)
        remaining = next < 0 ? -1 : source.length - next
        candidates.set(tokens, remaining)
      }
      return remaining < 0 ? -1 : source.length - remaining
    },
    tokenizer(this: { lexer: Lexer }, source: string, tokens: Token[]) {
      // Every hint follows these tokenizers, including after nested inline reads.
      runs.set(this.lexer, tokens)
      return read.call(this, source, tokens)
    },
  }
}
