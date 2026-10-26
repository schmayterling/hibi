import {
  acceptCompletion,
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  closeCompletion,
  completionKeymap,
  completionStatus,
  currentCompletions,
  pickedCompletion,
  selectedCompletion,
  selectedCompletionIndex,
  setSelectedCompletion,
  startCompletion,
} from '@codemirror/autocomplete'
import {
  defaultKeymap,
  indentLess,
  indentMore,
  isolateHistory,
  selectAll,
} from '@codemirror/commands'
import {
  ensureSyntaxTree,
  HighlightStyle,
  indentUnit,
  type Language,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language'
import {
  closeSearchPanel,
  openSearchPanel,
  SearchQuery,
  search,
  setSearchQuery,
} from '@codemirror/search'
import {
  ChangeSet,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  Transaction,
} from '@codemirror/state'
import {
  type Command,
  EditorView,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { DocumentFormat, SourceExtension } from '../../addons/api'
import {
  type CompletionItem,
  type CompletionRequest,
  safeCompletionContext,
  sameCompletionContext,
  sourceProseAllowed,
  type TypingContext,
} from '../../shared/completions'
import { type DocumentState, MAX_DOCUMENT_BYTES } from '../../shared/desktop'
import {
  type SourceEditRequest,
  type SourceEditResult,
  sourceEditMatches,
} from '../../shared/document-edits'
import type { MarkdownReferenceSyntax } from '../../shared/document-worker-protocol'
import {
  type EditorContextAction,
  type EditorInteractionRequest,
  sameInteraction,
} from '../../shared/editor-interactions'
import type { ViewId, ViewTarget } from '../../shared/foundation-contracts'
import { markdownLink } from '../../shared/markdown-link'
import { wikiHref } from '../../shared/note-links'
import type { RawEdit } from '../../shared/source-operations'
import { editorChangesFromSource } from '../../shared/source-projection'
import { Button } from '../../ui/Controls'
import { DocumentNotice } from '../../ui/DocumentNotice'
import { codeHighlighter, codeLanguages } from './code-languages'
import {
  completionBroker,
  lazyCompletionProse,
  otherPopupOpen,
} from './completion-broker'
import {
  completionForKey,
  dismissCompletionForArrow,
  initialCompletionSelection,
} from './completion-selection'
import { documentEdits } from './document-edits'
import { editorDocument } from './document-formats'
import { documentProjections } from './document-projections'
import { documentRuntime } from './document-runtime'
import { DocumentWorkerClient, type FindAction } from './document-worker-client'
import { registerEditorSelectionCapture } from './editor-command-targets'
import {
  hasEditorInteractionProviders,
  onEditorInteractionProvidersChanged,
} from './editor-interaction-presence'
import { editorViewRegistry } from './editor-view-api'
import type { FindMove, FindStatus } from './FindBar'
import { mountedDocumentEdits } from './mounted-document-edits'
import {
  observeSourceAnnotations,
  sourceAnnotationExtension,
} from './source-annotations'
import {
  formattingKeymap,
  type SourceFormatting,
  sourceFormatting,
} from './source-formatting'
import { sourceIndentation } from './source-indent'
import {
  createSourceSession,
  sourceEditorText,
  sourceEditTransaction,
} from './source-session'
import {
  registerSourceView,
  type SourceReferenceResult,
  type SourceReferenceSyntax,
} from './source-view'
import { tabIndent } from './tab-indent'
import { textProjection } from './text-projection'

const highlighting = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--syntax-heading)', fontWeight: '600' },
  { tag: tags.strong, color: 'var(--syntax-strong)', fontWeight: '600' },
  { tag: tags.emphasis, color: 'var(--syntax-emphasis)', fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--syntax-link)' },
  { tag: tags.monospace, color: 'var(--syntax-code)' },
  { tag: [tags.meta, tags.processingInstruction], color: 'var(--syntax-meta)' },
  { tag: tags.quote, color: 'var(--syntax-quote)' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
])

type ReferenceJob = {
  version: number
  syntax: SourceReferenceSyntax
  label: string
  link: boolean
  settle: (result: SourceReferenceResult) => void
}

const sameReferenceSyntax = (
  a: SourceReferenceSyntax,
  b: SourceReferenceSyntax | undefined,
) =>
  !!b &&
  a.gfm === b.gfm &&
  a.alerts === b.alerts &&
  a.textExtras === b.textExtras &&
  !!a.math === !!b.math &&
  a.frontmatter === b.frontmatter

