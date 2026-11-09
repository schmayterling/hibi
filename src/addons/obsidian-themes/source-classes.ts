import { syntaxHighlighting } from '@codemirror/language'
import { tagHighlighter, tags } from '@lezer/highlight'

/** Obsidian's token classes on Markdown source text, so theme selectors such as `.cm-header-1` match. */
export const obsidianTokenClasses = syntaxHighlighting(
  tagHighlighter([
    ...[
      tags.heading1,
      tags.heading2,
      tags.heading3,
      tags.heading4,
      tags.heading5,
      tags.heading6,
    ].map((tag, index) => ({
      tag,
      class: `cm-header cm-header-${index + 1}`,
    })),
    { tag: tags.heading, class: 'cm-header' },
    { tag: tags.strong, class: 'cm-strong' },
    { tag: tags.emphasis, class: 'cm-em' },
    { tag: tags.strikethrough, class: 'cm-strikethrough' },
    { tag: tags.link, class: 'cm-link' },
    { tag: tags.url, class: 'cm-url' },
    { tag: tags.quote, class: 'cm-quote' },
    { tag: tags.contentSeparator, class: 'cm-hr' },
    { tag: tags.monospace, class: 'cm-inline-code' },
    { tag: tags.processingInstruction, class: 'cm-formatting' },
  ]),
)
