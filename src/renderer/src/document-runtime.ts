import { type DocumentState, MAX_DOCUMENT_BYTES } from '../../shared/desktop.ts'
import { sourceChange } from '../../shared/document-journal.ts'
import { DocumentSession } from '../../shared/document-session.ts'
import type {
  DocumentId,
  DocumentTarget,
  ViewId,
  ViewTarget,
} from '../../shared/foundation-contracts.ts'
import type { SourceSnapshot } from '../../shared/source-buffer.ts'
import type {
  RawEdit,
  SourceOperation,
} from '../../shared/source-operations.ts'

type RuntimeOptions = {
  /** Combined retained history across open tabs; payload bytes are estimated. */
  historyBytes?: number
  historyGroups?: number
  admit?: (operation: SourceOperation) => void
  enqueue: (operation: SourceOperation) => void
  onError: (error: unknown) => void
}
type Listener = (
  document: DocumentState,
  changes: readonly RawEdit[] | null,
) => void

/** Per-tab source/history ownership. React and legacy addons receive immutable read facades. */
export class DocumentRuntime {
  readonly #sessions = new Map<string, DocumentSession>()
  readonly #documentTargets = new Map<string, DocumentTarget>()
  readonly #targetSessions = new Map<DocumentId, DocumentSession>()
  readonly #views = new Map<ViewId, ViewTarget>()
  #generation = 0
  #activeView: ViewId | null = null
  readonly #sources = new WeakMap<DocumentState, SourceSnapshot>()
  readonly #listeners = new Set<Listener>()
  readonly #documentListeners = new Set<Listener>()
  readonly #options: RuntimeOptions
  readonly #history = new Map<
    DocumentSession,
    { bytes: number; groups: number }
  >()
  readonly #historySubscriptions = new Map<DocumentSession, () => void>()
  readonly #historyLimits: { bytes: number; groups: number }
  #historySize = { bytes: 0, groups: 0 }
  #active: DocumentSession | null = null
  #activeId: string | null = null
  readonly #metadata = new Map<
    string,
    Omit<DocumentState, 'markdown' | 'savedMarkdown'>
  >()
  readonly #cached = new Map<string, DocumentState>()
  readonly #cachedState = new Map<
    string,
    ReturnType<DocumentSession['state']>
  >()
  readonly #savedText = new Map<
    string,
    { snapshot: SourceSnapshot; value?: string }
  >()
  readonly #changes = new Map<string, readonly RawEdit[] | null>()
  readonly #detach = new Map<string, (() => void)[]>()
  #updating = false

