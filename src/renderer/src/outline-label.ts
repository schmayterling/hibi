import type { Node } from '@tiptap/pm/model'

/** Heading text, with inline formulas apart so the outline can draw them. */
export type OutlineLabelPart = string | { latex: string }

/**
 * One-line label text, where formulas read as their LaTeX, and the parts when
 * a formula is among them.
 */
export function outlineLabel(parts: readonly OutlineLabelPart[]): {
  label: string
  parts?: readonly OutlineLabelPart[]
} {
  const label =
    parts
      .map((part) => (typeof part === 'string' ? part : part.latex))
      .join('')
      .replace(/\s+/g, ' ')
      .trim() || 'Untitled heading'
  if (parts.every((part) => typeof part === 'string')) return { label }
  const joined: OutlineLabelPart[] = []
  for (const part of parts)
    if (typeof part !== 'string') joined.push(part)
    else if (typeof joined.at(-1) === 'string')
      joined[joined.length - 1] += part
    else joined.push(part)
  const last = joined.length - 1
  return {
    label,
    parts: joined.flatMap((part, index): OutlineLabelPart[] => {
      if (typeof part !== 'string') return [part]
      let text = part.replace(/\s+/g, ' ')
      if (index === 0) text = text.trimStart()
      if (index === last) text = text.trimEnd()
      return text ? [text] : []
    }),
  }
}

/** A rich heading's text as `textContent` reads it, keeping inline formulas. */
export function richHeadingLabel(heading: Node) {
  const parts: OutlineLabelPart[] = []
  heading.forEach((child) => {
    parts.push(
      child.type.name === 'inlineMath'
        ? { latex: String(child.attrs.latex ?? '') }
        : child.textContent,
    )
  })
  return outlineLabel(parts)
}
