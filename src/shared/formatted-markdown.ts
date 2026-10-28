import {
  type MarkdownConfig,
  type MarkdownExtension,
  parser,
} from '@lezer/markdown'
import { protectMarkdownParser } from './markdown-flavor-guard.ts'
import { ContainerHTML } from './markdown-html-syntax.ts'

/** The same core grammar and contributed syntax in the formatted view and its worker. */
export function formattedMarkdownParser(
  contributed: readonly MarkdownConfig[],
  extensions: MarkdownExtension = [],
) {
  return protectMarkdownParser(parser, [
    { defineNodes: [{ name: 'Frontmatter', block: true }] },
    ContainerHTML,
    ...contributed,
    extensions,
  ])
}

/** The table view's inline-only grammar, shared with worker cell projection. */
export function formattedInlineParser(contributed: readonly MarkdownConfig[]) {
  const inline = protectMarkdownParser(parser, contributed)
  const blocks =
    (inline as unknown as { blockNames?: readonly string[] }).blockNames ?? []
  return inline.configure({ remove: [...blocks] })
}
