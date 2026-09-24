import {
  getSchema,
  getText,
  getTextSerializersFromSchema,
  type JSONContent,
} from '@tiptap/core'
import {
  type MarkdownExtensionOptions,
  MarkdownManager,
} from '@tiptap/markdown'
import type { MarkedOptions, Token, TokensList } from 'marked'
import type { MarkdownFlavor } from '../../addons/api'
import { contextualTokens } from '../../shared/markdown-semantic-tokens.ts'
import { documentImage } from './DocumentImage.ts'
import { markdownConfiguration } from './markdown.ts'
import { markdownSyntax } from './markdown-syntax.ts'

export type MarkdownSemantics = Readonly<{
  json: JSONContent
  text: string
  blockCount: number
  /** Positions are local to this region's schema document, never source offsets. */
  headings: readonly { position: number; label: string; level: number }[]
}>

/** Native conversion only. Callers must supply an available semantic-token region;
 * unsupported reference markup and projections retain their compatibility path. */
export function createMarkdownSemantics(
  flavors: readonly MarkdownFlavor[],
  revision: number,
) {
  if (
    flavors.some(
      (flavor) =>
        ![
          'markdown.github',
          'markdown.obsidian',
          'github-markdown.github',
          'text-extras.text-extras',
          'math.latex',
        ].includes(flavor.id),
    )
  )
    return null
  const version = markdownSyntax.version()
  const { parser, options, core, addons } = markdownConfiguration(flavors)
  const extensions = [
    ...core,
    ...addons,
    ...(markdownSyntax.enabled('core.images') ? [documentImage(revision)] : []),
  ]
  const schema = getSchema(extensions)
  const textSerializers = getTextSerializersFromSchema(schema)
  const manager = new MarkdownManager({
    marked: parser as unknown as NonNullable<
      MarkdownExtensionOptions['marked']
    >,
    markedOptions: options,
    extensions,
  })
  const unsupportedInline = Symbol('native inline tokenization')
  const BaseLexer = parser.Lexer
  let pending: Token[] | null = null
  parser.lexer = () => {
    throw unsupportedInline
  }
  class SemanticLexer<
    ParserOutput = string,
    RendererOutput = string,
  > extends BaseLexer<ParserOutput, RendererOutput> {
    constructor(options?: MarkedOptions<ParserOutput, RendererOutput>) {
      // Marked normally stores its tokenizer on the supplied options object.
      super({ ...options, tokenizer: null })
    }
    override lex() {
      if (!pending) throw new Error('No semantic tokens are being consumed.')
      return pending as TokensList
    }
    override inlineTokens(): Token[] {
      // A new native parse request would lack the worker's document context.
      throw unsupportedInline
    }
  }
  parser.Lexer = SemanticLexer
  return {
    read(
      tokens: readonly Token[],
      context: { before: boolean; after: boolean },
    ): MarkdownSemantics | null {
      if (version !== markdownSyntax.version()) return null
      if (pending)
        throw new Error('Semantic tokens are already being consumed.')
      pending = contextualTokens(
        structuredClone(tokens),
        context.before,
        context.after,
      )
      try {
        if (parser.defaults.walkTokens)
          parser.walkTokens(pending, parser.defaults.walkTokens)
        const nested: unknown[] = [pending]
        while (nested.length) {
          const value = nested.pop()
          if (!value || typeof value !== 'object') continue
          if (Array.isArray(value)) {
            for (const child of value) nested.push(child)
            continue
          }
          const token = value as Token
          if (
            token.type === 'html' &&
            (typeof window === 'undefined' || !window.DOMParser)
          )
            return null
          if (token.type === 'taskList' && !schema.nodes.taskList) return null
          // Native TaskList has its own lexical grammar; plain Marked lists
          // would silently become ordinary bullets without that tokenizer.
          if (
            token.type === 'list' &&
            token.items?.some(
              (item: Token) =>
                ('task' in item && item.task) ||
                /^\s*[-+*]\s+\[[ xX]\]\s+/.test(item.raw),
            )
          )
            return null
          // Custom native tokens store children in items/nestedTokens, outside
          // Marked's walkTokens traversal. Include those in compatibility checks.
          for (const child of Object.values(value))
            if (child && typeof child === 'object') nested.push(child)
        }
        const json = manager.parse('')
        const document = schema.nodeFromJSON(json)
        const headings: MarkdownSemantics['headings'][number][] = []
        document.descendants((node, position) => {
          if (node.type.name === 'heading')
            headings.push({
              position,
              label: node.textContent || 'Untitled heading',
              level: Number(node.attrs.level),
            })
        })
        if (version !== markdownSyntax.version()) return null
        return {
          json,
          text: getText(document, { blockSeparator: '\n', textSerializers }),
          blockCount: document.childCount,
          headings,
        }
      } catch (error) {
        if (error === unsupportedInline) return null
        throw error
      } finally {
        pending = null
      }
    },
  }
}
