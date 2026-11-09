import type { DocumentSession } from '../../shared/document-session'
import type { SourceSnapshot } from '../../shared/source-buffer'
import {
  type SourceTransferRequest,
  SourceTransferSender,
} from '../../shared/source-transfer'

/** Recovery verification is demanded by main, so its stream bookkeeping stays out of startup. */
export class DocumentCheckpoints {
  private checkpoints = new Map<
    string,
    { sender: SourceTransferSender; current: () => boolean }
  >()
  private tabs = new Map<string, string>()

  begin(
    session: DocumentSession | null | undefined,
    source: SourceSnapshot | undefined,
  ) {
    if (!session || !source)
      throw new Error('No retained document recovery checkpoint.')
    if (!session.ownsCurrentSnapshot(source))
      throw new Error('The document changed during recovery verification.')
    const tabId = source.document.tabId
    const previous = this.tabs.get(tabId)
    if (previous) {
      this.checkpoints.get(previous)?.sender.close()
      this.checkpoints.delete(previous)
    }
    const head = {
      tabId,
      revision: source.document.revision,
      contentVersion: source.version,
      streamId: crypto.randomUUID(),
      length: source.utf16Length,
    }
    this.checkpoints.set(head.streamId, {
      sender: new SourceTransferSender(head, source.chunks()),
      current: () => session.ownsCurrentSnapshot(source),
    })
    this.tabs.set(tabId, head.streamId)
    return head
  }
  read(request: SourceTransferRequest) {
    const checkpoint = this.checkpoints.get(request.streamId)
    if (!checkpoint?.current())
      throw new Error('The document changed during recovery verification.')
    return checkpoint.sender.read(request)
  }
  close(request: SourceTransferRequest) {
    this.checkpoints.get(request.streamId)?.sender.close()
    this.checkpoints.delete(request.streamId)
  }
}