export function SourceEditor({
  document,
  viewId = 'default',
  focused = true,
  editTarget,
  sourceVisible = editTarget,
  markdownMode,
  markdownLanguage,
  referenceSyntax,
  linksEnabled = true,
  sourceLanguage,
  codeLanguage,
  sourceFormat,
  supportsMedia,
  label,
  waitForFont,
  onReady,
  disabled,
  findActive,
  findQuery,
  findMove,
  onFindStatus,
  showLineNumbers,
  sourceExtensions,
  onFormatting,
  onLink,
}: {
  document: DocumentState
  viewId?: string
  focused?: boolean
  editTarget: boolean
  sourceVisible?: boolean
  markdownMode: boolean
  markdownLanguage?: typeof import('@codemirror/lang-markdown').markdown
  referenceSyntax?:
    | (MarkdownReferenceSyntax & { frontmatter: boolean })
    | undefined
  linksEnabled?: boolean
  sourceLanguage: Language | undefined
  codeLanguage?: string | undefined
  sourceFormat?: DocumentFormat['formatting']
  supportsMedia: boolean
  label: string
  waitForFont: boolean
  onReady: (status: 'loading' | 'ready' | 'failed') => void
  disabled: boolean
  findActive: boolean
  findQuery: string
  findMove: FindMove
  onFindStatus: (status: FindStatus) => void
  showLineNumbers: boolean
  sourceExtensions: readonly SourceExtension[]
  onFormatting: (formatting: SourceFormatting | null) => void
  onLink: (href: string) => void
}) {
  const parserOptions = useRef({
    markdownMode,
    markdownLanguage,
    referenceSyntax,
    linksEnabled,
    sourceLanguage,
    codeLanguage,
    label,
    sourceFormat,
    supportsMedia,
  })
  parserOptions.current = {
    markdownMode,
    markdownLanguage,
    referenceSyntax,
    linksEnabled,
    sourceLanguage,
    codeLanguage,
    label,
    sourceFormat,
    supportsMedia,
  }
  const configureParser = useRef(() => {})
  // biome-ignore lint/correctness/useExhaustiveDependencies: parser configuration reads these current values through parserOptions.
  useEffect(() => {
    configureParser.current()
  }, [
    markdownMode,
    markdownLanguage,
    sourceLanguage,
    codeLanguage,
    label,
    sourceFormat,
    supportsMedia,
  ])
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [installedExtensions, setInstalledExtensions] = useState<{
    bridge: ReturnType<typeof createSourceSession>
    extensions: readonly SourceExtension[]
  } | null>(null)
  const [extensionError, setExtensionError] = useState('')
  const [languageError, setLanguageError] = useState('')
  const [languageReady, setLanguageReady] = useState(!codeLanguage)
  const [inputError, setInputError] = useState('')
  const [bridgeRetry, retryBridge] = useState(0)
  const session = documentRuntime.session(document.tabId)!
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry refreshes a bridge whose snapshot went stale before attachment.
  const bridge = useMemo(
    () => createSourceSession(session, viewId),
    [session, viewId, bridgeRetry],
  )
  const [fontReadyBridge, setFontReadyBridge] = useState<ReturnType<
    typeof createSourceSession
  > | null>(null)
  const inputReady =
    installedExtensions?.bridge === bridge &&
    installedExtensions.extensions === sourceExtensions &&
    languageReady
  const editContext = useRef({
    document,
    editTarget,
    sourceVisible,
    focused,
    disabled,
    inputReady,
  })
  editContext.current = {
    document,
    editTarget,
    sourceVisible,
    focused,
    disabled,
    inputReady,
  }
  const exactChanges = useRef<readonly RawEdit[] | undefined>(undefined)
  const editable = useRef(new Compartment())
  const numbers = useRef(new Compartment())
  const addons = useRef(new Compartment())
  const indentation = useRef(new Compartment())
  const find = useRef({
    active: findActive,
    query: findQuery,
    report: onFindStatus,
  })
  const sourceFind = useRef<DocumentWorkerClient | null>(null)
  const referenceUsed = useRef(false)
  const referenceFailed = useRef(false)
  const referenceQueue = useRef<ReferenceJob[]>([])
  const activeReference = useRef<ReferenceJob | null>(null)
  const nextReference = useRef(() => {})
  const repeatFind = useRef<(action?: FindAction) => void>(() => {})
  const findCoverage = useRef({ query: '', version: -1, total: 0 })
  const findActions = useRef<FindAction[]>([])
  const navigatingFind = useRef(false)
  const applyingFind = useRef(false)
  const handledFindMove = useRef(findMove.id)
  const ready = useRef(onReady)
  const formatting = useRef<SourceFormatting | null>(null)
  const reportFormatting = useRef(onFormatting)
  const openLink = useRef(onLink)
  openLink.current = onLink
  reportFormatting.current = onFormatting
  ready.current = onReady
  find.current = { active: findActive, query: findQuery, report: onFindStatus }

  const clearReferences = useCallback(
    (status: 'stale' | 'unavailable', release = true) => {
      const pending = activeReference.current
      activeReference.current = null
      const queued = referenceQueue.current.splice(0)
      pending?.settle({ status })
      for (const job of queued) job.settle({ status })
      if (release) sourceFind.current?.releaseMetadata()
    },
    [],
  )
  const referenceCurrent = useCallback(
    (job: ReferenceJob) =>
      !!view.current &&
      parserOptions.current.markdownMode &&
      job.version === session.snapshot().version &&
      sameReferenceSyntax(job.syntax, parserOptions.current.referenceSyntax),
    [session],
  )

  const getWorker = useCallback(
    function getWorker() {
      if (referenceFailed.current) {
        sourceFind.current?.dispose()
        sourceFind.current = null
        referenceFailed.current = false
      }
      sourceFind.current ??= new DocumentWorkerClient(session, {
        changed: () => {
          // Edits already cancel old-version work in the client. Keep its
          // reference index available for the next incremental lookup.
          clearReferences('stale', false)
          findActions.current = []
          navigatingFind.current = false
          repeatFind.current()
        },
        metadataResult: (_page, reference) => {
          const pending = activeReference.current
          activeReference.current = null
          if (pending)
            pending.settle(
              !referenceCurrent(pending)
                ? { status: 'stale' }
                : reference === undefined
                  ? { status: 'unavailable' }
                  : { status: 'resolved', value: reference },
            )
          nextReference.current()
        },
        metadataError: () => {
          clearReferences('unavailable')
        },
        pending: () => {
          const known = findCoverage.current
          const complete =
            known.query === find.current.query &&
            known.version === session.snapshot().version
          find.current.report({
            current: 0,
            total: complete ? known.total : 0,
            pending: !complete,
          })
        },
        error: (message) => {
          referenceFailed.current = true
          clearReferences('unavailable', false)
          findActions.current = []
          navigatingFind.current = false
          find.current.report({ current: 0, total: 0, error: message })
        },
        result: (location, action) => {
          const current = view.current
          if (!current || !find.current.active) return
          findCoverage.current = {
            query: find.current.query,
            version: session.snapshot().version,
            total: location.total,
          }
          const target =
            action === 'previous'
              ? location.previous
              : action
                ? location.next
                : null
          if (target) {
            applyingFind.current = true
            try {
              current.dispatch({
                selection: { anchor: target.match.from, head: target.match.to },
                scrollIntoView: true,
              })
            } finally {
              applyingFind.current = false
            }
          }
          find.current.report({
            current: target?.rank ?? location.current,
            total: location.total,
          })
          navigatingFind.current = false
          const next = findActions.current.shift()
          if (next) {
            navigatingFind.current = true
            repeatFind.current(next)
          }
        },
      })
      return sourceFind.current
    },
    [session, clearReferences, referenceCurrent],
  )
  const requestReference = useCallback(() => {
    if (activeReference.current) return
    for (;;) {
      const job = referenceQueue.current.shift()
      if (!job) return
      if (!referenceCurrent(job)) {
        job.settle({ status: 'stale' })
        continue
      }
      activeReference.current = job
      referenceUsed.current = true
      getWorker().metadata(
        job.syntax.gfm ? 'gfm' : 'commonmark',
        0,
        0,
        1,
        job.syntax.frontmatter,
        { ...job.syntax, label: job.label },
      )
      return
    }
  }, [getWorker, referenceCurrent])
  nextReference.current = requestReference
  const resolveReference = useCallback(
    (
      syntax: SourceReferenceSyntax,
      label: string,
      signal?: AbortSignal,
    ): Promise<SourceReferenceResult> => {
      if (signal?.aborted) return Promise.resolve({ status: 'stale' })
      if (
        label.length > 1000 ||
        referenceQueue.current.length +
          Number(!!activeReference.current && !activeReference.current.link) >=
          128
      )
        return Promise.resolve({ status: 'unavailable' })
      return new Promise((resolve) => {
        const job: ReferenceJob = {
          version: session.snapshot().version,
          syntax: { ...syntax },
          label,
          link: false,
          settle(result) {
            signal?.removeEventListener('abort', abort)
            resolve(result)
          },
        }
        const abort = () => {
          const index = referenceQueue.current.indexOf(job)
          if (index >= 0) referenceQueue.current.splice(index, 1)
          if (activeReference.current === job) {
            activeReference.current = null
            requestReference()
            if (!activeReference.current) sourceFind.current?.releaseMetadata()
          }
          job.settle({ status: 'stale' })
        }
        signal?.addEventListener('abort', abort, { once: true })
        referenceQueue.current.push(job)
        requestReference()
      })
    },
    [requestReference, session],
  )
  useEffect(() => {
    const current = (job: ReferenceJob) =>
      markdownMode && sameReferenceSyntax(job.syntax, referenceSyntax)
    if (
      (activeReference.current && !current(activeReference.current)) ||
      referenceQueue.current.some((job) => !current(job))
    )
      clearReferences('stale')
  }, [referenceSyntax, markdownMode, clearReferences])
  const requestFind = useCallback(
    function requestFind(action: FindAction = null) {
      const editor = view.current
      if (!editor || !find.current.active || !find.current.query) return
      const selection = editor.state.selection.main
      getWorker().find(
        find.current.query,
        action === 'first' ? 0 : selection.from,
        action === 'first' ? 0 : selection.to,
        action,
      )
    },
    [getWorker],
  )
  repeatFind.current = requestFind

  useEffect(() => {
    if (!host.current) return
    const active = documentRuntime.get(document.tabId)
    if (
      !active ||
      active.tabId !== document.tabId ||
      active.revision !== document.revision
    )
      return
    if (
      documentRuntime.session(document.tabId) !== session ||
      !session.ownsCurrentSnapshot(bridge.snapshot())
    ) {
      retryBridge((retry) => retry + 1)
      return
    }
    const language = new Compartment()
    const markdown = () => {
      const {
        markdownMode,
        markdownLanguage,
        sourceLanguage,
        codeLanguage,
        label,
      } = parserOptions.current
      return [
        markdownMode
          ? codeLanguage && !codeLanguages.resolve(codeLanguage)
            ? []
            : (markdownLanguage?.({ codeLanguages: codeLanguages.resolve }) ??
              [])
          : codeLanguage
            ? (codeLanguages.resolve(codeLanguage) ?? [])
            : (sourceLanguage ?? []),
        keymap.of(
          formattingKeymap((id) => formatting.current?.run(id) ?? false),
        ),
        EditorView.contentAttributes.of({
          'aria-label': markdownMode ? 'Markdown editor' : `${label} editor`,
          'aria-description': 'Press Escape, then Tab, to leave the editor.',
        }),
      ]
    }
    const selection = bridge.selection()
    type PendingCompletion = {
      request: CompletionRequest
      items: readonly CompletionItem[]
      done: boolean
      cancel: (() => void) | null
      waiting: ((result: CompletionResult | null) => void)[]
      refresh: ReturnType<typeof setTimeout> | null
      options: Map<CompletionItem, Completion>
    }
    let completion: PendingCompletion | null = null
    let typed: {
      doc: EditorState['doc']
      pos: number
      character: string
    } | null = null
    let closingCompletion = false
    let escaped = false
    let compositionSignal: {
      changes: ChangeSet
      request: CompletionRequest | null
    } | null = null
    let compositionFrame = 0
    let newlineInput = false
    const reportTyping = (
      kind: TypingContext['kind'],
      changes: ChangeSet,
      boundaryBefore?: string,
    ) => {
      if (!completionBroker.hasTypingListeners()) return
      const request = captureCompletion({ kind: 'explicit' })
      if (!request) return
      let from = Infinity,
        to = 0,
        insertedLength = 0
      changes.iterChangedRanges((fromA, toA) => {
        from = Math.min(from, fromA)
        to = Math.max(to, toA)
      })
      if (!Number.isFinite(from)) return
      insertedLength = changes.newLength - changes.length + to - from
      completionBroker.emitTypingContext(
        {
          ...request,
          before:
            boundaryBefore === undefined
              ? (request.prose?.before ?? '')
              : `${boundaryBefore}\n`.slice(-256),
          after: request.prose?.after ?? '',
          kind: request.prose ? kind : 'replace',
          change: { from, to, insertedLength },
        },
        kind,
      )
    }
    const proseAt = (
      state: EditorState,
      markdownMode = parserOptions.current.markdownMode,
    ) => {
      const pos = state.selection.main.head
      if (
        !markdownMode ||
        pos > 16384 ||
        !sourceProseAllowed(state.sliceDoc(0, pos))
      )
        return null
      const line = state.doc.lineAt(pos)
      if (
        line.length > 16384 ||
        /^\s*\//.test(line.text) ||
        /<\/?[a-z!]/i.test(line.text)
      )
        return null
      const tree = ensureSyntaxTree(state, line.to, 2)
      if (tree?.type.name !== 'Document') return null
      let from = line.from,
        to = line.to,
        excluded = false
      tree.iterate({
        from: line.from,
        to: line.to,
        enter(node) {
          if (!/code|frontmatter|html|link|url|math/i.test(node.name)) return
          if (node.from < pos && pos < node.to) excluded = true
          if (node.to <= pos) from = Math.max(from, node.to)
          if (node.from >= pos) to = Math.min(to, node.from)
        },
      })
      return excluded
        ? null
        : safeCompletionContext(state.sliceDoc(from, to), pos - from)
    }
    const captureCompletion = (
      trigger: CompletionRequest['trigger'],
      allowSelection = false,
    ): CompletionRequest | null => {
      const context = editContext.current
      const active = documentRuntime.get(document.tabId)
      const target = documentRuntime.captureActiveView()
      const owner = documentRuntime.captureDocument(document.tabId)
      const state = editor.state
      const selected = state.selection
      if (
        view.current !== editor ||
        !editor.hasFocus ||
        editor.composing ||
        otherPopupOpen(editor.contentDOM) ||
        !context.editTarget ||
        context.disabled ||
        !context.inputReady ||
        !active ||
        active.revision !== context.document.revision ||
        documentRuntime.session(document.tabId) !== session ||
        !target ||
        !owner ||
        target.documentId !== owner.documentId ||
        target.documentGeneration !== owner.documentGeneration ||
        target.viewId !== viewId ||
        !documentRuntime.isLiveView(target) ||
        selected.ranges.length !== 1 ||
        (!allowSelection && !selected.main.empty)
      )
        return null
      const snapshot = bridge.snapshot()
      if (snapshot.version !== active.contentVersion) return null
      const pos = selected.main.head
      const markdownMode = parserOptions.current.markdownMode
      const prose = lazyCompletionProse(() => proseAt(state, markdownMode))
      return {
        view: target,
        contentVersion: snapshot.version,
        editor: 'source',
        documentLength: state.doc.length,
        selection: { anchor: selected.main.anchor, head: pos },
        get prose() {
          return prose() ?? null
        },
        before: state.sliceDoc(Math.max(0, pos - 256), pos),
        after: state.sliceDoc(pos, Math.min(state.doc.length, pos + 256)),
        trigger,
      }
    }
    const captureInteraction = (
      position: number,
      allowBlurred = false,
      toolbarSelection = false,
    ): EditorInteractionRequest | null => {
      const context = editContext.current
      const active = documentRuntime.get(document.tabId)
      const target = documentRuntime.captureActiveView()
      const owner = documentRuntime.captureDocument(document.tabId)
      const selected = editor.state.selection
      if (
        view.current !== editor ||
        (!editor.hasFocus && !allowBlurred) ||
        editor.composing ||
        !context.editTarget ||
        context.disabled ||
        !context.inputReady ||
        !active ||
        active.revision !== context.document.revision ||
        documentRuntime.session(document.tabId) !== session ||
        !target ||
        !owner ||
        target.documentId !== owner.documentId ||
        target.documentGeneration !== owner.documentGeneration ||
        target.viewId !== viewId ||
        !documentRuntime.isLiveView(target) ||
        selected.ranges.length !== 1 ||
        !Number.isSafeInteger(position) ||
        position < 0 ||
        position > editor.state.doc.length
      )
        return null
      const snapshot = bridge.snapshot()
      if (snapshot.version !== active.contentVersion) return null
      return {
        view: target,
        contentVersion: snapshot.version,
        editor: 'source',
        documentLength: editor.state.doc.length,
        position,
        selection: {
          anchor: selected.main.anchor,
          head: selected.main.head,
        },
        before: editor.state.sliceDoc(Math.max(0, position - 256), position),
        after: editor.state.sliceDoc(
          position,
          Math.min(editor.state.doc.length, position + 256),
        ),
        selectedText: editor.state.sliceDoc(
          selected.main.from,
          toolbarSelection
            ? Math.min(selected.main.to, selected.main.from + 256)
            : selected.main.to,
        ),
      }
    }
    const cancelCompletion = () => {
      const pending = completion
      completion = null
      if (!pending) return
      if (pending.refresh) clearTimeout(pending.refresh)
      pending.cancel?.()
      for (const resolve of pending.waiting.splice(0)) resolve(null)
    }
    const completionItems = new WeakMap<Completion, CompletionItem>()
    const resultFor = (pending: PendingCompletion): CompletionResult => ({
      from: pending.request.selection.head,
      to: pending.request.selection.head,
      filter: false,
      update: (_result, _from, _to, context) =>
        context.state.doc === editor.state.doc &&
        completion === pending &&
        pending.items.length &&
        sameCompletionContext(
          pending.request,
          captureCompletion(pending.request.trigger),
        )
          ? resultFor(pending)
          : null,
      options: pending.items.map((item): Completion => {
        const previous = pending.options.get(item)
        if (previous) return previous
        const option: Completion = {
          label: item.label,
          ...(item.detail === undefined ? {} : { detail: item.detail }),
          apply: (view, picked) => {
            const current = captureCompletion(pending.request.trigger)
            const pos = pending.request.selection.head
            if (
              view !== editor ||
              completion !== pending ||
              !sameCompletionContext(pending.request, current) ||
              item.from > pos ||
              item.to < pos ||
              item.from > item.to ||
              item.to > view.state.doc.length
            ) {
              closeCompletion(view)
              return
            }
            const report = completionBroker.prepareAcceptance(
              pending.request,
              item,
            )
            if (!report) return
            const transaction = view.state.update({
              changes: {
                from: item.from,
                to: item.to,
                insert: item.insertText,
              },
              selection: { anchor: item.from + item.insertText.length },
              annotations: [
                isolateHistory.of('full'),
                pickedCompletion.of(picked),
                Transaction.userEvent.of('input.complete'),
              ],
            })
            view.dispatch(transaction)
            if (
              view.state.doc.eq(transaction.state.doc) &&
              bridge.snapshot().version ===
                pending.request.contentVersion + 1 &&
              session.ownsCurrentSnapshot(bridge.snapshot())
            )
              report()
          },
        }
        pending.options.set(item, option)
        completionItems.set(option, item)
        return option
      }),
    })
    const refreshCompletion = (pending: PendingCompletion) => {
      if (pending.refresh) return
      pending.refresh = setTimeout(() => {
        pending.refresh = null
        if (completion !== pending) return
        if (
          !sameCompletionContext(
            pending.request,
            captureCompletion(pending.request.trigger),
          )
        ) {
          cancelCompletion()
          return
        }
        if (pending.items.length) {
          if (completionStatus(editor.state) === 'active')
            // Ask CodeMirror to refresh result.update without closing the menu.
            editor.dispatch({
              annotations: Transaction.userEvent.of(
                'input.type.completion-refresh',
              ),
            })
          else if (completionStatus(editor.state) === 'pending') {
            pending.refresh = setTimeout(() => {
              pending.refresh = null
              refreshCompletion(pending)
            }, 10)
          } else startCompletion(editor)
        } else {
          closingCompletion = true
          closeCompletion(editor)
          closingCompletion = false
          if (pending.done) cancelCompletion()
        }
      }, 0)
    }
    const sourceCompletions = (context: CompletionContext) => {
      if (!completionBroker.hasProviders()) return null
      const trigger: CompletionRequest['trigger'] | null = context.explicit
        ? { kind: 'explicit' }
        : typed?.doc === context.state.doc && typed.pos === context.pos
          ? { kind: 'input', character: typed.character }
          : null
      if (!trigger) return null
      const request = captureCompletion(trigger)
      if (!request) return null
      const current = completion
      if (current && sameCompletionContext(current.request, request))
        return current.items.length
          ? resultFor(current)
          : current.done
            ? null
            : new Promise<CompletionResult | null>((resolve) =>
                current.waiting.push(resolve),
              )
      cancelCompletion()
      const pending: PendingCompletion = {
        request,
        items: [],
        done: false,
        cancel: null,
        waiting: [],
        refresh: null,
        options: new Map(),
      }
      completion = pending
      pending.cancel = completionBroker.request(
        () => request,
        () => captureCompletion(trigger),
        (update) => {
          if (completion !== pending) return
          pending.items = update.items.filter(
            (item) =>
              item.from <= request.selection.head &&
              item.to >= request.selection.head,
          )
          pending.done = update.done
          if (pending.waiting.length) {
            if (pending.items.length || pending.done) {
              const result = pending.items.length ? resultFor(pending) : null
              for (const resolve of pending.waiting.splice(0)) resolve(result)
            }
          } else refreshCompletion(pending)
        },
      )
      if (!pending.cancel) {
        cancelCompletion()
        return null
      }
      return new Promise<CompletionResult | null>((resolve) =>
        pending.waiting.push(resolve),
      )
    }
    const indentSource = (view: EditorView, command: Command) => {
      if (
        !tabIndent.snapshot().enabled ||
        view.state.readOnly ||
        view.scrollDOM.classList.contains('cm-vimMode')
      )
        return false
      if (
        command === indentLess ||
        view.state.selection.ranges.some((range) => !range.empty)
      )
        return command(view)
      view.dispatch(view.state.replaceSelection(view.state.facet(indentUnit)), {
        scrollIntoView: true,
        userEvent: 'input',
      })
      return true
    }
    const editor = new EditorView({
      parent: host.current,
      dispatchTransactions(transactions, editor) {
        try {
          bridge.dispatch(transactions, editor, exactChanges.current)
          setInputError('')
        } catch (error) {
          setInputError(error instanceof Error ? error.message : String(error))
          editor.update([editor.state.update({})])
        }
      },
      state: EditorState.create({
        doc: sourceEditorText(bridge.snapshot()),
        ...(selection ? { selection } : {}),
        extensions: [
          addons.current.of([]),
          search({
            createPanel: () => {
              const dom = window.document.createElement('div')
              dom.hidden = true
              return { dom }
            },
          }),
          editable.current.of([
            EditorView.editable.of(false),
            EditorState.readOnly.of(true),
          ]),
          numbers.current.of([]),
          language.of(markdown()),
          sourceAnnotationExtension,
          autocompletion({
            override: [sourceCompletions],
            selectOnOpen: false,
            defaultKeymap: false,
          }),
          EditorState.transactionExtender.of((transaction) => {
            const options = currentCompletions(transaction.state)
            if (
              !options.length ||
              options === currentCompletions(transaction.startState) ||
              selectedCompletion(transaction.state)
            )
              return null
            const option = options[0]
            const first = option && completionItems.get(option)
            return first && initialCompletionSelection([first]) === 0
              ? { effects: setSelectedCompletion(0) }
              : null
          }),
          Prec.highest(
            keymap.of([
              ...completionKeymap.filter((binding) => binding.key !== 'Enter'),
              ...(['Enter', 'Tab'] as const).map((key) => ({
                key,
                run: (view: EditorView) => {
                  const options = currentCompletions(view.state)
                  const selected = selectedCompletionIndex(view.state) ?? -1
                  const option =
                    options[selected < 0 && key === 'Tab' ? 0 : selected]
                  const item = option && completionItems.get(option)
                  if (
                    !item ||
                    !completionForKey([item], selected < 0 ? -1 : 0, key)
                  ) {
                    closeCompletion(view)
                    return false
                  }
                  if (selected < 0)
                    view.dispatch({ effects: setSelectedCompletion(0) })
                  return acceptCompletion(view)
                },
              })),
            ]),
          ),
          indentation.current.of(sourceIndentation(tabIndent.snapshot().unit)),
          keymap.of([
            // Like Enter, a Tab the open list declines (it just opened, or its
            // item keeps Tab) does what it would without the list.
            {
              key: 'Tab',
              run: (view) => indentSource(view, indentMore),
              shift: (view) => indentSource(view, indentLess),
            },
          ]),
          EditorView.domEventHandlers({
            keydown(event, view) {
              // CodeMirror arms Tab focus for two seconds after an unhandled Escape;
              // keep it armed until another key or blur so nobody has to hurry.
              if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key))
                escaped = false
              if (event.key === 'Escape')
                queueMicrotask(() => {
                  if (event.defaultPrevented) return
                  view.setTabFocusMode(Infinity)
                  escaped = true
                })
              return false
            },
            beforeinput(event, view) {
              const data = event.data
              if (
                event.inputType === 'insertText' &&
                data &&
                /[\r\n]/.test(data) &&
                !view.composing &&
                !view.state.readOnly
              ) {
                // Chromium applies each line break of a text input as its own
                // editing step, quadratic in the lines. Insert it as CodeMirror's
                // own text input would, in one transaction, with handlers and
                // the default insert seeing the same normalized line breaks.
                event.preventDefault()
                const { from, to } = view.state.selection.main
                const lines = view.state.toText(data),
                  text = lines.toString()
                const insert = () =>
                  view.state.update(view.state.replaceSelection(lines), {
                    userEvent: 'input.type',
                    scrollIntoView: true,
                  })
                if (
                  !view.state
                    .facet(EditorView.inputHandler)
                    .some((handler) => handler(view, from, to, text, insert))
                )
                  view.dispatch(insert())
                // Listeners such as typing state get the input the browser would have sent.
                view.contentDOM.dispatchEvent(
                  new InputEvent('input', {
                    inputType: 'insertText',
                    data,
                    bubbles: true,
                  }),
                )
                return true
              }
              if (
                event.inputType !== 'historyUndo' &&
                event.inputType !== 'historyRedo'
              )
                return false
              event.preventDefault()
              return event.inputType === 'historyUndo'
                ? bridge.undo()
                : bridge.redo()
            },
            blur(_event, view) {
              if (escaped) view.setTabFocusMode(false)
              escaped = false
              const selection = view.state.selection
              if (selection.ranges.some((range) => range.empty && range.assoc))
                view.dispatch({
                  // Clear wrapped-line affinity so background measurements cannot
                  // restore the native selection and steal focus from the rich pane.
                  selection: EditorSelection.create(
                    selection.ranges.map((range) =>
                      range.empty ? EditorSelection.cursor(range.head) : range,
                    ),
                    selection.mainIndex,
                  ),
                })
            },
            click(event, view) {
              if (
                !event.shiftKey ||
                !parserOptions.current.markdownMode ||
                !parserOptions.current.linksEnabled
              )
                return false
              const position = view.posAtCoords({
                x: event.clientX,
                y: event.clientY,
              })
              if (position == null) return false
              let node = syntaxTree(view.state).resolveInner(position, -1)
              const lexical = node
              while (node.parent && !['Link', 'Autolink'].includes(node.name))
                node = node.parent
              if (!['Link', 'Autolink'].includes(node.name)) {
                let parent = lexical
                while (parent.parent) {
                  if (/code|frontmatter/i.test(parent.name)) return false
                  parent = parent.parent
                }
                const line = view.state.doc.lineAt(position)
                for (const match of line.text.matchAll(
                  /!?\[\[([^\]\r\n]+)\]\]/g,
                )) {
                  const from = line.from + match.index
                  if (position < from || position > from + match[0].length)
                    continue
                  event.preventDefault()
                  const target = (match[1] ?? '').split('|')[0]?.trim() ?? ''
                  if (!target) return false
                  openLink.current(wikiHref(target))
                  return true
                }
                return false
              }
              const target = markdownLink(
                view.state.sliceDoc(node.from, node.to),
              )
              if (!target) return false
              const syntax = parserOptions.current.referenceSyntax
              if ('label' in target) {
                if (!syntax) return false
                event.preventDefault()
                const pending = activeReference.current
                activeReference.current = null
                if (pending?.link) pending.settle({ status: 'stale' })
                else if (pending) referenceQueue.current.unshift(pending)
                referenceQueue.current.unshift({
                  version: session.snapshot().version,
                  syntax: { ...syntax },
                  label: target.label,
                  link: true,
                  settle(result) {
                    if (
                      parserOptions.current.linksEnabled &&
                      result.status === 'resolved' &&
                      result.value?.href
                    )
                      openLink.current(result.value.href)
                  },
                })
                requestReference()
                return true
              }
              if (!target.href) return false
              if (activeReference.current?.link) {
                const pending = activeReference.current
                activeReference.current = null
                pending.settle({ status: 'stale' })
                requestReference()
                if (!activeReference.current)
                  sourceFind.current?.releaseMetadata()
              }
              event.preventDefault()
              openLink.current(target.href)
              return true
            },
          }),
          keymap.of([
            { key: 'Ctrl-a', run: selectAll },
            ...defaultKeymap,
            { key: 'Mod-z', run: bridge.undo, shift: bridge.redo },
            { key: 'Mod-y', run: bridge.redo },
          ]),
          syntaxHighlighting(highlighting),
          syntaxHighlighting(codeHighlighter),
          EditorView.lineWrapping,
          placeholder('Start typing'),
          EditorView.contentAttributes.of({
            spellcheck: 'false',
          }),
          EditorView.updateListener.of((update) => {
            const newline = update.docChanged && newlineInput
            if (update.docChanged) newlineInput = false
            if (update.docChanged && completionBroker.hasTypingListeners()) {
              const transaction =
                update.transactions.length === 1 ? update.transactions[0] : null
              if (compositionSignal) {
                compositionSignal.changes = compositionSignal.changes.compose(
                  update.changes,
                )
              } else if (
                transaction &&
                !update.view.composing &&
                !transaction.isUserEvent('input.type.compose')
              ) {
                if (
                  transaction.isUserEvent('input.type') ||
                  (newline &&
                    transaction.annotation(Transaction.userEvent) === 'input')
                )
                  reportTyping(
                    'input',
                    update.changes,
                    newline ||
                      update.state.doc.lineAt(update.state.selection.main.head)
                        .from === update.state.selection.main.head
                      ? proseAt(update.startState)?.before
                      : undefined,
                  )
                else if (transaction.isUserEvent('delete'))
                  reportTyping('delete', update.changes)
                else if (
                  transaction.isUserEvent('input.paste') ||
                  transaction.isUserEvent('input.drop')
                )
                  reportTyping('replace', update.changes)
              }
            }
            if (update.selectionSet || update.docChanged)
              editorViewRegistry.changed(viewId as ViewId, 'source')
            if (
              update.docChanged ||
              update.selectionSet ||
              (update.focusChanged && !update.view.hasFocus)
            ) {
              cancelCompletion()
              typed = null
              const transaction =
                update.transactions.length === 1 ? update.transactions[0] : null
              if (
                update.docChanged &&
                transaction?.isUserEvent('input.type') &&
                !transaction.isUserEvent('input.type.compose') &&
                !update.view.composing &&
                update.state.selection.ranges.length === 1 &&
                update.state.selection.main.empty
              ) {
                let changes = 0
                transaction.changes.iterChanges(
                  (fromA, toA, fromB, toB, inserted) => {
                    const character = inserted.toString()
                    changes++
                    if (
                      changes === 1 &&
                      fromA === toA &&
                      toB === fromB + character.length &&
                      Array.from(character).length === 1 &&
                      update.state.selection.main.head === toB
                    )
                      typed = { doc: update.state.doc, pos: toB, character }
                  },
                )
                if (changes !== 1) typed = null
              }
            } else if (
              !closingCompletion &&
              completionStatus(update.startState) !== null &&
              completionStatus(update.state) === null
            )
              cancelCompletion()
            if (update.docChanged || update.selectionSet || update.focusChanged)
              update.view.contentDOM.dispatchEvent(
                new Event('hibi:source-caret', { bubbles: true }),
              )
            if (update.docChanged || update.selectionSet || update.focusChanged)
              update.view.contentDOM.dispatchEvent(
                new Event('hibi:editor-interactions-invalidate'),
              )
            if (
              update.docChanged ||
              update.selectionSet ||
              update.transactions.some(
                (transaction) => transaction.effects.length,
              )
            )
              reportFormatting.current(formatting.current)
            if (
              find.current.active &&
              !applyingFind.current &&
              (update.docChanged || update.selectionSet)
            ) {
              findActions.current = []
              navigatingFind.current = false
              requestFind()
            }
          }),
        ],
      }),
    })
    view.current = editor
    const detachSession = bridge.attach(editor)
    const removeTypingHistory = session.subscribeOperations((prepared) => {
      if (
        !completionBroker.hasTypingListeners() ||
        (prepared.operation.origin !== 'undo' &&
          prepared.operation.origin !== 'redo')
      )
        return
      const changes = editorChangesFromSource(
        prepared.before,
        prepared.operation.changes,
      )
      const previousLength = prepared.before.normalizedLength
      reportTyping(
        prepared.operation.origin,
        ChangeSet.of(changes, previousLength),
      )
    })
    const onTypingCommand = (event: KeyboardEvent) => {
      if (
        completion &&
        dismissCompletionForArrow(completion.items, event.key)
      ) {
        cancelCompletion()
        closeCompletion(editor)
        return
      }
      if (
        event.key !== 'Enter' ||
        event.isComposing ||
        editor.composing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return
      newlineInput = true
      setTimeout(() => {
        newlineInput = false
      }, 0)
    }
    editor.contentDOM.addEventListener('keydown', onTypingCommand, true)
    const startCompositionSignal = () => {
      cancelAnimationFrame(compositionFrame)
      compositionSignal = completionBroker.hasTypingListeners()
        ? {
            changes: editor.state.changes([]),
            request: captureCompletion({ kind: 'explicit' }, true),
          }
        : null
    }
    const endCompositionSignal = () => {
      compositionFrame = requestAnimationFrame(() => {
        compositionFrame = 0
        const signal = compositionSignal
        compositionSignal = null
        const current = captureCompletion({ kind: 'explicit' })
        if (
          !signal?.request ||
          !current ||
          signal.request.view.viewGeneration !== current.view.viewGeneration ||
          signal.request.view.documentGeneration !==
            current.view.documentGeneration
        )
          return
        reportTyping('composition', signal.changes)
      })
    }
    editor.contentDOM.addEventListener(
      'compositionstart',
      startCompositionSignal,
      true,
    )
    editor.contentDOM.addEventListener('compositionend', endCompositionSignal)
    const removeAnnotations = observeSourceAnnotations(editor)
    const unregisterProjection = documentProjections.register(
      'source',
      (cached) => {
        const context = editContext.current
        const current = editorDocument.get()
        if (
          !context.focused ||
          !context.editTarget ||
          context.disabled ||
          !context.inputReady ||
          !current ||
          current.tabId !== context.document.tabId ||
          current.revision !== context.document.revision ||
          bridge.snapshot().version !== current.contentVersion
        )
          return null
        return (
          cached ??
          textProjection(current.markdown, parserOptions.current.markdownMode)
        )
      },
    )
    const applySourceEdits = (
      request: SourceEditRequest,
      mountedView?: ViewTarget,
    ): SourceEditResult => {
      const context = editContext.current
      if (!mountedView && !context.focused)
        return {
          status: 'unsupported-view',
          message: 'Choose this pane before applying the edit.',
        }
      const current = mountedView
        ? documentRuntime.get(context.document.tabId)
        : editorDocument.get()
      const identity = mountedView
        ? documentRuntime.captureDocument(context.document.tabId)
        : null
      if (
        mountedView &&
        (!documentRuntime.isLiveView(mountedView) ||
          mountedView.viewId !== viewId ||
          !identity ||
          identity.documentId !== mountedView.documentId ||
          identity.documentGeneration !== mountedView.documentGeneration)
      )
        return {
          status: 'stale',
          message: 'The document changed. Review the edits again.',
        }
      if (mountedView ? !context.sourceVisible : !context.editTarget)
        return {
          status: 'unsupported-view',
          message: 'Open source view to apply these edits.',
        }
      if (
        !current ||
        !sourceEditMatches(request, current) ||
        current.tabId !== context.document.tabId ||
        current.revision !== context.document.revision
      )
        return {
          status: 'stale',
          message: 'The document changed. Review the edits again.',
        }
      if (context.disabled || !context.inputReady)
        return {
          status: 'busy',
          message: 'The editor is not ready for changes.',
        }
      if (editor.composing)
        return {
          status: 'composing',
          message: 'Finish composing text before applying edits.',
        }
      const snapshot = bridge.snapshot()
      if (snapshot.version !== current.contentVersion)
        return {
          status: 'stale',
          message: 'The editor is synchronizing. Review the edits again.',
        }
      let transaction: Transaction | null
      try {
        transaction = sourceEditTransaction(
          editor.state,
          snapshot,
          request.changes,
          MAX_DOCUMENT_BYTES,
        )
        if (!transaction)
          return { status: 'applied', contentVersion: current.contentVersion }
      } catch (error) {
        return { status: 'invalid', message: String(error) }
      }
      exactChanges.current = request.changes
      try {
        editor.dispatch(transaction)
      } finally {
        exactChanges.current = undefined
      }
      if (bridge.snapshot().version === snapshot.version)
        return {
          status: 'busy',
          message:
            'The edit was not accepted. Check document recovery and retry.',
        }
      return {
        status: 'applied',
        contentVersion: bridge.snapshot().version,
      }
    }
    const unregisterEdits = documentEdits.register(applySourceEdits)
    const documentTarget = documentRuntime.captureDocument(document.tabId)
    const mountedView = documentRuntime.captureView(viewId as ViewId)
    const target = documentTarget && {
      ...documentTarget,
      viewId: viewId as ViewId,
      ...(mountedView?.documentId === documentTarget.documentId &&
      mountedView.documentGeneration === documentTarget.documentGeneration
        ? { viewGeneration: mountedView.viewGeneration }
        : {}),
    }
    const unregisterMountedEdits = target
      ? mountedDocumentEdits.register(
          document.tabId,
          target,
          'source',
          (target, request) => applySourceEdits(request, target),
        )
      : () => {}
    const actionScope = documentEdits.scope(() => false)
    const applyInteraction = (
      action: EditorContextAction,
      request: EditorInteractionRequest,
    ) => {
      if (!sameInteraction(request, captureInteraction(request.position)))
        return false
      const snapshot = bridge.snapshot()
      const from = snapshot.editorToRaw(action.edit.from)
      const to = snapshot.editorToRaw(action.edit.to)
      if (from === null || to === null) return false
      const result = actionScope.apply({
        requestId: crypto.randomUUID(),
        tabId: document.tabId,
        revision: document.revision,
        contentVersion: snapshot.version,
        changes: [
          {
            from,
            to,
            expectedText: snapshot.sliceRaw(from, to),
            insert: action.edit.insertText,
          },
        ],
      })
      if (result.status !== 'applied') setInputError(result.message)
      return result.status === 'applied'
    }
    const closeForActions = () => closeCompletion(editor)
    editor.contentDOM.addEventListener(
      'hibi:editor-actions-open',
      closeForActions,
    )
    let disposed = false
    let detachInteractions = () => {}
    let interactionGeneration = 0
    const refreshInteractions = () => {
      const current = ++interactionGeneration
      detachInteractions()
      detachInteractions = () => {}
      if (!hasEditorInteractionProviders()) return
      void import('./editor-interactions')
        .then(({ attachEditorInteractions }) => {
          if (
            disposed ||
            current !== interactionGeneration ||
            !hasEditorInteractionProviders()
          )
            return
          detachInteractions = attachEditorInteractions({
            element: editor.contentDOM,
            positionAt: (x, y) => editor.posAtCoords({ x, y }, false),
            anchorAt: (position) => editor.coordsAtPos(position),
            selectionPosition: () => editor.state.selection.main.head,
            capture: captureInteraction,
            apply: applyInteraction,
            focus: () => editor.focus(),
            error: (error) => setInputError(String(error)),
          })
        })
        .catch((error) => setInputError(String(error)))
    }
    const unsubscribeInteractions =
      onEditorInteractionProvidersChanged(refreshInteractions)
    refreshInteractions()
    const unregisterSelection = registerEditorSelectionCapture(
      () => captureInteraction(editor.state.selection.main.head, true, true),
      (position) => captureInteraction(position, true, true),
    )
    const unregister = registerSourceView(
      editor,
      (raw) => {
        const anchor = bridge.snapshot().rawToEditor(raw)
        if (anchor !== null)
          editor.dispatch({
            selection: { anchor },
            effects: EditorView.scrollIntoView(anchor, {
              y: 'start',
              yMargin: 48,
            }),
          })
      },
      {
        toSource: (position) =>
          bridge.snapshot().editorToRaw(position) ?? position,
        toEditor: (position) => bridge.snapshot().rawToEditor(position),
      },
      resolveReference,
    )
    const unregisterViewApi = editorViewRegistry.register(
      document.tabId,
      viewId as ViewId,
      'source',
      {
        read: () => {
          const source = bridge.snapshot()
          if (view.current !== editor || !session.ownsCurrentSnapshot(source))
            return null
          const selection = editor.state.selection.main
          return {
            contentVersion: source.version,
            anchor: selection.anchor,
            head: selection.head,
            length: editor.state.doc.length,
          }
        },
        setSelection: (anchor, head) => {
          editor.dispatch({ selection: { anchor, head } })
          const selection = editor.state.selection.main
          return selection.anchor === anchor && selection.head === head
        },
        reveal: (position) => {
          editor.dispatch({ effects: EditorView.scrollIntoView(position) })
          return true
        },
      },
    )
    configureParser.current = () => {
      const id = parserOptions.current.codeLanguage
      const enabled = () =>
        codeLanguages
          .snapshot()
          .some(
            (entry) =>
              (entry.id === id || entry.aliases.includes(id ?? '')) &&
              entry.enabled,
          )
      const waiting = !!id && enabled() && !codeLanguages.resolve(id)
      setLanguageReady(!waiting)
      setLanguageError('')
      if (waiting)
        void codeLanguages.ensure(id).then((language) => {
          if (
            !disposed &&
            parserOptions.current.codeLanguage === id &&
            !language &&
            enabled()
          )
            setLanguageError(`Could not load the ${id} editor language.`)
        })
      editor.dispatch({ effects: language.reconfigure(markdown()) })
      formatting.current = sourceFormatting(
        editor,
        parserOptions.current.sourceFormat ??
          (parserOptions.current.markdownMode ? 'markdown' : null),
        parserOptions.current.supportsMedia,
        { undo: bridge.undo, redo: bridge.redo, state: session.state },
      )
      reportFormatting.current(formatting.current)
    }
    const unsubscribe = codeLanguages.subscribe(() => configureParser.current())
    configureParser.current()
    const measure = () => {
      if (!disposed) editor.requestMeasure()
    }
    measure()
    const finishFont = () => {
      if (disposed) return
      editor.requestMeasure({
        read: () => null,
        write: () => {
          if (!disposed) setFontReadyBridge(bridge)
        },
      })
    }
    void window.document.fonts
      .load('13px "Geist Mono"')
      .then(finishFont, finishFont)
    return () => {
      cancelAnimationFrame(compositionFrame)
      editor.contentDOM.removeEventListener('keydown', onTypingCommand, true)
      editor.contentDOM.removeEventListener(
        'compositionstart',
        startCompositionSignal,
        true,
      )
      editor.contentDOM.removeEventListener(
        'compositionend',
        endCompositionSignal,
      )
      removeTypingHistory()
      cancelCompletion()
      clearReferences('unavailable', false)
      sourceFind.current?.dispose()
      sourceFind.current = null
      referenceUsed.current = false
      referenceFailed.current = false
      unsubscribe()
      configureParser.current = () => {}
      disposed = true
      unsubscribeInteractions()
      unregisterSelection()
      formatting.current = null
      reportFormatting.current(null)
      unregister()
      unregisterViewApi()
      detachInteractions()
      editor.contentDOM.removeEventListener(
        'hibi:editor-actions-open',
        closeForActions,
      )
      actionScope.dispose()
      unregisterEdits()
      unregisterMountedEdits()
      unregisterProjection()
      removeAnnotations()
      detachSession()
      editor.destroy()
      view.current = null
    }
  }, [
    bridge,
    session,
    document.tabId,
    document.revision,
    requestFind,
    requestReference,
    resolveReference,
    clearReferences,
    viewId,
  ])

  useEffect(() => {
    if (disabled || !editTarget || !inputReady) {
      const editor = view.current
      if (editor) closeCompletion(editor)
    }
  }, [disabled, editTarget, inputReady])

  // Before paint and before focus moves here, a shown or targeted view catches up.
  useLayoutEffect(() => {
    bridge.setVisible(sourceVisible || editTarget)
  }, [bridge, sourceVisible, editTarget])

  useEffect(() => {
    const editor = view.current
    setExtensionError('')
    if (!editor) return
    let canceled = false
    const context = Object.freeze({ viewId: viewId as ViewId })
    void Promise.all(
      sourceExtensions.map(async (extension) => extension.create(context)),
    )
      .then((extensions) => {
        if (!canceled) {
          editor.dispatch({ effects: addons.current.reconfigure(extensions) })
          setInstalledExtensions({ bridge, extensions: sourceExtensions })
        }
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setExtensionError(String(error))
        }
      })
    return () => {
      canceled = true
    }
  }, [bridge, sourceExtensions, viewId])
  useEffect(
    () =>
      tabIndent.subscribe(() =>
        view.current?.dispatch({
          effects: indentation.current.reconfigure(
            sourceIndentation(tabIndent.snapshot().unit),
          ),
        }),
      ),
    [],
  )
  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure([
        EditorView.editable.of(!disabled && inputReady),
        EditorState.readOnly.of(disabled || !inputReady),
      ]),
    })
  }, [disabled, inputReady])

  useEffect(() => {
    // Publish readiness after CodeMirror configures input, before its next frame.
    ready.current(
      extensionError || languageError
        ? 'failed'
        : inputReady && (!waitForFont || fontReadyBridge === bridge)
          ? 'ready'
          : 'loading',
    )
  }, [
    bridge,
    inputReady,
    waitForFont,
    fontReadyBridge,
    extensionError,
    languageError,
  ])

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new bridge replaces the editor view.
  useEffect(() => {
    view.current?.dispatch({
      effects: numbers.current.reconfigure(
        showLineNumbers
          ? lineNumbers({
              domEventHandlers: {
                mousedown(view, line, event) {
                  event.preventDefault()
                  const text = view.state.doc.lineAt(line.from)
                  view.dispatch({
                    selection: { anchor: text.from, head: text.to },
                  })
                  view.focus()
                  return true
                },
              },
            })
          : [],
      ),
    })
  }, [bridge, showLineNumbers])

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new bridge replaces the editor view.
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const stopFind = () => {
      if (referenceUsed.current) sourceFind.current?.cancelFind()
      else {
        sourceFind.current?.dispose()
        sourceFind.current = null
      }
    }
    if (!findActive) {
      closeSearchPanel(editor)
      stopFind()
      findActions.current = []
      navigatingFind.current = false
      return
    }
    openSearchPanel(editor)
    const query = new SearchQuery({ search: findQuery, literal: true })
    editor.dispatch({ effects: setSearchQuery.of(query) })
    findActions.current = []
    navigatingFind.current = query.valid
    if (query.valid) requestFind('first')
    else {
      stopFind()
      find.current.report({ current: 0, total: 0 })
    }
  }, [bridge, findActive, findQuery, requestFind])

  useEffect(() => {
    if (handledFindMove.current === findMove.id) return
    handledFindMove.current = findMove.id
    if (findActive && view.current && findMove.id) {
      if (findActions.current.length >= 128) {
        find.current.report({
          current: 0,
          total: 0,
          error: 'Too many pending find commands. Wait for search to finish.',
        })
        return
      }
      findActions.current.push(findMove.direction)
      if (!navigatingFind.current) {
        navigatingFind.current = true
        requestFind(findActions.current.shift()!)
      }
    }
  }, [findActive, findMove, requestFind])

  return (
    <>
      {(extensionError || languageError || inputError) && (
        <DocumentNotice
          title={
            inputError
              ? 'Edit could not be applied'
              : 'Editor addon unavailable'
          }
          message={inputError || extensionError || languageError}
        >
          {!inputError && !extensionError && languageError && codeLanguage && (
            <Button onClick={() => void codeLanguages.retry(codeLanguage)}>
              Retry language
            </Button>
          )}
        </DocumentNotice>
      )}
      <div className="source-editor" ref={host} />
    </>
  )
}
