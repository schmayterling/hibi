import type {
  Lexer,
  Token,
  Tokenizer,
  TokenizerExtension,
  Tokens,
} from 'marked'

type BlockToken = { type: string; raw: string }

// Symbol keys survive tokenizer wrappers that copy results.
const leaf = Symbol('leaf block')
const quote = Symbol('quote text')
const lazy = Symbol('lazy reader')
type Custom = Tokens.Generic & {
  [leaf]?: true
  [quote]?: string
  [lazy]?: (source: string) => Token | undefined
}
// The last lazily continued block each lexer presented to a container read.
const lazyBlocks = new WeakMap<Lexer, Custom>()
const quoteReaders = new WeakSet<TokenizerExtension['tokenizer']>()
const active = new WeakMap<Lexer, Map<Token, { type: string; text: unknown }>>()

// Tokens checked for native identity, a deterministic complexity check.
export const leafBlockCounters = { visits: 0 }

function nativeIdentity<T extends Token>(token: T, lexer: Lexer): T {
  leafBlockCounters.visits++
  const types = active.get(lexer)
  if (!types || types.has(token)) return token
  const custom = token as Custom
  if (custom[leaf] || custom[quote] !== undefined) {
    types.set(token, { type: token.type, text: custom.text })
    token.type = custom[leaf] ? 'code' : 'blockquote'
    if (custom[quote] !== undefined) custom.text = custom[quote]
  } else if (custom[lazy]) {
    // Quotes re-read a trailing list with their lazy lines appended.
    types.set(token, { type: token.type, text: custom.text })
    token.type = 'list'
    lazyBlocks.set(lexer, custom)
  }
  return token
}

/** A custom block whose last paragraph continues lazily, re-read from `read`. */
export function lazyBlock<T extends BlockToken>(
  token: T,
  read: (source: string) => T | undefined,
): T {
  return Object.assign(token, { [lazy]: read })
}

/** A container's re-read of the last lazy custom block with lines appended. */
export const lazyContinuation = (lexer: Lexer, source: string) =>
  lazyBlocks.get(lexer)?.[lazy]?.(source)

/** Preserve the quote text Marked needs when it re-reads a nested continuation. */
export function quoteBlock<T extends BlockToken>(
  token: T,
  text: string | object,
): T {
  return Object.assign(token, {
    [quote]: typeof text === 'string' ? text : (text as Custom)[quote],
  })
}

/** Reapply a quote extension after Marked re-reads a nested quote itself. */
export function quoteReader(
  read: TokenizerExtension['tokenizer'],
  original = read,
) {
  if (read !== original && !quoteReaders.has(original)) return read
  const guarded: typeof read = function (...args) {
    const top = this.lexer.state.top
    try {
      return read.apply(this, args)
    } finally {
      this.lexer.state.top = top
    }
  }
  quoteReaders.add(guarded)
  return guarded
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

/** Whether a custom block ends paragraph continuation. */
export const isLeafBlock = (token: Token) => !!(token as Custom)[leaf]

/** A complete custom block cannot take lazy paragraph continuation. */
export function leafBlock<T extends BlockToken>(token: T): T {
  return Object.assign(token, { [leaf]: true as const })
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
    // Quotes re-read each lazy line into the same list; earlier tokens are done.
    const from = (args[1] as Token[] | undefined)?.length ?? 0
    const tokens = Reflect.apply(blockTokens, lexer, args)
    for (let index = from; index < tokens.length; index++)
      nativeIdentity(tokens[index]!, lexer)
    return tokens
  }
  try {
    const token = read()
    if (lexer.inlineQueue.length > inlineStart) {
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
      if ((token as Custom)[quote] !== undefined) (token as Custom).text = text
    }
    active.delete(lexer)
    lazyBlocks.delete(lexer)
  }
}

function endsWithLeaf(token: Token): boolean {
  if ((token as Custom)[leaf]) return true
  const last =
    token.type === 'list' && 'items' in token
      ? (token as Tokens.List).items
          .at(-1)
          ?.tokens.findLast((child) => child.type !== 'space')
      : undefined
  return !!last && endsWithLeaf(last)
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
      if (!endsWithLeaf(token)) continue
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
      // Marked removes the item indent from its own lines but keeps lazy ones.
      const stop = item.text.indexOf('\n', next)
      if (
        !line.trim() ||
        item.text.slice(next, stop < 0 ? undefined : stop) !== line
      )
        continue
      // Marked's fence and heading checks on the item line before a lazy one.
      const last = item.text.slice(
        item.text.lastIndexOf('\n', next - 2) + 1,
        next - 1,
      )
      const spaces = /^ */.exec(last)![0].length
      if (
        spaces <= Math.min(3, indents[index]! - base - 1) &&
        !/^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(last.slice(spaces))
      )
        return rawFrom
    }
    itemFrom += item.raw.length
  }
  return source.length
}
