import { createHash } from 'node:crypto'
import { isMarkdownDocument } from '../shared/document-types.ts'
import {
  localTargetPath,
  noteReferences,
  wikiTargetName,
} from '../shared/note-links.ts'
import {
  type NoteHeading,
  noteHeadings,
  noteProperties,
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
): WorkspacePageMetadata {
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
