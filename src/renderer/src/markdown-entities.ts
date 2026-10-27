import type {
  AnyExtension,
  JSONContent,
  MarkdownParseHelpers,
  MarkdownRendererHelpers,
  MarkdownToken,
} from '@tiptap/core'
import type { MarkdownManager } from '@tiptap/markdown'
import { decodeHTMLStrict, encodeHTML } from 'entities'
import type { Marked, Token } from 'marked'
import { blockMarkdown } from '../../shared/marked-blocks.ts'
import { preserveInlineHtml } from './RawHtml.ts'

const richParsers = new WeakSet<object>()

export function richTextParser(parser: Marked) {
  parser.use(blockMarkdown)
  const BaseLexer = parser.Lexer
  class RichLexer<
    ParserOutput = string,
    RendererOutput = string,
  > extends BaseLexer<ParserOutput, RendererOutput> {
    inlineTokens(source: string, tokens?: Token[]) {
      const result = preserveInlineHtml(super.inlineTokens(source, tokens))
      // Custom task tokens hide children from walkTokens; normalize at creation.
      for (const token of result) richTextToken(token)
      return result
    }
  }
  parser.Lexer = RichLexer
  parser.lexer = (source, options) =>
    new RichLexer(options ?? parser.defaults).lex(source)
  richParsers.add(parser)
  return parser
}

export function decodeMarkdownEntities(text: string) {
  return text.replace(
    /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]+);/g,
    (entity) => decodeHTMLStrict(entity),
  )
}

export function richTextToken(token: Token) {
  if ('tokens' in token)
    for (const child of token.tokens ?? []) richTextToken(child)
  if (token.type !== 'text' || token.tokens) return
  // Marked already decodes numeric references in text; raw avoids decoding twice.
  // The distinct token also keeps intentional nbsp out of the empty-paragraph path.
  token.type = 'hibiText'
  token.text = (token.raw ?? token.text).replace(/[ \t]*\n[ \t]*/g, ' ')
}

function encodeLineBreaks(text: string) {
  return text.replace(/[\n\r]/g, (character) => {
    const encoded = encodeHTML(character)
    return encoded === character ? `&#${character.codePointAt(0)};` : encoded
  })
}

function encodeLinkAttribute(text: string) {
  return encodeLineBreaks(text.replace(/[&<>"\\]/g, encodeHTML))
}

export function entityMarkdown(extension: AnyExtension) {
  if (extension.name === 'text')
    return extension.extend({
      markdownTokenName: 'hibiText',
      parseMarkdown: (token: MarkdownToken) => ({
        type: 'text',
        text: token.escaped
          ? (token.text ?? '')
          : decodeMarkdownEntities(token.text ?? ''),
      }),
    })
  if (extension.name === 'link')
    return extension.extend({
      parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) => {
        const literal = token.autolink && token.raw?.startsWith('<')
        return helpers.applyMark(
          'link',
          token.autolink
            ? [
                helpers.createTextNode(
                  literal
                    ? (token.text ?? '')
                    : decodeMarkdownEntities(token.text ?? ''),
                ),
              ]
            : helpers.parseInline(token.tokens ?? []),
          {
            href: literal
              ? token.href
              : decodeMarkdownEntities(token.href ?? ''),
            title: decodeMarkdownEntities(token.title ?? '') || null,
          },
        )
      },
      renderMarkdown: (node: JSONContent, helpers: MarkdownRendererHelpers) => {
        const href = encodeLinkAttribute(node.attrs?.href ?? '').replace(
          /[() \t]/g,
          (character) => (character === ' ' ? '&#32;' : encodeHTML(character)),
        )
        const title = encodeLinkAttribute(node.attrs?.title ?? '')
        const text = helpers.renderChildren(node)
        return title ? `[${text}](${href} "${title}")` : `[${text}](${href})`
      },
    })
  return extension
}

// Tiptap bypasses Text's render hook. Keep its private codec adaptation here,
// covered by full and cached serialization regressions when upgrading Tiptap.
type TextCodec = {
  encodeTextForMarkdown: (
    text: string,
    node: JSONContent,
    parent?: JSONContent,
  ) => string
  codeTypes: Set<string>
  isEmptyOutput: (source: string) => boolean
}

const textOrigins = new WeakMap<JSONContent, JSONContent>()

export function maskParagraphText(node: JSONContent, text: string) {
  const masked = { ...node, text }
  textOrigins.set(masked, node)
  return masked
}

const configured = new WeakSet<MarkdownManager>()

export function configureMarkdownEntities(manager: MarkdownManager) {
  if (configured.has(manager)) return
  configured.add(manager)
  const richText = richParsers.has(manager.instance)
  const codec = manager as unknown as TextCodec
  const encodeText = codec.encodeTextForMarkdown.bind(manager)
  codec.encodeTextForMarkdown = (text, node, parent) => {
    const encoded = encodeText(text, node, parent)
    if (
      (parent?.type && codec.codeTypes.has(parent.type)) ||
      node.marks?.some((mark) =>
        codec.codeTypes.has(typeof mark === 'string' ? mark : mark.type),
      )
    )
      return encoded
    // Native parsers retain structural soft breaks; rich parsers normalize them.
    let result = richText ? encodeLineBreaks(encoded) : encoded
    // Encode text at line edges before Tiptap trims whitespace or moves marks.
    if (parent?.type === 'paragraph' && /[\t\u00a0]/.test(result)) {
      const siblings = parent.content ?? []
      const index = siblings.indexOf(textOrigins.get(node) ?? node)
      const encode = (space: string) => space.replace(/[\t\u00a0]/g, encodeHTML)
      if (index === 0 || siblings[index - 1]?.type === 'hardBreak') {
        // The shared paragraph guard already protects unmarked indentation.
        const leading =
          index === 0 && !node.marks?.length ? /\u00a0/g : /[\t\u00a0]/g
        result = result.replace(/^[ \t\u00a0]+/, (space) =>
          space.replace(leading, encodeHTML),
        )
      }
      if (
        index >= 0 &&
        (index === siblings.length - 1 ||
          siblings[index + 1]?.type === 'hardBreak')
      )
        result = result.replace(/[ \t\u00a0]+$/, encode)
    }
    return result
  }
  // Empty paragraphs already use blank lines; an intentional nbsp is content.
  codec.isEmptyOutput = (source) => /^[ \t\r\n]*$/.test(source)
}
