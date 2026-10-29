import type {
  Lexer,
  Token,
  Tokenizer,
  TokenizerExtension,
  Tokens,
} from 'marked'

type BlockToken = { type: string; raw: string }

const leaves = new WeakSet<object>()
const quotes = new WeakMap<object, string>()
const quoteReaders = new WeakSet<TokenizerExtension['tokenizer']>()
const active = new WeakMap<Lexer, Map<Token, { type: string; text: unknown }>>()

function nativeIdentity<T extends Token>(token: T, lexer: Lexer): T {
  const types = active.get(lexer)
  if (!types || types.has(token)) return token
  if (leaves.has(token) || quotes.has(token)) {
    const custom = token as Tokens.Generic
    types.set(token, { type: token.type, text: custom.text })
    token.type = leaves.has(token) ? 'code' : 'blockquote'
    if (quotes.has(token)) custom.text = quotes.get(token)!
  }
  return token
}

/** Preserve the quote text Marked needs when it re-reads a nested continuation. */
export function quoteBlock<T extends BlockToken>(
  token: T,
  text: string | object,
): T {
  quotes.set(token, typeof text === 'string' ? text : quotes.get(text)!)
  return token
}

/** Reapply a quote extension after Marked re-reads a nested quote itself. */
export function quoteReader(read: TokenizerExtension['tokenizer']) {
  quoteReaders.add(read)
  return read
}

export function extendQuote(
  token: Tokens.Blockquote,
  lexer: Lexer,
): Tokens.Blockquote {
  for (const read of lexer.options.extensions?.block ?? [])
    if (quoteReaders.has(read)) {
      const custom = read.call({ lexer }, token.raw, [])
      if (custom) return nativeIdentity(custom, lexer) as Tokens.Blockquote
    }
  return token
}

/** A complete custom block cannot take lazy paragraph continuation. */
export function leafBlock<T extends BlockToken>(token: T): T {
  leaves.add(token)
  return token
}

/** Let Marked see native leaf identity while it decides container boundaries. */
export function withLeafBlocks<T>(tokenizer: Tokenizer, read: () => T): T {
  const lexer = tokenizer.lexer
  if (active.has(lexer)) return read()
  const types = new Map<Token, { type: string; text: unknown }>()
  active.set(lexer, types)
  const blockTokens = lexer.blockTokens
  const inlineStart = lexer.inlineQueue.length
  lexer.blockTokens = (...args) => {
    const tokens = Reflect.apply(blockTokens, lexer, args)
    for (const token of tokens) nativeIdentity(token, lexer)
    return tokens
  }
  try {
    const token = read()
    if (types.size) {
      // Native quote/list re-reads leave queued inline work for discarded tokens.
      const reachable = new Set<object>()
      const pending: unknown[] = [token]
      while (pending.length) {
        const value = pending.pop()
        if (!value || typeof value !== 'object' || reachable.has(value))
          continue
        reachable.add(value)
        if (Array.isArray(value)) {
          for (const child of value) pending.push(child)
        } else {
          const node = value as Tokens.Generic
          const type = types.get(node)?.type ?? node.type
          for (const key of [
            'tokens',
            'items',
            'header',
            'rows',
            ...(lexer.options.extensions?.childTokens?.[type] ?? []),
          ])
            pending.push(node[key])
        }
      }
      for (const work of lexer.inlineQueue.splice(inlineStart))
        if (reachable.has(work.tokens)) lexer.inlineQueue.push(work)
    }
    return token
  } finally {
    lexer.blockTokens = blockTokens
    for (const [token, { type, text }] of types) {
      token.type = type
      if (quotes.has(token)) (token as Tokens.Generic).text = text
    }
    active.delete(lexer)
  }
}

/** A list's unindented continuation must follow a paragraph, not a custom leaf. */
export function leafListEnd(
  list: Tokens.List,
  source: string,
  indents: readonly number[],
  base: number,
) {
  let itemFrom = 0
  for (const [index, item] of list.items.entries()) {
    itemFrom = source.indexOf(item.raw, itemFrom)
    let textEnd = 0,
      textAt = 0,
      rawFrom = itemFrom
    for (const token of item.tokens) {
      textEnd += token.raw.length
      if (!leaves.has(token)) continue
      const next =
        item.text[textEnd - 1] === '\n'
          ? textEnd
          : item.text.indexOf('\n', textEnd) + 1
      if (!next || next >= item.text.length) continue
      for (; textAt < next; textAt++)
        if (item.text[textAt] === '\n')
          rawFrom = source.indexOf('\n', rawFrom) + 1
      const end = source.indexOf('\n', rawFrom)
      const line = source.slice(rawFrom, end < 0 ? undefined : end)
      let column = base
      for (const char of line) {
        if (char === ' ') column++
        else if (char === '\t') column += 4 - (column % 4)
        else break
      }
      if (line.trim() && column < indents[index]!) return rawFrom
    }
    itemFrom += item.raw.length
  }
  return source.length
}
