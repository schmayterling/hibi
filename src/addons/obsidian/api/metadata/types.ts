import type { NoteHeading } from '../../../../shared/note-metadata'
import type { NoteSyntax } from '../../../../shared/note-syntax'

/** Renderer-safe subset of the worker reply; no main-process imports. */
export interface MetadataFilePage {
  path: string
  version: string
  sequence: number
  syntax: {
    settings: NoteSyntax
    key: string
    unsupported: boolean
    complete: boolean
  }
  metadata: {
    references: { links: string[]; wikilinks: string[] }
    referenceComplete: boolean
    tags: readonly string[]
    headings: {
      items: readonly NoteHeading[]
      complete: boolean
      count?: number
      paged?: boolean
    }
  }
}
