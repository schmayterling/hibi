import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { documentRuntime } from '../../renderer/src/document-runtime.ts'
import {
  flavors,
  loadFlavor,
  selectedFlavors,
} from '../../renderer/src/flavors.ts'
import { formattedDocument } from '../../renderer/src/formatted-contributions.ts'
import type { DocumentState } from '../../shared/desktop.ts'
import type { DocumentSession } from '../../shared/document-session.ts'
import type { SourceOperation } from '../../shared/source-operations.ts'
import { SourceTransferSender } from '../../shared/source-transfer.ts'
import type { AddonContext } from '../api.ts'
import type {
  CounterReply,
  CounterRequest,
  FormattedCountRequest,
} from './counter.worker.ts'

type Observed = {
  session: DocumentSession
  sender: SourceTransferSender
  ready: boolean
  references: number
  views: Set<EditorView>
  pending: SourceOperation[]
  stop: () => void
}

/** One source replica per mounted document, shared by all of its formatted panes. */
export function observeFormattedCounts(
  context: AddonContext,
  worker: Worker,
  refresh: () => void,
) {
  const documents = new Map<string, Observed>()
  const streams = new Map<string, Observed>()
  let stopped = false
  const send = (message: CounterRequest) => worker.postMessage(message)
  const changed = (tabId: string) => {
    if (context.editor.getDocument()?.tabId === tabId) refresh()
  }
  const message = (event: MessageEvent<CounterReply>) => {
    const response = event.data
    if (!response || (response.kind !== 'chunk' && response.kind !== 'ready'))
      return
    const entry = streams.get(response.request.streamId)
    if (!entry) return
    if (response.kind === 'chunk')
      send({ kind: 'chunk', chunk: entry.sender.read(response.request) })
    else {
      entry.sender.finish(response.request)
      entry.ready = true
      for (const operation of entry.pending)
        send({ kind: 'edit', streamId: entry.sender.head.streamId, operation })
      entry.pending = []
      changed(entry.sender.head.tabId)
    }
  }
  worker.addEventListener('message', message)
  const release = (entry: Observed, view?: EditorView) => {
    if (view) entry.views.delete(view)
    if (--entry.references) return
    entry.stop()
    entry.sender.close()
    const { streamId, tabId } = entry.sender.head
    streams.delete(streamId)
    if (documents.get(tabId) === entry) documents.delete(tabId)
    send({ kind: 'close', streamId })
    changed(tabId)
  }
  const attach = (view: EditorView) => {
    const document = view.state.facet(formattedDocument)
    const session = document && documentRuntime.session(document.tabId)
    if (
      stopped ||
      !document?.tabId ||
      !session ||
      session.state().document.revision !== document.revision
    )
      return null
    const tabId = document.tabId
    let entry = documents.get(tabId)
    if (!entry || entry.session !== session) {
      const source = session.snapshot()
      const sender = new SourceTransferSender(
        {
          ...source.document,
          contentVersion: source.version,
          streamId: crypto.randomUUID(),
          length: source.utf16Length,
        },
        source.chunks(),
      )
      const observed: Observed = {
        session,
        sender,
        ready: false,
        references: 0,
        views: new Set(),
        pending: [],
        stop: () => {},
      }
      observed.stop = session.subscribeOperations(({ operation }) => {
        if (observed.ready)
          send({ kind: 'edit', streamId: sender.head.streamId, operation })
        else observed.pending.push(operation)
        changed(tabId)
      })
      entry = observed
      documents.set(tabId, entry)
      streams.set(sender.head.streamId, entry)
      send({ kind: 'open', head: sender.head })
    }
    entry.references++
    entry.views.add(view)
    changed(tabId)
    return entry
  }
  const extension = ViewPlugin.fromClass(
    class {
      entry: Observed | null
      readonly view: EditorView
      constructor(view: EditorView) {
        this.view = view
        this.entry = attach(view)
      }
      update(update: ViewUpdate) {
        const document = update.state.facet(formattedDocument)
        const session = document && documentRuntime.session(document.tabId)
        if (this.entry?.session === session) return
        if (this.entry) release(this.entry, update.view)
        this.entry = attach(update.view)
      }
      destroy() {
        if (this.entry) release(this.entry, this.view)
      }
    },
  )
  const unlisten = [
    flavors.subscribe(refresh),
    context.editor.onSyntaxChange(refresh),
    context.editorViews.onDidChangeActive(refresh),
  ]
  return {
    extension,
    read(
      document: Readonly<DocumentState>,
    ): FormattedCountRequest | null | undefined {
      const entry = documents.get(document.tabId)
      if (
        !entry ||
        entry.session.state().document.revision !== document.revision
      )
        return undefined
      if (!entry.ready) return null
      const selected = new Set(
        selectedFlavors(loadFlavor(document.id), flavors.snapshot()).map(
          (flavor) => flavor.id,
        ),
      )
      const { settings } = context.editor.getMetadataSyntax(document.id)
      const active = context.editorViews.getActive()
      const sourceMode =
        !!active &&
        ![...entry.views].some(
          (view) =>
            view.dom
              .closest('[data-editor-view]')
              ?.getAttribute('data-editor-view') === active.viewId &&
            // Settings may hide the whole page without switching its editor mode.
            !view.dom.closest('.rich-pane[aria-hidden="true"]'),
        )
      return {
        kind: 'count',
        ...(sourceMode ? { mode: 'source' as const } : {}),
        streamId: entry.sender.head.streamId,
        version: entry.session.snapshot().version,
        syntax: {
          ...settings,
          alerts: selected.has('markdown.github'),
          textExtras: selected.has('text-extras.text-extras'),
          math: selected.has('math.latex'),
          mermaid: selected.has('mermaid.blocks'),
          typst: selected.has('typst.blocks'),
        },
      }
    },
    stop() {
      stopped = true
      worker.removeEventListener('message', message)
      for (const remove of unlisten) remove()
      for (const entry of streams.values()) {
        entry.references = 1
        entry.views.clear()
        release(entry)
      }
    },
  }
}