  constructor(options: RuntimeOptions) {
    this.#historyLimits = {
      bytes: options.historyBytes ?? 32 * 1024 * 1024,
      groups: options.historyGroups ?? 512,
    }
    if (
      !Object.values(this.#historyLimits).every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      throw new Error('Invalid combined document history limits.')
    this.#options = options
  }
  session = (id: string | null = this.#activeId) =>
    id ? (this.#sessions.get(id) ?? null) : null
  captureDocument = (id: string | null = this.#activeId) =>
    id && this.#sessions.has(id)
      ? (this.#documentTargets.get(id) ?? null)
      : null
  resolveDocument = (target: DocumentTarget) => {
    const session = this.#targetSessions.get(target.documentId)
    if (!session) return null
    const id = session.state().document.tabId
    return this.#sessions.get(id) === session &&
      this.#documentTargets.get(id)?.documentGeneration ===
        target.documentGeneration
      ? session
      : null
  }
  registerView(tabId: string, viewId: ViewId) {
    const document = this.captureDocument(tabId)
    if (!document || this.#views.has(viewId))
      throw new Error('This editor view is unavailable.')
    const target = Object.freeze({
      ...document,
      viewId,
      viewGeneration: ++this.#generation,
    })
    this.#views.set(viewId, target)
    this.#activeView = viewId
    return () => {
      if (this.#views.get(viewId) !== target) return
      this.#views.delete(viewId)
      if (this.#activeView === viewId) this.#activeView = null
    }
  }
  focusView(viewId: ViewId) {
    if (this.#views.has(viewId)) this.#activeView = viewId
  }
  captureActiveView = () => {
    const target = this.#activeView && this.#views.get(this.#activeView)
    return target && this.resolveDocument(target) ? target : null
  }
  isLiveView = (target: ViewTarget) =>
    this.#views.get(target.viewId)?.viewGeneration === target.viewGeneration &&
    this.resolveDocument(target) !== null
  retainedHistory = () => ({
    ...this.#historySize,
    sessions: this.#history.size,
  })
  #forgetHistory(session: DocumentSession) {
    const previous = this.#history.get(session)
    if (!previous) return
    this.#historySize.bytes -= previous.bytes
    this.#historySize.groups -= previous.groups
    this.#history.delete(session)
  }
  #discardSession(id: string, session: DocumentSession) {
    const target = this.#documentTargets.get(id)
    if (target) {
      this.#targetSessions.delete(target.documentId)
      for (const [viewId, view] of this.#views)
        if (view.documentId === target.documentId) {
          this.#views.delete(viewId)
          if (this.#activeView === viewId) this.#activeView = null
        }
    }
    this.#documentTargets.delete(id)
    for (const detach of this.#detach.get(id) ?? []) detach()
    this.#detach.delete(id)
    this.#metadata.delete(id)
    this.#cached.delete(id)
    this.#cachedState.delete(id)
    this.#savedText.delete(id)
    this.#changes.delete(id)
    this.#historySubscriptions.get(session)?.()
    this.#historySubscriptions.delete(session)
    this.#forgetHistory(session)
    session.dispose()
  }
  #retainHistory(current = this.#active) {
    if (!current) return
    this.#forgetHistory(current)
    const usage = current.historySize()
    if (usage.groups) {
      this.#history.set(current, usage)
      this.#historySize.bytes += usage.bytes
      this.#historySize.groups += usage.groups
    }
    while (
      this.#historySize.bytes > this.#historyLimits.bytes ||
      this.#historySize.groups > this.#historyLimits.groups
    ) {
      // Each session fits by itself; evict less recently used history first.
      const [oldest, before] = this.#history.entries().next().value!
      oldest.limitHistory(
        Math.max(
          0,
          before.bytes -
            Math.max(0, this.#historySize.bytes - this.#historyLimits.bytes),
        ),
        Math.max(
          0,
          before.groups -
            Math.max(0, this.#historySize.groups - this.#historyLimits.groups),
        ),
        (after) => {
          this.#historySize.bytes += after.bytes - before.bytes
          this.#historySize.groups += after.groups - before.groups
          if (after.groups) this.#history.set(oldest, after)
          else this.#history.delete(oldest)
        },
      )
    }
  }
  sourceFor = (document: DocumentState) => this.#sources.get(document)
  subscribe = (listener: Listener) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  subscribeDocument = (listener: Listener) => {
    this.#documentListeners.add(listener)
    return () => {
      this.#documentListeners.delete(listener)
    }
  }
  documents = () =>
    [...this.#sessions.keys()].flatMap((id) => this.get(id) ?? [])
  get = (id: string | null = this.#activeId): DocumentState | null => {
    const session = this.session(id),
      metadata = id ? this.#metadata.get(id) : null
    if (!session || !metadata) return null
    const state = session.state()
    const cached = this.#cached.get(id!)
    if (cached && this.#cachedState.get(id!) === state) return cached
    const snapshot = session.snapshot(),
      saved = session.savedSnapshot()
    if (this.#savedText.get(id!)?.snapshot !== saved)
      this.#savedText.set(id!, { snapshot: saved })
    const savedText = this.#savedText.get(id!)!
    let text: string | undefined
    const document = Object.freeze({
      ...metadata,
      revision: snapshot.document.revision,
      contentVersion: snapshot.version,
      dirty: state.dirty || metadata.ephemeral,
      get markdown() {
        text ??= snapshot.materialize()
        return text
      },
      get savedMarkdown() {
        savedText.value ??= saved.materialize()
        return savedText.value
      },
    })
    this.#cached.set(id!, document)
    this.#cachedState.set(id!, state)
    this.#sources.set(document, snapshot)
    return document
  }
  #publish = (id: string) => {
    if (this.#updating) return
    const previousActive = id === this.#activeId ? null : this.get()
    const metadata = this.#metadata.get(id)
    const session = this.session(id)
    if (
      this.#changes.get(id) &&
      metadata?.tabs.length === 0 &&
      session?.snapshot().utf16Length
    ) {
      const { tabId, name } = metadata
      this.#metadata.set(id, {
        ...metadata,
        tabs: [{ id: tabId, name, dirty: true }],
      })
      this.#cached.delete(id)
    }
    const activeMetadata = this.#activeId
      ? this.#metadata.get(this.#activeId)
      : null
    if (activeMetadata?.tabs.length) {
      const tabs = activeMetadata.tabs.map((tab) => {
        const retained = this.session(tab.id)
        const info = this.#metadata.get(tab.id)
        const dirty = retained
          ? retained.state().dirty || !!info?.ephemeral
          : tab.dirty
        return dirty === tab.dirty ? tab : { ...tab, dirty }
      })
      if (tabs.some((tab, index) => tab !== activeMetadata.tabs[index])) {
        for (const [tabId, info] of this.#metadata) {
          this.#metadata.set(tabId, { ...info, tabs })
          this.#cached.delete(tabId)
        }
      }
    }
    const document = this.get(id),
      changes = this.#changes.get(id) ?? null
    this.#changes.delete(id)
    if (!document) return
    for (const listener of [...this.#documentListeners])
      listener(document, changes)
    if (id === this.#activeId)
      for (const listener of [...this.#listeners]) listener(document, changes)
    else {
      const active = this.get()
      if (active && active !== previousActive)
        for (const listener of [...this.#listeners]) listener(active, null)
    }
  }
  activate(document: DocumentState) {
    this.#updating = true
    try {
      const { markdown, savedMarkdown, ...metadata } = document
      let session = this.#sessions.get(document.tabId)
      if (
        session &&
        (session.snapshot().version !== document.contentVersion ||
          session.snapshot().materialize() !== markdown)
      ) {
        this.#discardSession(document.tabId, session)
        session = undefined
      }
      if (!session) {
        session = new DocumentSession(
          markdown,
          document,
          document.contentVersion,
          {
            ...this.#options,
            historyBytes: Math.min(8 * 1024 * 1024, this.#historyLimits.bytes),
            historyGroups: Math.min(128, this.#historyLimits.groups),
            maximumBytes: MAX_DOCUMENT_BYTES,
          },
        )
        this.#sessions.set(document.tabId, session)
        const target = Object.freeze({
          documentId: crypto.randomUUID() as DocumentId,
          documentGeneration: ++this.#generation,
        })
        this.#documentTargets.set(document.tabId, target)
        this.#targetSessions.set(target.documentId, session)
        const retained = session
        this.#historySubscriptions.set(
          session,
          session.subscribeOperations(() => this.#retainHistory(retained)),
        )
        const id = document.tabId
        this.#detach.set(id, [
          session.subscribeOperations((prepared) => {
            this.#changes.set(id, prepared.operation.changes)
          }),
          session.subscribe(() => this.#publish(id)),
          session.subscribeStorage(() => {
            this.#cached.delete(id)
            this.#cachedState.delete(id)
            this.#savedText.delete(id)
          }),
        ])
      } else session.reidentify(document)
      session.importSaved(savedMarkdown)
      this.#active = session
      this.#activeId = document.tabId
      this.#metadata.set(document.tabId, metadata)
      this.#cached.delete(document.tabId)
      this.#cachedState.delete(document.tabId)
      this.#changes.delete(document.tabId)
      const open = new Set([
        document.tabId,
        ...document.tabs.map((tab) => tab.id),
      ])
      for (const [id, retained] of this.#sessions)
        if (!open.has(id)) {
          this.#discardSession(id, retained)
          this.#sessions.delete(id)
        }
      this.#retainHistory()
    } finally {
      this.#updating = false
    }
    return this.get()!
  }
  acknowledgeSave(document: DocumentState) {
    const current = this.get(document.tabId),
      session = this.session(document.tabId)
    if (
      !current ||
      !session ||
      current.tabId !== document.tabId ||
      current.revision !== document.revision
    )
      return null
    this.#updating = true
    try {
      session.importSaved(document.savedMarkdown)
      this.#metadata.set(document.tabId, {
        ...this.#metadata.get(document.tabId)!,
        id: document.id,
        name: document.name,
        ephemeral: document.ephemeral,
        canAutosave: document.canAutosave,
      })
      this.#cached.delete(document.tabId)
    } finally {
      this.#updating = false
    }
    this.#publish(document.tabId)
    return this.get(document.tabId)
  }
  #replacement(source: string, id: string | null = this.#activeId) {
    const session = this.session(id)
    if (!session) return null
    const snapshot = session.snapshot(),
      change = sourceChange(this.get(id)!.markdown, source)
    if (!change) return null
    // Whole-source compatibility can change CRLF spelling. Own complete pairs.
    let { from, to, insert } = change
    if (!snapshot.isEditBoundary(from)) {
      from--
      insert = snapshot.sliceRaw(from, from + 1) + insert
    }
    if (!snapshot.isEditBoundary(to)) {
      insert += snapshot.sliceRaw(to, to + 1)
      to++
    }
    return { session, changes: [{ from, to, insert }] }
  }
  /** Explicit whole-source compatibility transform. Incremental surfaces use session.edit. */
  replace(
    source: string,
    origin: SourceOperation['origin'] = 'addon',
    group: string = crypto.randomUUID(),
  ) {
    const edit = this.#replacement(source)
    return edit?.session.edit(edit.changes, origin, group) ?? null
  }
  beginReplace(source: string, group: string, id?: string, viewId = 'default') {
    const edit = this.#replacement(source, id)
    return (
      edit?.session.beginEdit(
        edit.changes,
        'visual',
        group,
        undefined,
        viewId,
      ) ?? null
    )
  }
  dispose() {
    for (const [id, session] of this.#sessions)
      this.#discardSession(id, session)
    this.#sessions.clear()
    this.#views.clear()
    this.#activeView = null
    this.#history.clear()
    this.#historySize = { bytes: 0, groups: 0 }
    this.#listeners.clear()
    this.#documentListeners.clear()
    this.#active = null
    this.#activeId = null
  }
}

const errors = new Set<(error: unknown) => void>()
const reportError = (error: unknown) => {
  for (const listener of errors) listener(error)
}
export const documentRuntime = new DocumentRuntime({
  admit: (operation) => {
    try {
      window.hibi.admitSourceOperation(operation)
    } catch (error) {
      reportError(error)
      throw error
    }
  },
  enqueue: (operation) => {
    void window.hibi.appendSourceOperation(operation).catch(reportError)
  },
  onError: reportError,
})
export const observeDocumentErrors = (listener: (error: unknown) => void) => {
  errors.add(listener)
  return () => {
    errors.delete(listener)
  }
}
