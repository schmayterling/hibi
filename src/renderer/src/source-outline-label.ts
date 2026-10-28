import type { Token } from 'marked'
import { builtInFlavors } from '../../shared/built-in-grammar.ts'
import { preserveInlineHtml } from '../../shared/markdown-inline-html.ts'
import { decodeMarkdownEntities } from './markdown-entities.ts'
import { markdownSyntax } from './markdown-syntax.ts'

/** Heading text from the source parser's tokens, without an editor schema. */
export function createOutlineLabelRenderer(flavors: readonly string[]) {
  if (flavors.some((id) => !builtInFlavors.has(id))) return null
  const version = markdownSyntax.version()
  const github = flavors.includes('markdown.github')
  const extras = flavors.includes('text-extras.text-extras')
  const obsidian = flavors.includes('markdown.obsidian')
  return (tokens: readonly Token[], level: number): string | null => {
    if (
      version !== markdownSyntax.version() ||
      !markdownSyntax.enabled(`core.heading-${level}`)
    )
      return null
    const text: string[] = []
    const frames = [
      {
        tokens: preserveInlineHtml([...tokens])[Symbol.iterator](),
        start: 0,
        marked: false,
        html: false,
      },
    ]
    for (;;) {
      const frame = frames.at(-1)
      if (!frame) break
      const step = frame.tokens.next()
      if (step.done) {
        frames.pop()
        // Native marks containing preserved HTML become textless HTML atoms.
        if (frame.marked && frame.html) text.length = frame.start
        const parent = frames.at(-1)
        if (parent && frame.html) parent.html = true
        continue
      }
      const token = step.value
      if (markdownSyntax.disabledFeature(token)) {
        text.push(token.raw)
        continue
      }
      if (/^(?:html|rawHtmlInline|rawHtmlBlock)$/.test(token.type)) {
        frame.html = true
        continue
      }
      if (
        /^(?:image|inlineMath|br)$/.test(token.type) ||
        (obsidian && token.type === 'obsidianEmbed')
      )
        continue
      if ('tokens' in token && token.tokens) {
        frames.push({
          tokens: preserveInlineHtml([...token.tokens])[Symbol.iterator](),
          start: text.length,
          marked:
            /^(?:em|strong|link)$/.test(token.type) ||
            (github && token.type === 'del') ||
            (extras && token.type === 'subscript') ||
            (obsidian &&
              /^(?:obsidianHighlight|obsidianWikiLink)$/.test(token.type)),
          html: false,
        })
      } else if (token.type === 'text' || token.type === 'hibiText') {
        const value = (token.raw ?? token.text).replace(/[ \t]*\n[ \t]*/g, ' ')
        text.push(token.escaped ? value : decodeMarkdownEntities(value))
      } else if (
        /^(?:escape|codespan|hibiLiteralInline|hibiLiteralBlock)$/.test(
          token.type,
        )
      )
        text.push(String(token.text ?? ''))
    }
    return version === markdownSyntax.version()
      ? text.join('') || 'Untitled heading'
      : null
  }
}
