import type { WorkspaceTarget } from './foundation-contracts'
import type { NoteHeading, PropertyScalar } from './note-metadata.ts'

// Per-message trust bound; note size, workspace size and result count are unrestricted.
export const WORKSPACE_TEXT_QUERY_BYTES = 256 * 1024

export type WorkspaceTextMatch = {
  readonly path: string
  /** Path matches rank before text-only matches; pages may arrive progressively. */
  readonly score: number
  readonly lines: readonly { readonly line: number; readonly text: string }[]
}

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
  /** Active Markdown projections; omitted by older direct IPC callers. */
  readonly projections?: readonly {
    readonly id: string
    readonly parserVersion: string
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
      /** Reusing an identity cancels that caller's previous search immediately. */
      readonly searchId?: string
      /** Cancel the searchId without starting another search. */
      readonly cancel?: boolean
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
        /** Current-source snippets and relevance; older hosts may omit these. */
        readonly matches?: readonly WorkspaceTextMatch[]
        readonly hasMore: boolean
        readonly nextCursor: string | null
      }
  )
