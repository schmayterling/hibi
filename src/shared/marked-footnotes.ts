import { Lexer, type TokenizerExtension } from 'marked'
import { markedGithubFootnote as githubFootnotes } from 'marked-github-footnote'
import { BlockTokenizer, blockContainers } from './marked-blocks.ts'
import { leafBlock } from './marked-leaf-blocks.ts'

/** Bound definitions with Marked's list grammar before the footnote renderer stores them. */
export function markedGithubFootnote(
  ...options: Parameters<typeof githubFootnotes>
) {
  const extension = githubFootnotes(...options)
  const definition = extension.extensions!.find(
    (item) => item.name === 'footnoteDef',
  ) as TokenizerExtension
  const read = definition.tokenizer
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
    const token = read.call(this, source.slice(0, end), tokens)
    const last = token?.tokens?.at(-1)
    return token && last && !['paragraph', 'text'].includes(last.type)
      ? leafBlock(token)
      : token
  }
  return { ...extension, tokenizer: blockContainers }
}
