import type { DocumentFocus } from './desktop.ts'
import type { JournalHead } from './document-checkpoint.ts'
import type { SourceSnapshot, SourceStore } from './source-buffer.ts'
import type {
  SourceTransferChunk,
  SourceTransferHead,
  SourceTransferRequest,
} from './source-transfer.ts'

export type DocumentMetadata = DocumentFocus &
  Readonly<{ documentMetadata: true; replaced: false; savedVersion: number }>
export type DocumentTransfer = DocumentFocus &
  Readonly<{
    documentTransfer: SourceTransferHead
    sourceLength: number
    savedLength: number
    sameSource: boolean
  }>
export type DocumentTransferApi = {
  openDocumentTransfer(tabId: string): Promise<DocumentTransfer>
  readDocumentTransfer(
    request: SourceTransferRequest,
  ): Promise<SourceTransferChunk>
  finishDocumentTransfer(request: SourceTransferRequest): Promise<JournalHead>
  abortDocumentTransfer(request: SourceTransferRequest): Promise<void>
}
export type LoadedDocument = Readonly<{
  store: SourceStore
  current: SourceSnapshot
  saved: SourceSnapshot
}>
