import {
  type Hooks,
  Lexer,
  type Token,
  type TokenizerExtension,
  type Tokens,
  type TokensList,
} from 'marked'
import { markedGithubFootnote as githubFootnotes } from 'marked-github-footnote'
import {
  BlockTokenizer,
  blockContainers,
  continuationTokens,
} from './marked-blocks.ts'
import {
  footnoteReference,
  rememberFootnote,
} from './marked-footnote-reference.ts'
import { inlineStart } from './marked-inline-start.ts'
import { leafBlock } from './marked-leaf-blocks.ts'

/** Bound definitions with Marked's list grammar before the footnote renderer stores them. */
export function markedGithubFootnote(
  ...options: Parameters<typeof githubFootnotes>
) {
  const extension = githubFootnotes(...options)
  const reference = extension.extensions!.find(
    (item) => item.name === 'footnoteRef',
  ) as TokenizerExtension
  const readReference = reference.tokenizer
  Object.assign(
    reference,
    inlineStart('[^', function (source, tokens) {
      const match = footnoteReference(this.lexer, source, tokens)
      if (match) return readReference.call(this, match.raw, tokens)
    }),
  )
  const definition = extension.extensions!.find(
    (item) => item.name === 'footnoteDef',
  ) as TokenizerExtension
  const readDefinition = definition.tokenizer
  // The dependency keeps the first definition it reads for each label, even
  // one read by a container pass that was later discarded.
  // Reset with the dependency's own state in preprocess, so Marked.lexer()
  // retains it between documents exactly as the dependency does.
  let stored = new Map<string, Tokens.Generic>()
  const read: typeof readDefinition = function (source, tokens) {
    const token = readDefinition.call(this, source, tokens)
    if (token) {
      rememberFootnote(this.lexer, String(token.label))
      const key = String(token.label).toLowerCase()
      if (!stored.has(key)) stored.set(key, token)
    }
    return token
  }
  definition.tokenizer = function (source, tokens) {
    const marker = /^ {0,3}\[\^[^\]\s]+\]:[ \t]*/.exec(source)
    if (!marker) return
    let body = source.slice(marker[0].length)
    if (!body) return read.call(this, source, tokens)
    const next = /\n {0,3}\[\^[^\]\s]+\]:/.exec(body)
    if (next) body = body.slice(0, next.index)
    // An empty first line still needs a four-column continuation indent.
    const prefix = '-   ' + (body.startsWith('\n') ? '\u200b' : '')
    const tokenizer = new BlockTokenizer()
    const extensions = this.lexer.options.extensions
    new Lexer({
      ...this.lexer.options,
      tokenizer,
      extensions: extensions
        ? {
            ...extensions,
            inline: [],
            startInline: [],
            block: (extensions.block ?? []).filter(
              (item) => item !== definition.tokenizer,
            ),
          }
        : null,
    })
    const item = tokenizer.list(prefix + body)?.items[0]
    if (!item || item.raw.length < prefix.length)
      return read.call(this, source, tokens)
    const end = marker[0].length + item.raw.length - prefix.length
    const physical = source.slice(0, end)
    const lexer = this.lexer,
      blockTokens = lexer.blockTokens
    // The dependency dedents before parsing; retain which lines were lazy.
    lexer.blockTokens = (...args) => {
      lexer.blockTokens = blockTokens
      return continuationTokens(lexer, source, args[0], () =>
        Reflect.apply(lexer.blockTokens, lexer, args),
      )
    }
    let token: ReturnType<typeof read>
    try {
      token = read.call(this, physical, tokens)
    } finally {
      lexer.blockTokens = blockTokens
    }
    const last = token?.tokens?.at(-1)
    return token && last && !['paragraph', 'text'].includes(last.type)
      ? leafBlock(token)
      : token
  }
  const hooks = extension.hooks!
  return {
    ...extension,
    hooks: {
      ...hooks,
      preprocess(this: Hooks, markdown: string) {
        stored = new Map()
        return hooks.preprocess!.call(this, markdown)
      },
      processAllTokens(this: Hooks, tokens: Token[] | TokensList) {
        // A discarded definition gets the content of the first one the document
        // kept, in the dependency's order: nested definitions are read first.
        const children = this.options.extensions?.childTokens
        const first = new Map<string, Token>()
        const visit = (list: unknown) => {
          if (!Array.isArray(list)) return
          for (const token of list as Tokens.Generic[]) {
            for (const key of [
              'tokens',
              'items',
              ...(children?.[token.type] ?? []),
            ])
              visit(token[key])
            if (token.type !== 'footnoteDef') continue
            const key = String(token.label).toLowerCase()
            if (!first.has(key)) first.set(key, token)
          }
        }
        if (stored.size) visit(tokens)
        for (const [key, token] of stored) {
          const final = first.get(key)
          if (final && final !== token) Object.assign(token, final)
        }
        return hooks.processAllTokens!.call(this, tokens)
      },
    },
    tokenizer: blockContainers,
  }
}
