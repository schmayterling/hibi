import type { Token } from 'marked'
import type { BoundaryRecord } from './chunked-markdown.ts'
import type { BoundaryConfig } from './markdown-boundary-syntax.ts'

export type BoundaryPage = {
  type: 'boundaries'
  epoch: string
  id: number
  version: number
  key: string
  sequence: number
  length: number
  from?: number
  /** End of the repaired range; the suffix after it is unchanged from baseVersion. */
  to?: number
  records: BoundaryRecord[]
  done: boolean
}
export type BoundaryReceive = (
  page: BoundaryPage,
  acknowledge: () => void,
) => void

import type { SourceOwnerPage } from './markdown-source-model.ts'
import type { SourceOperation } from './source-operations.ts'
import type { ReferenceValue } from './source-references.ts'
import type { SearchLocation } from './source-search-index.ts'
import type {
  SourceTransferChunk,
  SourceTransferHead,
  SourceTransferRequest,
} from './source-transfer.ts'

export type MetadataDialect = 'commonmark' | 'gfm'
export type MarkdownReferenceSyntax = Readonly<{
  gfm: boolean
  alerts: boolean
  textExtras: boolean
  math?: boolean
}>
export type MarkdownReferenceRequest = MarkdownReferenceSyntax & {
  label: string
}
export type MarkdownSemanticRow = Readonly<{
  slot: number
  revision: number
  from: number
  to: number
  contentFrom: number
  endIndex: number
  tokens: readonly Token[]
  nonSpace: boolean
}>
export type MarkdownSemanticResult =
  | Readonly<{
      status: 'available'
      rows: readonly MarkdownSemanticRow[]
      next: number | null
      /** Conservatively accounted UTF-8 JSON bytes, including the result envelope. */
      bytes: number
    }>
  | Readonly<{
      status: 'unavailable'
      reason: 'syntax-context' | 'too-large'
      slot?: number
    }>

export type DocumentWorkerRequest =
  | {
      type: 'boundaries'
      epoch: string
      id: number
      version: number
      config: BoundaryConfig
      from?: number
      baseVersion?: number
    }
  | {
      type: 'boundary-ack'
      epoch: string
      id: number
      version: number
      key: string
      sequence: number
    }
  | { type: 'cancel-boundaries'; epoch: string; retain?: boolean }
  | { type: 'load-start'; epoch: string; head: SourceTransferHead }
  | { type: 'load-chunk'; epoch: string; chunk: SourceTransferChunk }
  | { type: 'load-finish'; epoch: string; request: SourceTransferRequest }
  | { type: 'edit'; epoch: string; operation: SourceOperation }
  | {
      type: 'find'
      epoch: string
      id: number
      version: number
      query: string
      highlights?: boolean
      from: number
      to: number
    }
  | { type: 'cancel-find'; epoch: string; id: number }
  | {
      type: 'metadata'
      epoch: string
      id: number
      version: number
      dialect: MetadataDialect
      frontmatter?: boolean
      reference?: MarkdownReferenceRequest
      semantic?: MarkdownReferenceSyntax
      from: number
      to: number
      limit: number
    }
  | { type: 'cancel-metadata'; epoch: string; id: number; release: boolean }

export type DocumentWorkerReply =
  | BoundaryPage
  | {
      type: 'boundary-declined'
      epoch: string
      id: number
      version: number
      key: string
    }
  | { type: 'load-ack'; epoch: string; request: SourceTransferRequest }
  | { type: 'ack'; epoch: string; version: number }
  | { type: 'find-progress'; epoch: string; id: number; version: number }
  | { type: 'metadata-progress'; epoch: string; id: number; version: number }
  | { type: 'canceled'; epoch: string; id: number }
  | { type: 'metadata-canceled'; epoch: string; id: number; release: boolean }
  | {
      type: 'metadata'
      epoch: string
      id: number
      version: number
      page: SourceOwnerPage
      reference?: ReferenceValue | null
      semantic?: MarkdownSemanticResult
    }
  | {
      type: 'find'
      epoch: string
      id: number
      version: number
      location: SearchLocation
      highlightStarts?: readonly number[]
    }
  | {
      type: 'error'
      epoch: string
      id?: number
      stage: 'replica' | 'find' | 'metadata'
      message: string
    }
