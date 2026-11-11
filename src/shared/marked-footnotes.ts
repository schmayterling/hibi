import {
  type Hooks,
  Lexer,
  type Token,
  type TokenizerExtension,
  type Tokens,
  type TokensList,
} from 'marked'
import { markedGithubFootnote as githubFootnotes } from 'marked-github-footnote'
import { blockStart } from '../addons/_shared/block-start.ts'
import {
  BlockTokenizer,
  blockContainers,
  continuationTokens,
  quoteColumns,
} from './marked-blocks.ts'
import {
  footnoteLabel,
  footnoteReference,
  rememberFootnote,
} from './marked-footnote-reference.ts'
import { inlineStart } from './marked-inline-start.ts'
import { lazyBlock, leafBlock } from './marked-leaf-blocks.ts'

const definitionStart = blockStart(/ {0,3}\[\^[^\]\s]+\]:/)

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
      if (!match) return
      // The dependency matches lowercased labels; give it GFM's folded label.
      const token = readReference.call(
        this,
        `[^${footnoteLabel(match.label)}]`,
        tokens,
      )
      if (token) token.raw = match.raw
      return token
    }),
  )
  const definition = extension.extensions!.find(
    (item) => item.name === 'footnoteDef',
  ) as TokenizerExtension
  // As in GFM, a definition line ends a paragraph and a quote's lazy lines.
  definition.start = definitionStart
  const readDefinition = definition.tokenizer
  // The dependency keeps the first definition it reads for each label, even
  // one read by a container pass that was later discarded.
  // Reset with the dependency's own state in preprocess, so Marked.lexer()
  // retains it between documents exactly as the dependency does.
  let stored = new Map<string, Tokens.Generic>()
  const read: typeof readDefinition = function (source, tokens) {
    // The body's block read leaves the lexer at top level; a list item's
    // following lines must still read as tight text.
    const top = this.lexer.state.top
    const [, open = '', label = ''] =
      /^( {0,3}\[\^)([^\]\s]+)\]/.exec(source) ?? []
    const folded = open
      ? open + footnoteLabel(label) + source.slice(open.length + label.length)
      : source
    let token: ReturnType<typeof readDefinition>
    try {
      token = readDefinition.call(this, folded, tokens)
    } finally {
      this.lexer.state.top = top
    }
    if (token) {
      // Keep the written label and text; only the dependency's key is folded.
      token.raw = source.slice(
        0,
        token.raw.length - folded.length + source.length,
      )
      token.label = label
      rememberFootnote(this.lexer, label)
      const key = footnoteLabel(label)
      if (!stored.has(key)) stored.set(key, token)
    }
    return token
  }
  // An empty body has no paragraph to continue, so it takes no lazy lines.
  const empty = (token: ReturnType<typeof read>) =>
    token && !token.tokens?.length ? leafBlock(token) : token
  definition.tokenizer = function (source, tokens) {
    const marker = /^ {0,3}\[\^[^\]\s]+\]:[ \t]*/.exec(source)
    if (!marker) return
    let body = source.slice(marker[0].length)
    if (!body) return empty(read.call(this, source, tokens))
    const next = /\n {0,3}\[\^[^\]\s]+\]:/.exec(body)
    if (next) body = body.slice(0, next.index)
    // After an empty first line no paragraph is open, so a line indented less
    // than four columns cannot continue the definition lazily.
    const first = body.startsWith('\n') && /\n([ \t]*)\S/.exec(body)
    if (first && first[1]!.replace(/\t/g, '    ').length < 4)
      return empty(
        read.call(
          this,
          source.slice(0, marker[0].length + first.index),
          tokens,
        ),
      )
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
      return empty(read.call(this, source, tokens))
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
    if (!token || !last) return empty(token)
    if (!['paragraph', 'text'].includes(last.type)) return leafBlock(token)
    // A quote's lazy line continues this definition's last paragraph.
    return lazyBlock(token, (more) => definition.tokenizer.call(this, more, []))
  }
  const readHere = definition.tokenizer
  // In a quote, tabs keep the columns they have in the note, as for code.
  definition.tokenizer = function (source, tokens) {
    const tokenizer = this.lexer.options.tokenizer
    // A definition ends before the next definition line: normalize only that.
    const next =
      tokenizer &&
      /^ {0,3}\[\^[^\]\s]+\]:/.test(source) &&
      /\n {0,3}\[\^[^\]\s]+\]:|$/.exec(source)!
    const columns =
      tokenizer && next && quoteColumns(tokenizer, source, 8, next.index)
    if (!columns) return readHere.call(this, source, tokens)
    const token = readHere.call(this, columns.text, tokens)
    if (token) token.raw = columns.raw(token.raw.length)
    return token
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
            const key = footnoteLabel(String(token.label))
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
