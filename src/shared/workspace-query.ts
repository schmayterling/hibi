import type { WorkspaceTarget } from './foundation-contracts'
import type { NoteHeading, PropertyScalar } from './note-metadata.ts'

export type QueryFailure =
  | 'stale'
  | 'not-found'
  | 'limit-exceeded'
  | 'unsupported'

interface QueryPage {
  readonly offset?: number
  readonly limit?: number
}

interface QueryTarget {
  readonly target: WorkspaceTarget
}

export type WorkspaceReferenceQueryRequest =
  | (QueryTarget &
      QueryPage & {
        readonly kind: 'links' | 'backlinks' | 'headings'
        readonly path: string
      })
  | (QueryTarget & {
      readonly kind: 'resolve'
      readonly path: string
      readonly href: string
      readonly syntax: 'markdown' | 'wiki'
    })
  | (QueryTarget & QueryPage & { readonly kind: 'tag'; readonly tag: string })
  | (QueryTarget &
      QueryPage & {
        readonly kind: 'property'
        readonly key: string
        readonly value: PropertyScalar
      })
  | (QueryTarget &
      QueryPage & { readonly kind: 'search-paths'; readonly query: string })
  | (QueryTarget & {
      readonly kind: 'search-text'
      readonly query: string
      readonly cursor?: string
      readonly limit?: number
    })

export interface WorkspaceReferenceQueryBase {
  readonly target: WorkspaceTarget
  /** Source index includes wiki links and hashtags regardless of preview flavor choice. */
  readonly syntax: 'gfm+wikilinks+hashtags'
  readonly sequence: number
  readonly stale: boolean
  readonly complete: boolean
  readonly capReached: boolean
}

export type WorkspaceReferenceQueryResult = WorkspaceReferenceQueryBase &
  (
    | {
        readonly kind: 'links' | 'backlinks'
        readonly path: string
        readonly items: readonly string[]
        readonly hasMore: boolean
        readonly nextOffset: number
      }
    | {
        readonly kind: 'tag' | 'search-paths' | 'property'
        readonly items: readonly string[]
        readonly hasMore: boolean
        readonly nextOffset: number
        readonly metadataComplete?: boolean
      }
    | {
        readonly kind: 'headings'
        readonly path: string
        readonly items: readonly NoteHeading[]
        readonly hasMore: boolean
        readonly nextOffset: number
      }
    | {
        readonly kind: 'resolve'
        readonly from: string
        readonly resolved: string | null
      }
    | {
        readonly kind: 'search-text'
        readonly items: readonly string[]
        readonly hasMore: boolean
        readonly nextCursor: string | null
      }
  )
