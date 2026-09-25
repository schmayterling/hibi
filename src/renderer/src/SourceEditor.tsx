import {
  acceptCompletion,
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  closeCompletion,
  completionStatus,
  pickedCompletion,
  startCompletion,
} from '@codemirror/autocomplete'
import { defaultKeymap, isolateHistory, selectAll } from '@codemirror/commands'
import {
  HighlightStyle,
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
  Compartment,
  EditorSelection,
  EditorState,
  Transaction,
} from '@codemirror/state'
import { EditorView, keymap, lineNumbers, placeholder } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentFormat, SourceExtension } from '../../addons/api'
import type {
  CompletionItem,
  CompletionRequest,
} from '../../shared/completions'
import { type DocumentState, MAX_DOCUMENT_BYTES } from '../../shared/desktop'
import { editedSource, sourceEditMatches } from '../../shared/document-edits'
import type { MarkdownReferenceSyntax } from '../../shared/document-worker-protocol'
import {
  type EditorContextAction,
  type EditorInteractionRequest,
  sameInteraction,
} from '../../shared/editor-interactions'
import { markdownLink } from '../../shared/markdown-link'
import { wikiHref } from '../../shared/note-links'
import type { RawEdit } from '../../shared/source-operations'
import {
  editorChangesFromSource,
  normalizedSource as normalizeSource,
} from '../../shared/source-projection'
import { Button } from '../../ui/Controls'
import { DocumentNotice } from '../../ui/DocumentNotice'
import { codeHighlighter, codeLanguages } from './code-languages'
import { completionBroker } from './completion-broker'
import { documentEdits } from './document-edits'
import { editorDocument } from './document-formats'
import { documentProjections } from './document-projections'
import { documentRuntime } from './document-runtime'
import { DocumentWorkerClient, type FindAction } from './document-worker-client'
import {
  hasEditorInteractionProviders,
  onEditorInteractionProvidersChanged,
} from './editor-interaction-presence'
import type { FindMove, FindStatus } from './FindBar'
import {
  observeSourceAnnotations,
  sourceAnnotationExtension,
} from './source-annotations'
import {
  formattingKeymap,
  type SourceFormatting,
  sourceFormatting,
} from './source-formatting'
import { createSourceSession, sourceEditorText } from './source-session'
import {
  registerSourceView,
  type SourceReferenceResult,
  type SourceReferenceSyntax,
} from './source-view'
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

const sameCompletionContext = (
  a: CompletionRequest,
  b: CompletionRequest | null,
) =>
  !!b &&
  a.view.documentId === b.view.documentId &&
  a.view.documentGeneration === b.view.documentGeneration &&
  a.view.viewId === b.view.viewId &&
  a.view.viewGeneration === b.view.viewGeneration &&
  a.contentVersion === b.contentVersion &&
  a.documentLength === b.documentLength &&
  a.selection.anchor === b.selection.anchor &&
  a.selection.head === b.selection.head

export function SourceEditor({
  document,
  viewId = 'default',
  editTarget,
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
  editTarget: boolean
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
  const editContext = useRef({ document, editTarget, disabled, inputReady })
  editContext.current = { document, editTarget, disabled, inputReady }
  const exactChanges = useRef<readonly RawEdit[] | undefined>(undefined)
  const editable = useRef(new Compartment())
  const numbers = useRef(new Compartment())
  const addons = useRef(new Compartment())
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
    const captureCompletion = (
      trigger: CompletionRequest['trigger'],
    ): CompletionRequest | null => {
      const context = editContext.current
      const active = documentRuntime.get(document.tabId)
      const target = documentRuntime.captureActiveView()
      const owner = documentRuntime.captureDocument(document.tabId)
      const selected = editor.state.selection
      if (
        view.current !== editor ||
        !editor.hasFocus ||
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
        !selected.main.empty
      )
        return null
      const snapshot = bridge.snapshot()
      if (snapshot.version !== active.contentVersion) return null
      const pos = selected.main.head
      return {
        view: target,
        contentVersion: snapshot.version,
        editor: 'source',
        documentLength: editor.state.doc.length,
        selection: { anchor: selected.main.anchor, head: pos },
        before: editor.state.sliceDoc(Math.max(0, pos - 256), pos),
        after: editor.state.sliceDoc(
          pos,
          Math.min(editor.state.doc.length, pos + 256),
        ),
        trigger,
      }
    }
    const captureInteraction = (
      position: number,
    ): EditorInteractionRequest | null => {
      const context = editContext.current
      const active = documentRuntime.get(document.tabId)
      const target = documentRuntime.captureActiveView()
      const owner = documentRuntime.captureDocument(document.tabId)
      const selected = editor.state.selection
      if (
        view.current !== editor ||
        !editor.hasFocus ||
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
          selected.main.to,
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
            view.dispatch({
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
          },
        }
        pending.options.set(item, option)
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
          autocompletion({ override: [sourceCompletions] }),
          keymap.of([{ key: 'Tab', run: acceptCompletion }]),
          EditorView.domEventHandlers({
            beforeinput(event) {
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
    const removeAnnotations = observeSourceAnnotations(editor)
    const unregisterProjection = documentProjections.register(
      'source',
      (cached) => {
        const context = editContext.current
        const current = editorDocument.get()
        if (
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
    const unregisterEdits = documentEdits.register((request) => {
      const context = editContext.current
      const current = editorDocument.get()
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
      if (!context.editTarget)
        return {
          status: 'unsupported-view',
          message: 'Open source view to apply these edits.',
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
      let expected: string
      try {
        const source = snapshot.materialize()
        expected = editedSource(source, request.changes, MAX_DOCUMENT_BYTES)
        if (expected === source)
          return { status: 'applied', contentVersion: current.contentVersion }
      } catch (error) {
        return { status: 'invalid', message: String(error) }
      }
      if (normalizeSource(expected) === editor.state.doc.toString())
        return {
          status: 'invalid',
          message:
            'Edits must keep line-ending pairs intact. Use a whole-source transform to change only line endings.',
        }
      let changes: readonly RawEdit[]
      try {
        changes = editorChangesFromSource(snapshot, request.changes)
      } catch (error) {
        return { status: 'invalid', message: String(error) }
      }
      const transaction = editor.state.update({
        changes,
        annotations: [
          isolateHistory.of('full'),
          Transaction.userEvent.of('input.addon'),
        ],
      })
      if (transaction.newDoc.toString() !== normalizeSource(expected))
        return {
          status: 'invalid',
          message: 'An editor extension changed this edit.',
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
        contentVersion: editorDocument.get()!.contentVersion,
      }
    })
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
          })
        })
        .catch((error) => setInputError(String(error)))
    }
    const unsubscribeInteractions =
      onEditorInteractionProvidersChanged(refreshInteractions)
    refreshInteractions()
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
      formatting.current = null
      reportFormatting.current(null)
      unregister()
      detachInteractions()
      editor.contentDOM.removeEventListener(
        'hibi:editor-actions-open',
        closeForActions,
      )
      actionScope.dispose()
      unregisterEdits()
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

  useEffect(() => {
    const editor = view.current
    setExtensionError('')
    if (!editor) return
    let canceled = false
    void Promise.all(
      sourceExtensions.map(async (extension) => extension.create()),
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
  }, [bridge, sourceExtensions])
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
