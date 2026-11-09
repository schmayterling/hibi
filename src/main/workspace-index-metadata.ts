import { createHash } from 'node:crypto'
import { isMarkdownDocument } from '../shared/document-types.ts'
import type { WorkspaceMetadataDetailSource } from '../shared/metadata-stream.ts'
import type { NoteCacheEntry } from '../shared/note-cache.ts'
import {
  noteCacheEntries,
  noteCacheParse,
} from '../shared/note-cache-parser.ts'
import {
  localTargetPath,
  noteReferences,
  wikiTargetName,
} from '../shared/note-links.ts'
import {
  type NoteHeading,
  noteHeadings,
  noteProperties,
  propertyValue,
} from '../shared/note-metadata.ts'
import { noteLexer } from '../shared/note-syntax.ts'
import { noteTags } from '../shared/note-tags.ts'
import type { WorkspacePage } from '../shared/workspace.ts'
import type { PageSyntax } from './workspace-syntax.ts'

export type WorkspacePageMetadata = {
  references: ReturnType<typeof noteReferences>
  referenceComplete: boolean
  tags: readonly string[]
  properties: { values: Record<string, readonly string[]>; complete: boolean }
  headings: ReturnType<typeof noteHeadings>
}
export type WorkspaceMetadataPage = {
  id?: string
  path: string
  version: string
  syntax: PageSyntax
  metadata: WorkspacePageMetadata
  details?: WorkspaceMetadataDetailSource
}

export const sourceIndexVersion = (source: string) =>
  createHash('sha256').update(source, 'utf16le').digest('hex')

export const propertyIndexValue = (value: unknown) =>
  sourceIndexVersion(
    `${typeof value}:${Object.is(value, -0) ? '-0' : JSON.stringify(value)}`,
  )

/** Derive everything needed by metadata queries, then release the source text. */
export function parseWorkspaceMetadata(
  page: WorkspacePage,
  syntax: PageSyntax,
  parse = noteReferences,
  onHeading?: (heading: NoteHeading) => void,
  onEntry?: (entry: NoteCacheEntry) => void,
  onDetailComplete?: (complete: boolean) => void,
): WorkspacePageMetadata {
  if (onEntry && isMarkdownDocument(page.path))
    return parsePositionedMetadata(
      page,
      syntax,
      onEntry,
      onHeading,
      onDetailComplete,
    )
  onDetailComplete?.(true)
  const markdown = isMarkdownDocument(page.path)
  const referenceComplete = true
  const lexed = markdown ? noteLexer(page.markdown, syntax.settings) : undefined
  const raw = markdown
    ? parse(page.markdown, syntax.settings, lexed)
    : { links: [], wikilinks: [] }
  const references = {
    links: raw.links.flatMap((href) => {
      const path = localTargetPath(page.path, href)
      return path === null ? [] : [path]
    }),
    wikilinks: raw.wikilinks.flatMap((target) => {
      const name = wikiTargetName(target)
      return name === null ? [] : [name]
    }),
  }
  const properties = markdown
    ? noteProperties(page.markdown, syntax.settings)
    : { values: {}, complete: true }
  const values: Record<string, readonly string[]> = Object.create(null)
  for (const [key, value] of Object.entries(properties.values))
    values[sourceIndexVersion(key)] = (
      Array.isArray(value) ? value : [value]
    ).map(propertyIndexValue)
  return {
    references,
    referenceComplete,
    tags:
      markdown && referenceComplete
        ? noteTags(page.markdown, syntax.settings, lexed)
        : [],
    properties: { values, complete: properties.complete },
    headings: markdown
      ? noteHeadings(page.markdown, syntax.settings, lexed, onHeading)
      : { items: [], complete: true },
  }
}

/** Worker projections share the existing Lezer tree and parsed YAML with details. */
function parsePositionedMetadata(
  page: WorkspacePage,
  syntax: PageSyntax,
  onEntry: (entry: NoteCacheEntry) => void,
  onHeading?: (heading: NoteHeading) => void,
  onDetailComplete?: (complete: boolean) => void,
): WorkspacePageMetadata {
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
