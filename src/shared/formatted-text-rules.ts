import { IterMode, type SyntaxNode } from '@lezer/common'
import { decodeHTMLStrict } from 'entities'
import { alertMarker, alertType } from '../addons/markdown/alerts.ts'
import { referenceLabel } from './markdown-reference-label.ts'
import type { RenderedInput, RenderedRange } from './rendered-range.ts'

export type TextRead = (from: number, to: number) => string
export const textFeatures = new Set([
  'core.entities',
  'core.clipboard',
  'core.images',
  'core.html-blocks',
  'core.inline-html',
  'core.rule',
  'markdown.footnotes',
  'markdown.autolinks',
  'markdown.strikethrough',
  'markdown.tasks',
  'markdown.tables',
  'markdown.alerts',
  'markdown.obsidian',
  'text-extras.subscript',
  'text-extras.subtext',
  'math.inline',
  'math.block',
  'math.editing',
  'frontmatter.metadata',
  'tags.highlights',
  'block-drag.handle',
  'mermaid.blocks',
  'typst.blocks',
])

/** A reference link shape shared with the view's definition lookup. */
export function formattedReferenceLink(node: SyntaxNode, read: TextRead) {
  const marks = node.getChildren('LinkMark'),
    open = marks[0]
  const close = marks.find((mark) => read(mark.from, mark.to) === ']')
  if (
    !open ||
    !close ||
    read(open.from, open.to) !== '[' ||
    read(close.to, close.to + 1) === '('
  )
    return null
  const written = node.getChild('LinkLabel')
  const from =
    written && written.to - written.from > 2 ? written.from + 1 : open.to
  const to =
    written && written.to - written.from > 2 ? written.to - 1 : close.from
  if (to - from > 999) return null
  const text = read(from, to)
  if (!text.trim()) return null
  return { open, close, end: node.to, label: referenceLabel(text) }
}

/** Source hidden by the unrevealed inline views. The view and worker share these exact ranges. */
export function formattedMarkerRanges(
  node: SyntaxNode,
  read: TextRead,
  resolvedReference = false,
): RenderedRange[] {
  const { from, to, name } = node
  if (name === 'HeaderMark') {
    const parent = node.parent
    if (!parent?.name.startsWith('ATX')) return []
    if (from === parent.from)
      return [
        {
          from,
          to:
            to +
            (/^[ \t]$/.test(read(to, Math.min(parent.to, to + 1))) ? 1 : 0),
        },
      ]
    return [
      {
        from:
          from -
          (/^[ \t]$/.test(read(Math.max(parent.from, from - 1), from)) ? 1 : 0),
        to,
      },
    ]
  }
  if (
    name === 'EmphasisMark' ||
    name === 'StrikethroughMark' ||
    name === 'HighlightMark'
  )
    return [{ from, to }]
  if (name === 'Escape') return [{ from, to: from + 1 }]
  if (name === 'HardBreak')
    return read(from, from + 1) === '\\' ? [{ from, to: from + 1 }] : []
  if (
    name === 'Emphasis' ||
    name === 'StrongEmphasis' ||
    name === 'Strikethrough'
  ) {
    const marks = node.getChildren(
      name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark',
    )
    return marks.length === 2
      ? marks.map((mark) => ({ from: mark.from, to: mark.to }))
      : []
  }
  if (name === 'Subscript')
    return [
      { from, to: from + 1 },
      { from: to - 1, to },
    ]
  if (name === 'Subtext') return [{ from, to: from + 3 }]
  if (name === 'Highlight')
    return [
      { from, to: from + 2 },
      { from: to - 2, to },
    ]
  if (name === 'InlineCode') {
    const open = node.firstChild,
      close = node.lastChild
    return open?.name === 'CodeMark' &&
      close?.name === 'CodeMark' &&
      open.from !== close.from
      ? [
          { from: open.from, to: open.to },
          { from: close.from, to: close.to },
        ]
      : []
  }
  if (name === 'Link') {
    const marks = node.getChildren('LinkMark'),
      open = marks[0]
    const close = marks.find((mark) => read(mark.from, mark.to) === ']')
    return open &&
      close &&
      read(open.from, open.to) === '[' &&
      (read(close.to, close.to + 1) === '(' || resolvedReference)
      ? [
          { from, to: open.to },
          { from: close.from, to },
        ]
      : []
  }
  if (name === 'Autolink') {
    const url = node.getChild('URL')
    return url
      ? [
          { from, to: url.from },
          { from: url.to, to },
        ]
      : []
  }
  if (name === 'WikiLink') {
    const label = node.getChild('WikiAlias') ?? node.getChild('WikiTarget')
    return label
      ? [
          { from, to: label.from },
          { from: label.to, to },
        ]
      : []
  }
  return []
}

