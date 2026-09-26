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
  readonly syntaxSnapshot?: WorkspaceSyntaxSnapshot
}

/** Renderer-owned Markdown settings captured with each workspace query. */
export type WorkspaceSyntaxSnapshot = {
  readonly version: 1
  readonly flavorRevision: number
  readonly featureRevision: number
  readonly flavors: readonly {
    readonly id: string
    readonly kind: 'dialect' | 'syntax'
    readonly parserVersion: string
  }[]
  readonly features: readonly {
    readonly id: string
    readonly enabled: boolean
  }[]
  readonly choices: readonly {
    readonly id: string
    readonly dialect: string
    readonly syntax: 'auto' | readonly string[]
  }[]
  readonly hashtags: boolean
  /** False when renderer could not read every saved file choice. */
  readonly complete: boolean
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
  | (QueryTarget & QueryPage & { readonly kind: 'tags' })
  | (QueryTarget &
      QueryPage & { readonly kind: 'search-tags'; readonly query: string })
  | (QueryTarget & {
      readonly kind: 'graph'
      readonly cursor?: string
      readonly limit?: number
    })
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
  /** Built-in syntax understood by the index; file settings may disable parts. */
  readonly syntax: 'gfm+wikilinks+hashtags'
  /** True when the host captured each file's active flavor and syntax settings. */
  readonly flavorAware: boolean
  /** Selected addon syntax outside the main-process parser needs a richer parser. */
  readonly unsupportedSyntax: boolean
  readonly sequence: number
  readonly stale: boolean
  readonly complete: boolean
  readonly capReached: boolean
}

export type WorkspaceGraphItem =
  | { readonly kind: 'node'; readonly path: string }
  | { readonly kind: 'edge'; readonly source: string; readonly target: string }

export interface WorkspaceTagSummary {
  readonly tag: string
  readonly count: number
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
        readonly kind: 'tags' | 'search-tags'
        readonly items: readonly WorkspaceTagSummary[]
        readonly hasMore: boolean
        readonly nextOffset: number
      }
    | {
        readonly kind: 'graph'
        readonly items: readonly WorkspaceGraphItem[]
        readonly hasMore: boolean
        readonly nextCursor: string | null
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
