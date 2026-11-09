import { isMarkdownDocument } from '../shared/document-types.ts'
import type { NoteCacheEntry } from '../shared/note-cache.ts'
import {
  noteCacheEntries,
  noteCacheParse,
} from '../shared/note-cache-parser.ts'
import { localTargetPath, wikiTargetName } from '../shared/note-links.ts'
import { type NoteHeading, propertyValue } from '../shared/note-metadata.ts'
import type { WorkspacePage } from '../shared/workspace.ts'
import {
  parseWorkspaceMetadata,
  propertyIndexValue,
  sourceIndexVersion,
  type WorkspacePageMetadata,
} from './workspace-index-metadata.ts'
import type { PageSyntax } from './workspace-syntax.ts'

/** Worker projections share the existing Lezer tree and parsed YAML with details. */
export function parsePositionedMetadata(
  page: WorkspacePage,
  syntax: PageSyntax,
  onEntry: (entry: NoteCacheEntry) => void,
  onHeading?: (heading: NoteHeading) => void,
  onDetailComplete?: (complete: boolean) => void,
): WorkspacePageMetadata {
  if (!isMarkdownDocument(page.path)) {
    onDetailComplete?.(true)
    return parseWorkspaceMetadata(page, syntax, undefined, onHeading)
  }
  const parsed = noteCacheParse(page.markdown, syntax.settings)
  const links: string[] = []
  const wikilinks: string[] = []
  const tags = new Set<string>()
  const values: Record<string, readonly string[]> = Object.create(null)
  const headings: NoteHeading[] = []
  let count = 0
  for (const entry of noteCacheEntries(
    page.markdown,
    syntax.settings,
    parsed,
  )) {
    onEntry(entry)
    if (entry.kind === 'heading') {
      count++
      if (onHeading) onHeading(entry.value)
      else headings.push(entry.value)
    } else if (entry.kind === 'link' || entry.kind === 'embed') {
      const wiki = /^!?\[\[/.test(entry.value.original)
      // Markdown images are not note-reference predicates; wiki embeds are.
      if (wiki) {
        const name = wikiTargetName(entry.value.link)
        if (name !== null) wikilinks.push(name)
      } else if (entry.kind === 'link') {
        const path = localTargetPath(page.path, entry.value.link)
        if (path !== null) links.push(path)
      }
    } else if (entry.kind === 'tag') {
      tags.add(entry.value.tag.replace(/^#/, '').normalize('NFC').toLowerCase())
    } else if (entry.kind === 'frontmatter') {
      for (const [key, value] of Object.entries(entry.value.values)) {
        const flat = propertyValue(value)
        if (flat !== undefined)
          values[sourceIndexVersion(key)] = (
            Array.isArray(flat) ? flat : [flat]
          ).map(propertyIndexValue)
      }
    }
  }
  onDetailComplete?.(
    parsed.flags.frontmatter &&
      parsed.flags.references &&
      parsed.flags.headings,
  )
  return {
    references: { links, wikilinks },
    referenceComplete: parsed.flags.references,
    tags: [...tags].sort(),
    properties: { values, complete: parsed.flags.properties },
    headings: {
      items: headings,
      complete: parsed.flags.headings,
      ...(onHeading ? { count, paged: true } : {}),
    },
  }
}