/** The formatted list's marker and at most four following padding units. */
export function formattedListStart(
  read: TextRead,
  marker: RenderedRange,
  end: number,
  leaf = 0,
) {
  const text = read(marker.to, Math.min(end, marker.to + 4))
  const padding = /^[ \t]{0,4}/.exec(text)![0].length
  return Math.max(leaf, marker.to + padding)
}

export function formattedAlertText(source: string) {
  const marker = alertMarker(source)
  return marker ? marker[3]?.trim() || (alertType(marker[1]) ?? 'note') : source
}

/** Atoms that change glyphs but retain their complete source span. */
export function formattedAtomText(source: string) {
  if (source.startsWith('\\') && source.length === 2) return source.slice(1)
  if (source === '\n') return ' '
  if (source === '|') return '\t'
  if (/^<br\s*\/?>$/i.test(source)) return '\n'
  if (source.startsWith('[!')) return formattedAlertText(source)
  return decodeHTMLStrict(source)
}

export type FormattedTextInput = RenderedInput & {
  lineAt: (position: number) => RenderedRange
}
export type TextEffect = RenderedRange & {
  kind: 'hide' | 'barrier' | 'atom' | 'block' | 'leaf' | 'trailing'
}

/** Link reference lines and adjoining gaps hidden by the formatted view. */
export function formattedDefinitionRange(
  node: SyntaxNode,
  read: TextRead,
  lineAt: (position: number) => RenderedRange,
) {
  const first = lineAt(node.from)
  const after = (block: SyntaxNode) => {
    let next = block.nextSibling
    while (next && !next.type.is('Block')) next = next.nextSibling
    return next
  }
  let next = after(node)
  if (!/^[ \t>]*$/.test(read(first.from, node.from))) {
    let last = node
    while (next?.name === 'LinkReference') {
      last = next
      next = after(next)
    }
    return {
      from: node.from,
      to: next?.name === 'Paragraph' ? next.from : last.to,
      item: true,
    }
  }
  if (next) return { from: first.from, to: lineAt(next.from).from - 1 }
  let previous = node.prevSibling
  while (previous && !previous.type.is('Block')) previous = previous.prevSibling
  return {
    from: previous ? lineAt(previous.to).to + 1 : first.from,
    to: lineAt(node.to).to,
  }
}

/** Conditions shared with the views that replace these nodes with widgets. */
export function formattedClosedFence(node: SyntaxNode) {
  const cursor = node.cursor(IterMode.IgnoreMounts)
  if (!cursor.firstChild() || cursor.name !== 'CodeMark') return false
  const openEnd = cursor.to
  return (
    cursor.parent() &&
    cursor.lastChild() &&
    cursor.name === 'CodeMark' &&
    cursor.from > openEnd
  )
}
export function formattedMathBlock(node: SyntaxNode) {
  return (
    node.getChildren('MathMark').length >= 2 &&
    node.getChildren('MathText').length > 0
  )
}

/** Feature-selected atomic widgets never contribute their source to formatted find. */
export function formattedAtomic(
  node: SyntaxNode,
  read: TextRead,
  features: ReadonlySet<string>,
) {
  if (node.name === 'Image')
    return features.has('core.images') && !!node.getChild('URL')
  if (node.name === 'HorizontalRule') return features.has('core.rule')
  if (
    node.name === 'InlineMath' ||
    node.name === 'InlineMathLines' ||
    node.name === 'MathInline'
  )
    return features.has('math.inline')
  if (node.name === 'BlockMath')
    return features.has('math.block') && formattedMathBlock(node)
  if (node.name === 'WikiEmbed') return features.has('markdown.obsidian')
  if (node.name !== 'FencedCode' || !formattedClosedFence(node)) return false
  const info = node.cursor(IterMode.IgnoreMounts)
  if (!info.firstChild() || !info.nextSibling() || info.name !== 'CodeInfo')
    return false
  const name = read(info.from, info.to).trim().toLowerCase()
  return !!name && features.has(name + '.blocks')
}
