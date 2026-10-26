import {
  frontmatterEnd,
  readFrontmatter as splitFrontmatter,
} from '../../shared/frontmatter.ts'
import type { AddonNoteReader, MarkdownProjection } from '../api'

export { splitFrontmatter }

export function addFrontmatter(source: string): string {
  if (parseFrontmatter(source)) return source
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : ''
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  return `${bom}---${eol}{}${eol}---${eol}${eol}${source.slice(bom.length)}`
}

/** Whether a note starts with frontmatter, read only up to its closing line. */
export function hasFrontmatter(note: AddonNoteReader) {
  const end = frontmatterEnd(note)
  return end >= 0 && !!splitFrontmatter(note.slice(0, end))
}

export function replaceFrontmatter(source: string, yaml: string): string {
  const block = splitFrontmatter(source)
  if (!block) return source
  const normalized = yaml.replace(/\r\n|\r|\n/g, block.eol)
  return (
    block.opening +
    normalized +
    (normalized && !normalized.endsWith(block.eol) ? block.eol : '') +
    block.closing +
    block.content
  )
}

export function parseFrontmatter(source: string): MarkdownProjection | null {
  const block = splitFrontmatter(source)
  if (!block) return null
  return {
    content: block.content,
    sourceOffset: block.prefix.length,
    serialize: (content) =>
      block.prefix +
      (content && !block.prefix.endsWith('\n') ? block.eol : '') +
      content,
  }
}
