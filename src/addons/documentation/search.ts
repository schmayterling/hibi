import { decodeHTML } from 'entities'
import sanitizeHtml from 'sanitize-html'
import { headingAnchors } from '../../shared/heading-anchor.ts'
import type { SitePage } from '../../site/data'

const text = (html: string) =>
  decodeHTML(
    sanitizeHtml(html, {
      allowedTags: [],
      allowedAttributes: {},
    }),
  )

/** Plain search data travels with each page, including encrypted exports. */
export function pageSearch(html: string): NonNullable<SitePage['search']> {
  const headings = [...html.matchAll(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi)]
    .filter(
      ([, , attributes = '']) => !/\bid="footnote-label"/.test(attributes),
    )
    .map(([, depth = '1', , body = '']) => ({
      depth: Number(depth),
      label: text(body),
    }))
  const anchors = headingAnchors(headings.map((heading) => heading.label))
  return {
    version: 1,
    text: text(
      html.replace(
        /<(?:br|hr)\b[^>]*>|<\/(?:p|h[1-6]|li|pre|blockquote|div|td|tr|section|details|summary)>/gi,
        '$& ',
      ),
    )
      .replace(/\s+/g, ' ')
      .trim(),
    headings: headings.flatMap((heading, index) =>
      heading.depth > 1 && heading.label.trim()
        ? [
            {
              ...heading,
              label: heading.label.trim(),
              anchor: anchors[index]!.anchor,
            },
          ]
        : [],
    ),
  }
}
