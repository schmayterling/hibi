import type { ChainedCommands } from '@tiptap/core'
import type { Token } from 'marked'

export type SyntaxSlashCommand = {
  /** Markdown inserted in source view. */
  markdown: string
  /** Short menu hint; defaults to the syntax description. */
  description?: string
  /** Caret offset within the inserted Markdown. Defaults to its end. */
  cursor?: number
  /** Extra slash-menu search terms. */
  keywords?: string
  /** Rich-view insertion. Omit when this syntax only supports source insertion. */
  rich?: (chain: ChainedCommands) => ChainedCommands
}

/** One renderable Markdown feature, exposed in settings → syntax. */
export type MarkdownSyntaxFeature = {
  id: string
  label: string
  group: string
  description?: string
  level: 'block' | 'inline'
  /** Match lexer tokens, including the token emitted by the export parser. */
  matches: (token: Readonly<Token>) => boolean
  scope?: 'markdown'
  /** Rich extension names to disable with this feature; keep export tokenizers registered. */
  extensions?: readonly string[]
  /** Optional insertion recipe shown by the slash-command addon while enabled. */
  slash?: SyntaxSlashCommand
}

/** Format rendering control, queried through the same syntax preferences. */
export type DocumentSyntaxFeature = Omit<
  MarkdownSyntaxFeature,
  'matches' | 'scope' | 'slash'
> & {
  scope: 'document'
  matches?: never
  slash?: never
}
