import { decodeHTML } from 'entities'
import sanitizeHtml from 'sanitize-html'
import { headingAnchors } from '../../shared/heading-anchor.ts'
import type { SitePage } from '../../site/data'

const headingTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']
const blocks = new Set([
  ...headingTags,
  'p',
  'br',
  'hr',
  'li',
  'pre',
  'blockquote',
  'div',
  'td',
  'tr',
  'section',
  'details',
  'summary',
])

/** Plain search data travels with each page, including encrypted exports. */
export function pageSearch(html: string): NonNullable<SitePage['search']> {
  const headings: { position: number; depth: number; label: string }[] = []
  let separator = false
  const boundary = (tag: string) => {
    if (blocks.has(tag)) separator = true
  }
  const content = sanitizeHtml(html, {
    allowedTags: headingTags,
    allowedAttributes: { h2: ['id'] },
    onOpenTag: boundary,
    onCloseTag: boundary,
    textFilter: (value) => {
      const prefix = separator ? ' ' : ''
      separator = false
      return prefix + value
    },
    exclusiveFilter: (frame) => {
      if (
        headingTags.includes(frame.tag) &&
        frame.attribs.id !== 'footnote-label'
      )
        headings.push({
          position: frame.tagPosition,
          depth: Number(frame.tag.slice(1)),
          label: frame.text,
        })
      return false
    },
  })
  headings.sort((left, right) => left.position - right.position)
  const anchors = headingAnchors(headings.map((heading) => heading.label))
  return {
    version: 1,
    text: decodeHTML(content.replace(/<\/?h[1-6][^>]*>/gi, ' '))
      .replace(/\s+/g, ' ')
      .trim(),
    headings: headings.flatMap((heading, index) =>
      heading.depth > 1 && heading.label.trim()
        ? [
            {
              depth: heading.depth,
              label: heading.label.trim(),
              anchor: anchors[index]!.anchor,
            },
          ]
        : [],
    ),
  }
}
