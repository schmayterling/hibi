import { InlineMath } from '@tiptap/extension-mathematics'
import { Strike } from '@tiptap/extension-strike'
import type { Token } from 'marked'
import type { MarkdownFlavor } from '../../addons/api.ts'
import {
  ObsidianHighlight,
  WikiEmbed,
  WikiLink,
} from '../../addons/markdown/obsidian.ts'
import { Subscript } from '../../addons/text-extras/nodes.ts'
import type { MarkdownReferenceSyntax } from '../../shared/document-worker-protocol.ts'
import { markdownSourceParser } from '../../shared/markdown-source-references.ts'
import { createMarkdownSemantics } from './markdown-semantics.ts'
import { markdownSyntax } from './markdown-syntax.ts'
import { preserveInlineHtml } from './RawHtml.ts'
import {
  readSourceOutlineLabel,
  type SourceOutlineLabelRequest,
  type SourceOutlineLabelResult,
} from './source-outline.ts'

export type OutlineLabelConfig = {
  syntax: MarkdownReferenceSyntax
  flavors: readonly string[]
  disabled: readonly string[]
}
export type OutlineLabelReply =
  | { result: SourceOutlineLabelResult }
  | { error: string }

// Built-in inline tokenizers start fresh arrays. Replay a parent after its child
// is cached, including the child's lexer state, instead of nesting JS calls.
function stackSafeLabels(parser: ReturnType<typeof markdownSourceParser>) {
  type State = typeof parser.Lexer.prototype.state
  type Frame = { source: string; state: State; key: string }
  const BaseLexer = parser.Lexer
  class LabelLexer<
    ParserOutput = string,
    RendererOutput = string,
  > extends BaseLexer<ParserOutput, RendererOutput> {
    readonly #cache = new Map<string, { tokens: Token[]; state: State }>()
    readonly #suspend = Symbol('nested label')
    #active = false
    #pending: Frame | null = null
    override inlineTokens(source: string): Token[] {
      const key = `${JSON.stringify(this.state)}:${source}`,
        frame = { source, key, state: { ...this.state } }
      if (this.#active) {
        const cached = this.#cache.get(key)
        if (cached) {
          Object.assign(this.state, cached.state)
          return cached.tokens
        }
        this.#pending = frame
        throw this.#suspend
      }
      this.#active = true
      const frames = [frame]
      let result: Token[] = []
      try {
        for (let current = frames.at(-1); current; current = frames.at(-1)) {
          this.state = { ...current.state }
          try {
            result = super.inlineTokens(current.source)
            this.#cache.set(current.key, {
              tokens: result,
              state: { ...this.state },
            })
            frames.pop()
          } catch (error) {
            if (error !== this.#suspend || !this.#pending) throw error
            frames.push(this.#pending)
            this.#pending = null
          }
        }
        return result
      } finally {
        this.#active = false
        this.#pending = null
        this.#cache.clear()
      }
    }
  }
  parser.Lexer = LabelLexer
}

// Nested enabled marks cannot change heading text. Keep the outer mark so
// native HTML preservation still applies, and flatten its nested formatting.
// Group each original HTML scope first; disabled marks retain their raw text.
function labelTokens(tokens: readonly Token[]) {
  const result: Token[] = [],
    stack = [
      {
        input: preserveInlineHtml([...tokens])[Symbol.iterator](),
        output: result,
        marked: false,
      },
    ]
  for (;;) {
    const entry = stack.at(-1)
    if (!entry) return result
    const step = entry.input.next()
    if (step.done) {
      stack.pop()
      continue
    }
    const token = step.value
    if ('tokens' in token && token.tokens) {
      // Disabled syntax renders raw text; enabled images are textless atoms.
      if (markdownSyntax.disabledFeature(token) || token.type === 'image') {
        entry.output.push({ ...token, tokens: [] })
        continue
      }
      const children: Token[] = [],
        mark = /^(?:em|strong|del|subscript)$/.test(token.type),
        flatten = mark && entry.marked
      if (!flatten) entry.output.push({ ...token, tokens: children })
      stack.push({
        input: preserveInlineHtml(token.tokens)[Symbol.iterator](),
        output: flatten ? entry.output : children,
        marked: entry.marked || mark,
      })
    } else entry.output.push(token)
  }
}

/** Only inline extensions can contribute content to a heading. Use native converters. */
export function createOutlineLabelReader(config: OutlineLabelConfig) {
  for (const [owner, id, token, extension] of [
    ['markdown', 'strike', 'del', 'strike'],
    ['text-extras', 'subscript', 'subscript', 'subscript'],
    ['math', 'inline', 'inlineMath', 'inlineMath'],
  ] as const) {
    if (
      !markdownSyntax
        .snapshot()
        .some((feature) => feature.id === `${owner}.${id}`)
    )
      markdownSyntax.register(owner, {
        id,
        label: id,
        group: 'Text',
        level: 'inline',
        extensions: [extension],
        matches: (value) => value.type === token,
      })
  }
  for (const feature of markdownSyntax.snapshot())
    markdownSyntax.setEnabled(feature.id, !config.disabled.includes(feature.id))
  const flavors: MarkdownFlavor[] = config.flavors.map((id) => ({
    id,
    name: id,
    kind: 'syntax',
    description: '',
    detect: () => true,
    markedOptions: { gfm: config.syntax.gfm },
    richExtensions:
      id === 'markdown.github'
        ? [Strike]
        : id === 'text-extras.text-extras'
          ? [Subscript]
          : id === 'math.latex'
            ? [InlineMath]
            : id === 'markdown.obsidian'
              ? [WikiEmbed, WikiLink, ObsidianHighlight]
              : [],
  }))
  const semantics = createMarkdownSemantics(flavors, 0)
  if (!semantics) throw new Error('Unsupported source outline label syntax.')
  const parser = markdownSourceParser(config.syntax)
  stackSafeLabels(parser)
  return (request: SourceOutlineLabelRequest) =>
    readSourceOutlineLabel(
      request,
      parser,
      (tokens, level) =>
        semantics.read(
          [
            {
              type: 'heading',
              raw: '',
              text: '',
              depth: level,
              tokens: labelTokens(tokens),
            },
          ],
          { before: false, after: false },
        )?.headings[0]?.label ?? null,
    )
}

if (typeof self !== 'undefined') {
  let read: ReturnType<typeof createOutlineLabelReader> | undefined
  self.onmessage = (
    event: MessageEvent<
      OutlineLabelConfig & { request: SourceOutlineLabelRequest }
    >,
  ) => {
    try {
      read ??= createOutlineLabelReader(event.data)
      self.postMessage({
        result: read(event.data.request),
      } satisfies OutlineLabelReply)
    } catch (error) {
      self.postMessage({
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      } satisfies OutlineLabelReply)
    }
  }
}
