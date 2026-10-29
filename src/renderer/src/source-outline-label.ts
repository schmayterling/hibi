import type { Token } from 'marked'
import { builtInFlavors } from '../../shared/built-in-grammar.ts'
import { preserveInlineHtml } from '../../shared/markdown-inline-html.ts'
import { decodeMarkdownEntities } from './markdown-entities.ts'
import { markdownSyntax } from './markdown-syntax.ts'
import type { OutlineLabelPart } from './outline-label.ts'

/** Heading text from the source parser's tokens, without an editor schema. */
export function createOutlineLabelRenderer(flavors: readonly string[]) {
  if (flavors.some((id) => !builtInFlavors.has(id))) return null
  const version = markdownSyntax.version()
  const github = flavors.includes('markdown.github')
  const extras = flavors.includes('text-extras.text-extras')
  return (
    tokens: readonly Token[],
    level: number,
  ): OutlineLabelPart[] | null => {
    if (
      version !== markdownSyntax.version() ||
      !markdownSyntax.enabled(`core.heading-${level}`)
    )
      return null
    const text: OutlineLabelPart[] = []
    const frames = [
      {
        tokens: preserveInlineHtml([...tokens])[Symbol.iterator](),
        start: 0,
        marked: false,
        html: false,
        preserveDisabled: true,
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
      if (frame.preserveDisabled && markdownSyntax.disabledFeature(token)) {
        text.push(token.raw)
        continue
      }
      if (token.type === 'html' || token.type === 'rawHtmlInline') {
        frame.html = true
        continue
      }
      if (token.type === 'inlineMath') {
        // Disabled math inside a native custom token stays textless, as in rich headings.
        if (markdownSyntax.enabled('math.inline'))
          text.push({ latex: String(token.latex ?? '') })
        continue
      }
      if (
        (token.type === 'image' && markdownSyntax.enabled('core.images')) ||
        token.type === 'br' ||
        (token.type === 'codespan' &&
          !markdownSyntax.enabled('core.inline-code'))
      )
        continue
      if (
        token.type === 'link' &&
        'autolink' in token &&
        token.autolink &&
        markdownSyntax.enabled('core.links')
      ) {
        const value = String(token.text ?? '')
        text.push(
          token.raw.startsWith('<') ? value : decodeMarkdownEntities(value),
        )
        continue
      }
      if ('tokens' in token && token.tokens) {
        frames.push({
          tokens: preserveInlineHtml([...token.tokens])[Symbol.iterator](),
          start: text.length,
          marked:
            /^(?:em|strong|link)$/.test(token.type) ||
            (github && token.type === 'del') ||
            (extras && token.type === 'subscript'),
          html: false,
          // Native custom tokens hide children from disabled-syntax preservation.
          preserveDisabled:
            frame.preserveDisabled && !(extras && token.type === 'subscript'),
        })
      } else if (token.type === 'text') {
        const value = (token.raw ?? token.text).replace(/[ \t]*\n[ \t]*/g, ' ')
        text.push(token.escaped ? value : decodeMarkdownEntities(value))
      } else if (
        'text' in token &&
        (token.type === 'escape' || token.type === 'codespan')
      )
        text.push(String(token.text ?? ''))
    }
    return version === markdownSyntax.version() ? text : null
  }
}
