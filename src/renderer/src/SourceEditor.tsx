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
import { indentLess, indentMore, isolateHistory } from '@codemirror/commands'
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
  SearchQuery,
  search,
  setSearchQuery,
} from '@codemirror/search'
import {
  ChangeSet,
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  type Text,
  Transaction,
  type TransactionSpec,
} from '@codemirror/state'
import {
  type Command,
  EditorView,
  keymap,
  lineNumbers,
  placeholder,
  ViewPlugin,
} from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { tags } from '@lezer/highlight'
import type { MarkdownParser } from '@lezer/markdown'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  DocumentFormat,
  FormattedExtension,
  SourceExtension,
} from '../../addons/api'
import { commands as sourceCommands } from '../../addons/sdk-source'
import {
  type CompletionItem,
  type CompletionRequest,
  safeCompletionContext,
  sameCompletionContext,
  sourceProseAllowed,
  type TypingContext,
} from '../../shared/completions'
import type { DocumentState } from '../../shared/desktop'
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
import { errorMessage } from '../../shared/errors'
import type { ViewId, ViewTarget } from '../../shared/foundation-contracts'
import type { BoundaryConfig } from '../../shared/markdown-boundary-syntax'
import { protectMarkdownParser } from '../../shared/markdown-flavor-guard'
import { markdownLink } from '../../shared/markdown-link'
import { wikiHref } from '../../shared/note-links'
import type { RawEdit } from '../../shared/source-operations'
import { editorChangesFromSource } from '../../shared/source-projection'
import type { SourceMatch } from '../../shared/source-search'
import { Button } from '../../ui/Controls'
import { DocumentNotice } from '../../ui/DocumentNotice'
import { uncovered } from './chunked-markdown'
import { observeClipboard } from './clipboard-source'
import { codeHighlighter, codeLanguages } from './code-languages'
import { setCodeExtents } from './code-placeholders'
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
import type { FindAction } from './document-worker-client'
import {
  connectDocumentWorker,
  type DocumentWorkerConnection,
} from './document-worker-pool'
import { registerEditorSelectionCapture } from './editor-command-targets'
import { captureEditorFocus } from './editor-focus-restore'
import {
  hasEditorInteractionProviders,
  onEditorInteractionProvidersChanged,
} from './editor-interaction-presence'
import { editorViewRegistry } from './editor-view-api'
import type { FindMove, FindStatus } from './FindBar'
import { flavorSyntax } from './flavor-syntax'
import { flavors as markdownFlavors } from './flavors'
import { definitionOf } from './formatted/footnote-definitions'
import { linkControls } from './formatted/link-controls'
import {
  followsLink,
  formattedDocument,
  formattedFollowLink,
  formattedRefresh,
  formattedRenderInputs,
  showMarkdownMarkers,
} from './formatted-contributions'
import { formattedReferences } from './formatted-references'
import { formattedSelectionPreview } from './formatted-selection-text'
import { formattedLiteralEdits } from './formatted-source-edits'
import { formattedSyntax } from './formatted-syntax'
import { tabIndent } from './indentation'
import { formattedTabIndents, livePreview } from './live-preview'
import { mountedDocumentEdits } from './mounted-document-edits'
import {
  observeSourceAnnotations,
  sourceAnnotationExtension,
} from './source-annotations'
import {
  formattedFindViewport,
  formattedFindWindow,
  movedFindWindow,
  renderedFindHighlights,
  sourceFindHighlights,
} from './source-find'
import {
  formattingKeymap,
  type SourceFormatting,
  sourceFormatting,
  storedMarkInput,
  wholeSelectionInput,
} from './source-formatting'
import { rejectedInput } from './source-formatting-actions'
import { sourceIndentation } from './source-indent'
import {
  createSourceSession,
  editSpec,
  failedEditGuard,
  failingParts,
  firstStateRead,
  reconfiguration,
  sourceEditorTextCooperatively,
  sourceEditTransaction,
  transactionState,
} from './source-session'
import {
  registerSourceView,
  type SourceReferenceResult,
  type SourceReferenceSyntax,
} from './source-view'
import { textProjection } from './text-projection'

/** Each mounted view's bridge to its document session. */
const bridges = new WeakMap<
  EditorView,
  ReturnType<typeof createSourceSession>
>()
/** The whole source after editor changes, exactly as the mounted view commits them. */
export const sourceAfter = (view: EditorView, changes: readonly RawEdit[]) =>
  bridges.get(view)?.sourceAfter(changes) ?? null

/** The line at a view's top, and where its block starts relative to the top. */
function placeOf(view: EditorView) {
  const height = view.scrollDOM.getBoundingClientRect().top - view.documentTop
  const line = view.lineBlockAtHeight(height)
  return { top: line.from, margin: line.top - height }
}

/** Properties whose transitions move or resize a pane, as when it slides in and widens. */
const paneMotion = new Set([
  'width',
  'min-width',
  'max-width',
  'flex-basis',
  'inset',
  'left',
  'right',
  'transform',
  'translate',
])

/** Running pane motion around an element, and how long the longest still lasts. */
function paneMotionAround(element: Element) {
  const transitions: Animation[] = []
  let left = 0
  for (let node: Element | null = element; node; node = node.parentElement)
    for (const animation of node.getAnimations()) {
      if (
        !(animation instanceof CSSTransition) ||
        animation.playState !== 'running' ||
        !paneMotion.has(animation.transitionProperty)
      )
        continue
      const end = animation.effect?.getComputedTiming().endTime,
        now = animation.currentTime
      if (typeof end !== 'number' || typeof now !== 'number') continue
      // In real time; a stopped one never ends.
      const remaining = (end - now) / animation.playbackRate
      if (!Number.isFinite(remaining) || remaining <= 0) continue
      transitions.push(animation)
      left = Math.max(left, remaining)
    }
  return { transitions, left }
}

/** Input in the scroller, its gutters included, is the user's own scrolling. */
const scrollInput = ['keydown', 'pointerdown', 'touchstart', 'wheel'] as const

/**
 * A view built off screen scrolls to its kept place with estimated line
 * heights, and CodeMirror then anchors whichever line those put at the top.
 * Once it is on screen and its pane has stopped moving and resizing, the kept
 * line goes back to its kept offset, in a measure that changes no heights:
 * when heights change, CodeMirror moves the view to hold the line it anchored
 * before them. Input or any other scroll ends this.
 */
function keptPlaceScroll(top: number, margin: number) {
  let state: 'waiting' | 'aligning' | 'holding' | 'done' = 'waiting',
    moved = false,
    // The scroll position the view was aligned at, while it holds the place.
    held = 0,
    // The view's own scroll there, first from its construction.
    scrolling = true,
    scrolled = false,
    settling: ReturnType<typeof setTimeout> | null = null,
    // The first wait sets when waiting ends, whatever moves after it.
    deadline: number | null = null
  const stop = () => {
    state = 'done'
    if (settling) clearTimeout(settling)
    settling = null
  }
  const align = {
    // Only a line CodeMirror has laid out has a measured position.
    read: (view: EditorView) =>
      top < view.viewport.from || top > view.viewport.to
        ? null
        : view.documentTop +
          view.lineBlockAt(top).top -
          view.scrollDOM.getBoundingClientRect().top,
    write: (offset: number | null, view: EditorView) => {
      if (state !== 'aligning') return
      if (offset === null) {
        // Scroll there once, which lays it out; the measure after aligns it.
        if (scrolled) return stop()
        scrolled = scrolling = true
        state = 'waiting'
        queueMicrotask(() => {
          if (state !== 'done')
            view.dispatch({
              effects: EditorView.scrollIntoView(top, {
                y: 'start',
                yMargin: margin,
              }),
            })
        })
        return
      }
      if (moved) {
        moved = false
        queueMicrotask(() => view.requestMeasure(align))
        return
      }
      state = 'holding'
      if (Math.abs(offset - margin) >= 0.5)
        view.scrollDOM.scrollTop += offset - margin
      held = view.scrollDOM.scrollTop
    },
  }
  const begin = (view: EditorView) => {
    if (state !== 'waiting' || scrolling || settling) return
    // Its lines wrap again when the pane reaches its last width. The wait
    // ends with that motion, or at the latest when it was due to end, and
    // holds the view only weakly.
    const { transitions, left } = paneMotionAround(view.dom)
    const now = performance.now()
    if (left > 0) deadline ??= now + left
    const wait = deadline === null ? 0 : Math.min(left, deadline - now)
    if (wait > 0) {
      const owner = new WeakRef(view)
      const wake = () => {
        if (!settling) return
        clearTimeout(settling)
        settling = null
        const view = owner.deref()
        if (view) begin(view)
      }
      settling = setTimeout(wake, wait)
      for (const transition of transitions) transition.finished.then(wake, wake)
      return
    }
    state = 'aligning'
    moved = false
    view.requestMeasure(align)
  }
  const extension: Extension = [
    EditorView.scrollHandler.of((view, range, options) => {
      if (range.head !== top || options.yMargin !== margin) stop()
      else {
        scrolling = false
        // On screen, this scroll lays the line out; the next measure aligns it.
        if (view.inView) queueMicrotask(() => begin(view))
      }
      return false
    }),
    // A held view scrolled anywhere else, as by its scrollbar or a script,
    // is the user's again; this runs before the place is recorded.
    EditorView.domEventHandlers({
      scroll: (_event, view) => {
        if (
          state === 'holding' &&
          Math.abs(view.scrollDOM.scrollTop - held) > 1
        )
          stop()
      },
    }),
    ViewPlugin.define((view) => {
      const options = { capture: true, passive: true }
      for (const type of scrollInput)
        view.scrollDOM.addEventListener(type, stop, options)
      return {
        destroy() {
          stop()
          for (const type of scrollInput)
            view.scrollDOM.removeEventListener(type, stop, options)
        },
        update(update) {
          if (update.docChanged) top = update.changes.mapPos(top, 1)
          if (update.heightChanged || update.geometryChanged) moved = true
          // A measure on screen; its own height changes still move the view.
          if (
            update.transactions.length ||
            !update.view.inView ||
            !(
              update.geometryChanged ||
              update.viewportChanged ||
              update.heightChanged
            )
          )
            return
          const { view } = update
          if (state === 'holding') {
            // Anything that scrolled the view ends the hold. CodeMirror can
            // also move the kept line without scrolling, when it estimates
            // the lines above it again, and the line goes back.
            if (Math.abs(view.scrollDOM.scrollTop - held) > 1) return stop()
            state = 'aligning'
            moved = false
            queueMicrotask(() => view.requestMeasure(align))
          } else queueMicrotask(() => begin(view))
        },
      }
    }),
  ]
  /** Whether the view is on its way to, or holding, the kept place. */
  return { extension, pending: () => state !== 'done' }
}

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

/** An editor feature. `fail` reports its failure and removes it from every editor; input waits for one without it. */
type EditorFeature = (SourceExtension | FormattedExtension) & {
  fail?: (error: unknown) => void
}
type InstalledFeature = { feature: EditorFeature; extension: Extension }

/** Input does not wait for features this editor removed after they failed to leave. */
const installedFor = (
  installed: readonly EditorFeature[],
  wanted: readonly EditorFeature[],
  failed: WeakSet<EditorFeature>,
) =>
  installed === wanted ||
  (wanted.every((feature) => installed.includes(feature)) &&
    installed.every(
      (feature) => wanted.includes(feature) || failed.has(feature),
    ))

const featureExtensions = (
  installed: readonly InstalledFeature[],
  formatted: boolean,
) => {
  const extensions = installed.map(({ extension }) => extension)
  // Cached renderers must see the fields installed with their input.
  return [extensions, formatted ? formattedRenderInputs.of(extensions) : []]
}

/**
 * Reports the features an edit fails with, which then leave every editor,
 * and returns the others. A feature input waits for stays; the edit fails.
 */
function isolateFeatures(
  start: EditorState,
  edit: readonly Transaction[] | readonly TransactionSpec[],
  installed: readonly InstalledFeature[],
  compartment: Compartment,
  formatted: boolean,
) {
  const failing = failingParts(
    start,
    edit,
    installed.filter(({ feature }) => feature.fail),
    (kept) =>
      compartment.reconfigure(
        featureExtensions(
          installed.filter((part) => !part.feature.fail || kept.includes(part)),
          formatted,
        ),
      ),
  )
  for (const { part, error } of failing)
    part.feature.fail?.(
      new Error(`${part.feature.id}: ${errorMessage(error)}`, { cause: error }),
    )
  return installed.filter(
    (part) => !failing.some((failure) => failure.part === part),
  )
}

export function SourceEditor({
  document,
  viewId = 'default',
  sessionViewId = viewId,
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
  onEditLink,
  onLink,
  presentation = 'source',
  markers = true,
  spellCheck = false,
  flavors,
  documentRevision = 0,
  keepPlace = false,
}: {
  document: DocumentState
  viewId?: string
  sessionViewId?: string
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
  sourceExtensions: readonly EditorFeature[]
  onFormatting: (formatting: SourceFormatting | null) => void
  onLink: (href: string) => void
  onEditLink?: (
    capture: ReturnType<SourceFormatting['capture']>,
  ) => Promise<void>
  /** Formatted renders Markdown in place over the same source session. */
  presentation?: 'source' | 'formatted'
  /** Formatted view: show the Markdown markers under the caret. */
  markers?: boolean
  spellCheck?: boolean
  /** The document's Markdown flavor ids, which select syntax and formatted contributions. */
  flavors?: readonly string[]
  /** Formatted view: the document revision for widgets such as media. */
  documentRevision?: number
  /** A view that unmounts keeps its selection and scroll position, mapped through edits, for the next. */
  keepPlace?: boolean
}) {
  const formatted = presentation === 'formatted'
  const kind = formatted ? 'rich' : 'source'
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
    flavors,
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
    flavors,
  }
  const flavorKey = flavors?.join(',')
  const configureParser = useRef(() => {})
  const configureFlavors = useRef(() => {})
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: flavor configuration reads the current flavors through parserOptions.
  useEffect(() => {
    configureFlavors.current()
  }, [flavorKey])
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const restoreFocus = useRef<(() => void) | null>(null)
  const keepingPlace = useRef(keepPlace)
  keepingPlace.current = keepPlace
  // A hidden view's layout goes stale, and a pane that hides can already be
  // relaid out when its effects run, so a view keeps the place it last showed.
  const shown = useRef(false)
  const shownPlace = useRef<ReturnType<typeof placeOf> | null>(null)
  // Effects follow the actual view, which mounts after source preparation.
  const [mountedView, setMountedView] = useState<EditorView | null>(null)
  const [installedExtensions, setInstalledExtensions] = useState<{
    bridge: ReturnType<typeof createSourceSession>
    extensions: readonly EditorFeature[]
  } | null>(null)
  const [extensionError, setExtensionError] = useState('')
  const [languageError, setLanguageError] = useState('')
  const [languageReady, setLanguageReady] = useState(!codeLanguage)
  const [inputError, setInputError] = useState('')
  const [bridgeRetry, retryBridge] = useState(0)
  const session = documentRuntime.session(document.tabId)!
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry refreshes a bridge whose snapshot went stale before attachment.
  const bridge = useMemo(
    () => createSourceSession(session, sessionViewId),
    [session, sessionViewId, bridgeRetry, document.tabId, document.revision],
  )
  // An echo this bridge's view could not show; Retry rebuilds the view.
  const [failedEcho, setFailedEcho] = useState<{
    bridge: typeof bridge
    message: string
  } | null>(null)
  const echoError = failedEcho?.bridge === bridge ? failedEcho.message : ''
  const [preparedText, setPreparedText] = useState<{
    bridge: ReturnType<typeof createSourceSession>
    text: Text
  } | null>(null)
  const [fontReadyBridge, setFontReadyBridge] = useState<ReturnType<
    typeof createSourceSession
  > | null>(null)
  const failedFeatures = useRef(new WeakSet<EditorFeature>())
  const inputReady =
    preparedText?.bridge === bridge &&
    installedExtensions?.bridge === bridge &&
    installedFor(
      installedExtensions.extensions,
      sourceExtensions,
      failedFeatures.current,
    ) &&
    languageReady &&
    !echoError
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
  /** The features in `addons`, with what each created. */
  const installed = useRef<readonly InstalledFeature[]>([])
  const indentation = useRef(new Compartment())
  const display = useRef(new Compartment())
  const findHighlights = useRef(new Compartment())
  // Later changes reconfigure the display compartment without a new editor.
  const displayOptions = useRef({ markers, spellCheck, documentRevision })
  displayOptions.current = { markers, spellCheck, documentRevision }
  const find = useRef({
    active: findActive,
    query: findQuery,
    report: onFindStatus,
  })
  const sourceFind = useRef<DocumentWorkerConnection | null>(null)
  const referenceUsed = useRef(false)
  const referenceFailed = useRef(false)
  const referenceQueue = useRef<ReferenceJob[]>([])
  const activeReference = useRef<ReferenceJob | null>(null)
  const nextReference = useRef(() => {})
  const repeatFind = useRef<(action?: FindAction, page?: number) => void>(
    () => {},
  )
  const findCoverage = useRef({ query: '', version: -1, total: 0, config: '' })
  const findActions = useRef<FindAction[]>([])
  const navigatingFind = useRef(false)
  const applyingFind = useRef(false)
  const renderedConfig = useRef<
    ((state: EditorState) => BoundaryConfig | null) | null
  >(null)
  const findConfig = useRef('')
  const renderedRefused = useRef({
    session,
    query: '',
    version: -1,
    config: '',
  })
  const renderedPage = useRef<{
    from: number
    to: number
    matches: SourceMatch[]
  } | null>(null)
  const lastFindAction = useRef<FindAction>(null)
  const handledFindMove = useRef(findMove.id)
  const ready = useRef(onReady)
  const formatting = useRef<SourceFormatting | null>(null)
  const reportFormatting = useRef(onFormatting)
  const openLink = useRef(onLink)
  const editLink = useRef(onEditLink)
  editLink.current = onEditLink
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
      sourceFind.current ??= connectDocumentWorker(session, {
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
            known.version === session.snapshot().version &&
            known.config === findConfig.current
          find.current.report({
            current: 0,
            total: complete ? known.total : 0,
            pending: !complete,
          })
        },
        error: (message, reason) => {
          if (reason === 'unsupported' && renderedPage.current) {
            renderedRefused.current = {
              session,
              query: find.current.query,
              version: session.snapshot().version,
              config: findConfig.current,
            }
            repeatFind.current(lastFindAction.current)
            return
          }
          referenceFailed.current = true
          clearReferences('unavailable', false)
          findActions.current = []
          navigatingFind.current = false
          find.current.report({ current: 0, total: 0, error: message })
        },
        result: (
          location,
          action,
          highlightStarts,
          query,
          highlights,
          mode,
        ) => {
          const current = view.current
          if (!current || !find.current.active || query !== find.current.query)
            return
          findCoverage.current = {
            query: find.current.query,
            version: session.snapshot().version,
            total: location.total,
            config: findConfig.current,
          }
          const target =
            action === 'previous'
              ? location.previous
              : action
                ? location.next
                : null
          const page = mode === 'rendered' ? renderedPage.current : null
          if (page && highlights) page.matches.push(...highlights.matches)
          if (target || highlightStarts || (page && highlights)) {
            applyingFind.current = true
            try {
              current.dispatch({
                ...(target
                  ? {
                      selection: {
                        anchor: target.match.from,
                        head: target.match.to,
                      },
                    }
                  : {}),
                effects: [
                  // A match wider than the view shows its start.
                  ...(target
                    ? [
                        EditorView.scrollIntoView(
                          EditorSelection.range(
                            target.match.to,
                            target.match.from,
                          ),
                        ),
                      ]
                    : []),
                  ...(page && highlights
                    ? [
                        findHighlights.current.reconfigure([
                          renderedFindHighlights(
                            page.matches,
                            (target?.rank ?? location.current) > 0,
                            current.state.doc,
                          ),
                          formattedFindWindow,
                        ]),
                      ]
                    : highlightStarts
                      ? [
                          findHighlights.current.reconfigure([
                            sourceFindHighlights(
                              find.current.query,
                              current.state.doc,
                              highlightStarts,
                            ),
                            formatted ? formattedFindWindow : [],
                          ]),
                        ]
                      : []),
                ],
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
          } else if (page && highlights?.next != null)
            repeatFind.current(null, highlights.next)
        },
      })
      return sourceFind.current
    },
    [session, clearReferences, referenceCurrent, formatted],
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
  // Rendered reference labels resolve again with other syntax.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the syntax the resolver reads changed.
  useEffect(() => {
    if (formatted)
      view.current?.dispatch({ effects: formattedRefresh.of(null) })
  }, [formatted, referenceSyntax, markdownMode])
  const requestFind = useCallback(
    function requestFind(action: FindAction = null, page?: number) {
      const editor = view.current
      if (!editor || !find.current.active || !find.current.query) return
      const selection = editor.state.selection.main
      const candidate = renderedConfig.current?.(editor.state) ?? null
      const key = JSON.stringify(candidate)
      if (key !== findConfig.current) page = undefined
      findConfig.current = key
      const refused = renderedRefused.current
      const config =
        refused.session === session &&
        refused.query === find.current.query &&
        refused.version === session.snapshot().version &&
        refused.config === key
          ? null
          : candidate
      const shown =
        page === undefined || !renderedPage.current
          ? config
            ? formattedFindViewport(editor)
            : editor.viewport
          : renderedPage.current
      const viewport = { from: page ?? shown.from, to: shown.to }
      if (page === undefined) {
        lastFindAction.current = action
        renderedPage.current = config
          ? { from: shown.from, to: shown.to, matches: [] }
          : null
      }
      getWorker().find(
        find.current.query,
        action === 'first' ? 0 : Math.min(selection.from, selection.to),
        action === 'first' ? 0 : Math.max(selection.from, selection.to),
        action,
        config ? { mode: 'rendered', config, viewport } : {},
      )
    },
    [getWorker, session],
  )
  repeatFind.current = requestFind

  useEffect(() => {
    const controller = new AbortController()
    setPreparedText(null)
    const current = () =>
      documentRuntime.session(document.tabId) === session &&
      session.ownsCurrentSnapshot(bridge.snapshot())
    void sourceEditorTextCooperatively(bridge.snapshot(), {
      signal: controller.signal,
      isCurrent: current,
    })
      .then((text) => {
        if (
          controller.signal.aborted ||
          documentRuntime.session(document.tabId) !== session
        )
          return
        if (!text || !current()) {
          retryBridge((retry) => retry + 1)
          return
        }
        setPreparedText({ bridge, text })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setExtensionError(String(error))
      })
    return () => controller.abort()
  }, [bridge, session, document.tabId])

  useEffect(() => {
    if (!host.current || preparedText?.bridge !== bridge) return
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
    // The formatted view owns its syntax tree, kept across language reconfigurations.
    const syntax = formattedSyntax(
      formatted
        ? {
            boundaries: {
              request: (config, receive, declined, from, baseVersion) => {
                if (bridge.isCurrent())
                  getWorker().boundaries(
                    config,
                    receive,
                    declined,
                    from,
                    baseVersion,
                  )
                else declined('stale')
              },
              release: (retain) =>
                sourceFind.current?.releaseBoundaries(retain),
            },
          }
        : {},
    )
    renderedConfig.current = formatted ? syntax.config : null
    renderedRefused.current = { session, query: '', version: -1, config: '' }
    const tree = (state: EditorState) =>
      formatted ? syntax.tree(state) : syntaxTree(state)
    // Flavor syntax extends only the Markdown parser.
    const flavorConfigs = () =>
      parserOptions.current.markdownMode
        ? markdownFlavors
            .snapshot()
            .filter(
              (flavor) =>
                !parserOptions.current.flavors ||
                parserOptions.current.flavors.includes(flavor.id),
            )
            .flatMap((flavor) => flavorSyntax(flavor) ?? [])
        : []
    /** The flavor syntax the source parser was configured with. */
    let parsedFlavors: ReturnType<typeof flavorConfigs> = []
    const markdown = () => {
      const {
        markdownMode,
        markdownLanguage,
        sourceLanguage,
        codeLanguage,
        label,
      } = parserOptions.current
      if (formatted)
        return [
          storedMarkInput,
          wholeSelectionInput,
          livePreview(syntax, { flavors: parserOptions.current.flavors }),
          keymap.of(
            formattingKeymap((id) => formatting.current?.run(id) ?? false),
          ),
          EditorView.contentAttributes.of({
            'aria-label': 'Document editor',
            'aria-description': 'Press Escape, then Tab, to leave the editor.',
          }),
          // CodeMirror only marks read-only views; like the rich editor, also say when editing resumes.
          EditorView.contentAttributes.of((view) => ({
            'aria-readonly': String(view.state.readOnly),
          })),
        ]
      parsedFlavors = flavorConfigs()
      const support =
        markdownMode && !(codeLanguage && !codeLanguages.resolve(codeLanguage))
          ? markdownLanguage?.({
              codeLanguages: codeLanguages.resolve,
            })
          : undefined
      if (support)
        support.language.parser = protectMarkdownParser(
          support.language.parser as MarkdownParser,
          parsedFlavors,
        )
      return [
        markdownMode
          ? (support ?? [])
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
    // A note that shrank since its view left still gets the place it kept.
    const place = bridge.place()
    const selection = place?.selection ?? bridge.selection()
    const restore = place && keptPlaceScroll(place.top, place.margin)
    // Until it gets there, a restored view's place is the one it kept.
    shownPlace.current = place && { top: place.top, margin: place.margin }
    const record = (editor: EditorView) => {
      if (shown.current && editor.inView && !restore?.pending())
        shownPlace.current = placeOf(editor)
    }
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
    let pendingSyntax: { update: () => void; cancel: () => void } | null = null
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
    const completionParsed = () => {
      if (!formatted || !parserOptions.current.markdownMode) return true
      const state = editor.state
      const line = state.doc.lineAt(state.selection.main.head)
      return line.length > 16384 || !uncovered(tree(state), line.from, line.to)
    }
    const proseAt = (
      state: EditorState,
      markdownMode = parserOptions.current.markdownMode,
    ) => {
      const pos = state.selection.main.head
      if (
        !markdownMode ||
        // The formatted view's tree knows the blocks around the caret past
        // the prefix the source view reads as text.
        (formatted
          ? pos <= 16384 && !sourceProseAllowed(state.sliceDoc(0, pos))
          : pos > 16384 || !sourceProseAllowed(state.sliceDoc(0, pos)))
      )
        return null
      const line = state.doc.lineAt(pos)
      if (
        line.length > 16384 ||
        /^\s*\//.test(line.text) ||
        /<\/?[a-z!]/i.test(line.text)
      )
        return null
      const parsed = formatted
        ? tree(state)
        : ensureSyntaxTree(state, line.to, 2)
      if (
        parsed?.type.name !== 'Document' ||
        (formatted && uncovered(parsed, line.from, line.to))
      )
        return null
      let from = line.from,
        to = line.to,
        excluded = false
      parsed.iterate({
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
        editor: kind,
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
      const from = selected.main.from
      const selectedText = formatted
        ? formattedSelectionPreview(
            editor.state,
            syntax,
            from,
            selected.main.to,
            toolbarSelection ? '\n' : '',
          )
        : editor.state
            .sliceDoc(from, Math.min(selected.main.to, from + 256))
            .replace(/[\uD800-\uDBFF]$/, '')
      if (selectedText === null) return null
      return {
        view: target,
        contentVersion: snapshot.version,
        editor: kind,
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
        selectedText,
      }
    }
    const cancelCompletion = () => {
      pendingSyntax?.cancel()
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
    const sourceCompletions = async (context: CompletionContext) => {
      if (!completionBroker.hasProviders()) return null
      const trigger: CompletionRequest['trigger'] | null = context.explicit
        ? { kind: 'explicit' }
        : typed?.doc === context.state.doc && typed.pos === context.pos
          ? { kind: 'input', character: typed.character }
          : null
      if (!trigger) return null
      const initial = captureCompletion(trigger)
      if (!initial) return null
      // A jump can reach a chunk before its idle parse. Wait for that parse,
      // then capture the current tree instead of caching missing prose.
      const request = completionParsed()
        ? initial
        : await new Promise<CompletionRequest | null>((resolve) => {
            cancelCompletion()
            const finish = (request: CompletionRequest | null) => {
              if (pendingSyntax !== pending) return
              pendingSyntax = null
              resolve(request)
            }
            const pending = {
              cancel: () => finish(null),
              update: () => {
                if (context.aborted) finish(null)
                else if (completionParsed()) {
                  const current = captureCompletion(trigger)
                  finish(
                    sameCompletionContext(initial, current) ? current : null,
                  )
                }
              },
            }
            pendingSyntax = pending
            context.addEventListener('abort', pending.cancel, {
              onDocChange: true,
            })
          })
      if (!request || context.aborted) return null
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
    /** Open the link at a position, as a modified click on it does. */
    const followLink = (
      view: EditorView,
      position: number,
      wikiTarget?: string,
    ) => {
      if (
        !parserOptions.current.markdownMode ||
        !parserOptions.current.linksEnabled
      )
        return false
      if (wikiTarget !== undefined) {
        if (!wikiTarget) return false
        openLink.current(wikiHref(wikiTarget))
        return true
      }
      // The formatted view also follows bare URLs, which it shows as links.
      const bare = (node: SyntaxNode) =>
        formatted &&
        node.name === 'URL' &&
        !['Link', 'Autolink', 'Image', 'LinkReference'].includes(
          node.parent?.name ?? '',
        )
      // Footnote references there move to their definitions.
      const links = formatted
        ? ['Link', 'Autolink', 'FootnoteReference']
        : ['Link', 'Autolink']
      const linkAt = (side: -1 | 1) => {
        let node = tree(view.state).resolveInner(position, side)
        while (node.parent && !links.includes(node.name))
          if (bare(node)) return node
          else node = node.parent
        return links.includes(node.name) ? node : null
      }
      // The formatted view also looks after the position, where a table cell
      // gives the start of the link clicked in it.
      const node = linkAt(-1) ?? (formatted ? linkAt(1) : null)
      if (!node) {
        let parent = tree(view.state).resolveInner(position, -1)
        while (parent.parent) {
          if (/code|frontmatter/i.test(parent.name)) return false
          parent = parent.parent
        }
        const line = view.state.doc.lineAt(position)
        for (const match of line.text.matchAll(/!?\[\[([^\]\r\n]+)\]\]/g)) {
          const from = line.from + match.index
          if (position < from || position > from + match[0].length) continue
          const target = (match[1] ?? '').split('|')[0]?.trim() ?? ''
          if (!target) return false
          openLink.current(wikiHref(target))
          return true
        }
        return false
      }
      if (node.name === 'FootnoteReference') {
        const label = node.getChild('FootnoteLabel')
        const at =
          label &&
          definitionOf(view.state, view.state.sliceDoc(label.from, label.to))
        if (at == null) return false
        view.dispatch({
          selection: { anchor: at },
          effects: EditorView.scrollIntoView(at, { y: 'start', yMargin: 48 }),
          userEvent: 'select',
        })
        view.focus()
        return true
      }
      const target = markdownLink(
        view.state.sliceDoc(node.from, node.to),
        node.name === 'URL',
      )
      if (!target) return false
      const syntax = parserOptions.current.referenceSyntax
      if ('label' in target) {
        if (!syntax) return false
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
        if (!activeReference.current) sourceFind.current?.releaseMetadata()
      }
      openLink.current(target.href)
      return true
    }
    installed.current = []
    /** While typing is made into an edit: the first transaction made, once there is one. */
    let inputEdit: Transaction | null | undefined
    /**
     * Rejects input that failed, with the features named that it failed with
     * when `edit` is replayed from `start`. The DOM may still show what it left
     * out; an update could fail again, so setState draws the state as it is.
     */
    const reject = (
      view: EditorView,
      error: unknown,
      edit?: readonly Transaction[] | readonly TransactionSpec[],
      start = view.state,
    ) => {
      setInputError(error instanceof Error ? error.message : String(error))
      const kept = edit
        ? isolateFeatures(
            start,
            edit,
            installed.current,
            addons.current,
            formatted,
          )
        : installed.current
      for (const { feature } of installed.current)
        if (!kept.some((part) => part.feature === feature))
          failedFeatures.current.add(feature)
      // A composition must keep the note's text: CodeMirror redraws text that
      // differs, which ends the composition, and the IME then starts over
      // beside it. Without the features named, the edit is made again, in the
      // same update. The features leave first, so their extenders do not run.
      if (
        view.compositionStarted &&
        edit &&
        start === view.state &&
        kept.length < installed.current.length
      ) {
        const reinstall = reconfiguration(
          view.state,
          addons.current.reconfigure(featureExtensions(kept, formatted)),
        )
        let retry: Transaction | null = null
        try {
          retry = reinstall.state.update(
            ...edit.map((part, index) => {
              const spec = part instanceof Transaction ? editSpec(part) : part
              return index ? { ...spec, sequential: true } : spec
            }),
          )
        } catch {}
        if (retry) {
          installed.current = kept
          view.dispatch([reinstall, retry])
          return
        }
      }
      // Otherwise the input is not applied. A composition ends first, so the
      // IME does not compose on over text the note does not have.
      const focused = view.hasFocus
      if (view.compositionStarted) view.contentDOM.blur()
      view.setState(view.state)
      if (focused) view.focus()
    }
    const editor = new EditorView({
      parent: host.current,
      ...(place
        ? {
            scrollTo: EditorView.scrollIntoView(place.top, {
              y: 'start',
              yMargin: place.margin,
            }),
          }
        : {}),
      dispatchTransactions(transactions, editor) {
        // Input no Markdown can keep is refused unapplied, its features kept.
        for (const transaction of transactions) {
          const error = transaction.annotation(rejectedInput)
          if (error) {
            reject(editor, error)
            return
          }
        }
        try {
          bridge.dispatch(transactions, editor, exactChanges.current)
          // Only the user's next action clears a failure, not the view's own.
          if (
            transactions.some((transaction) =>
              transaction.annotation(Transaction.userEvent),
            )
          )
            setInputError('')
        } catch (error) {
          // A transaction made after a failed one may start from either state,
          // so the failed one is replayed alone, from the state it started at.
          const failed = transactions.find(
            (transaction) => !transactionState(transaction),
          )
          reject(editor, error, failed && [failed], failed?.startState)
        }
      },
      state: EditorState.create({
        doc: preparedText.text,
        ...(selection ? { selection } : {}),
        extensions: [
          firstStateRead,
          restore ? restore.extension : [],
          ViewPlugin.define((view) => ({
            destroy: observeClipboard(view.contentDOM),
          })),
          EditorView.domEventHandlers({
            scroll: (_event, editor) => record(editor),
          }),
          // The first transaction typing makes, as CodeMirror made it, before
          // anything else can fail on it.
          Prec.highest(
            EditorState.changeFilter.of((transaction) => {
              if (inputEdit === null) inputEdit = transaction
              return true
            }),
          ),
          addons.current.of([]),
          findHighlights.current.of([]),
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
            // Like the rich view's list, the formatted view's answers keys as
            // soon as it opens, whatever the wall clock does. The source view
            // keeps CodeMirror's delay.
            ...(formatted
              ? { interactionDelay: Number.NEGATIVE_INFINITY }
              : {}),
          }),
          EditorState.transactionExtender.of((transaction) => {
            const state = transactionState(transaction)
            if (!state) return null
            const options = currentCompletions(state)
            if (
              !options.length ||
              options === currentCompletions(transaction.startState) ||
              selectedCompletion(state)
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
          indentation.current.of(
            formatted
              ? [
                  sourceIndentation(tabIndent.snapshot().unit),
                  formattedTabIndents.of(tabIndent.snapshot().enabled),
                ]
              : sourceIndentation(tabIndent.snapshot().unit),
          ),
          formatted
            ? []
            : keymap.of([
                // Like Enter, a Tab the open list declines (it just opened, or its
                // item keeps Tab) does what it would without the list.
                {
                  key: 'Tab',
                  run: (view) => indentSource(view, indentMore),
                  shift: (view) => indentSource(view, indentLess),
                },
              ]),
          // Table cells follow their links through the view's own resolution.
          formatted ? formattedFollowLink.of(followLink) : [],
          // Reference links render with the labels the reference worker resolves.
          formattedReferences.of({
            syntax: () => {
              const { markdownMode, referenceSyntax } = parserOptions.current
              return markdownMode && referenceSyntax
                ? JSON.stringify(referenceSyntax)
                : ''
            },
            resolve: (label, signal) => {
              const { markdownMode, referenceSyntax } = parserOptions.current
              return markdownMode && referenceSyntax
                ? resolveReference(referenceSyntax, label, signal)
                : Promise.resolve({ status: 'unavailable' })
            },
          }),
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
            mousedown(event) {
              if (
                !formatted ||
                !followsLink(event) ||
                !parserOptions.current.markdownMode ||
                !parserOptions.current.linksEnabled ||
                !(event.target instanceof Element) ||
                !event.target.closest('.hibi-lp-link')
              )
                return false
              // Following a link must not first extend the selection: revealing
              // intervening embeds moves the target before its click arrives.
              event.preventDefault()
              return true
            },
            click(event, view) {
              if (formatted ? !followsLink(event) : !event.shiftKey)
                return false
              const position = view.posAtCoords({
                x: event.clientX,
                y: event.clientY,
              })
              return position != null && followLink(view, position)
            },
            // A Ctrl+Cmd-click arrives as a context menu on macOS.
            contextmenu(event, view) {
              if (!formatted || !event.ctrlKey || !event.metaKey) return false
              const position = view.posAtCoords({
                x: event.clientX,
                y: event.clientY,
              })
              return position != null && followLink(view, position)
            },
          }),
          // A right-click places the caret at once, which the page would place
          // only after the menu opens: the menu then acts there and stays open.
          EditorView.mouseSelectionStyle.of((view, event) => {
            // macOS opens the menu on a Control+click too.
            const control =
              event.button === 0 &&
              event.ctrlKey &&
              !event.metaKey &&
              !event.shiftKey &&
              /Mac/.test(navigator.platform)
            if (
              (event.button !== 2 && !control) ||
              (event.target instanceof Element &&
                event.target.closest('[contenteditable="false"]'))
            )
              return null
            const pressed = view.posAtCoords({
              x: event.clientX,
              y: event.clientY,
            })
            if (pressed === null) return null
            const { from, to } = view.state.selection.main
            // A press in the selection keeps it.
            if (from < to && pressed >= from && pressed <= to) {
              if (!control) return null
              // A click collapses it on release; this keeps it. Focused now,
              // the editor does not select it again on release either, as it
              // does after taking focus.
              view.focus()
              return { get: () => view.state.selection, update: () => false }
            }
            let at = pressed
            return {
              get: () => EditorSelection.single(at),
              update: (update) => {
                at = update.changes.mapPos(at)
              },
            }
          }),
          keymap.of([
            { key: 'Ctrl-a', run: sourceCommands.selectAll },
            ...sourceCommands.defaultKeymap,
            {
              key: 'Mod-z',
              run: bridge.undo,
              shift: bridge.redo,
              preventDefault: true,
            },
            { key: 'Mod-y', run: bridge.redo, preventDefault: true },
          ]),
          formatted
            ? []
            : [
                syntaxHighlighting(highlighting),
                syntaxHighlighting(codeHighlighter),
              ],
          EditorView.lineWrapping,
          formatted && onEditLink
            ? linkControls({
                capture: (position) =>
                  formatting.current?.capture(position) ?? null,
                edit: (capture) =>
                  editLink.current?.(capture) ?? Promise.resolve(),
                open: (href) => openLink.current(href),
                error: (error) => setInputError(String(error)),
              })
            : [],
          placeholder('Start typing'),
          display.current.of(
            formatted
              ? [
                  showMarkdownMarkers.of(displayOptions.current.markers),
                  EditorView.contentAttributes.of({
                    spellcheck: String(displayOptions.current.spellCheck),
                  }),
                  formattedDocument.of({
                    revision: displayOptions.current.documentRevision,
                    tabId: document.tabId,
                  }),
                ]
              : EditorView.contentAttributes.of({ spellcheck: 'false' }),
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && shownPlace.current)
              shownPlace.current.top = update.changes.mapPos(
                shownPlace.current.top,
                1,
              )
            if (
              !update.transactions.length &&
              (update.geometryChanged || update.viewportChanged)
            )
              record(update.view)
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
              editorViewRegistry.changed(viewId as ViewId, kind)
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
            pendingSyntax?.update()
            if (update.docChanged || update.selectionSet || update.focusChanged)
              update.view.contentDOM.dispatchEvent(
                new Event('hibi:source-caret', { bubbles: true }),
              )
            // CodeMirror reports a regained focus a moment late, which must
            // not close a menu opened in the meantime.
            if (
              update.docChanged ||
              update.selectionSet ||
              (update.focusChanged && !update.view.hasFocus)
            )
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
            if (find.current.active && !applyingFind.current) {
              const config = renderedConfig.current?.(update.state) ?? null
              if (
                update.docChanged ||
                update.selectionSet ||
                JSON.stringify(config) !== findConfig.current
              ) {
                findActions.current = []
                navigatingFind.current = false
                requestFind()
              } else if (!navigatingFind.current) {
                const moved = movedFindWindow(update)
                const shown = renderedPage.current
                if (
                  moved &&
                  shown &&
                  (moved.from !== shown.from || moved.to !== shown.to)
                )
                  requestFind()
              }
            }
          }),
          failedEditGuard,
          // Typing read from the DOM is made into an edit here, last, so an
          // extension that fails while it is made is named from that edit,
          // with every range CodeMirror changed and selected.
          Prec.lowest(
            EditorView.inputHandler.of((view, from, to, text, insert) => {
              inputEdit = null
              try {
                insert()
                return false
              } catch (error) {
                reject(
                  view,
                  error,
                  inputEdit
                    ? [inputEdit]
                    : [
                        {
                          changes: { from, to, insert: text },
                          userEvent: 'input',
                        },
                      ],
                )
                return true
              } finally {
                inputEdit = undefined
              }
            }),
          ),
        ],
      }),
    })
    // A filter or extender may also fail while a transaction is made, before
    // dispatch: from specs here, and from typing CodeMirror reads in the
    // DOM observer (internal to CodeMirror). That input is rejected too.
    const dispatch = editor.dispatch.bind(editor) as (
      ...input: unknown[]
    ) => void
    editor.dispatch = ((...input: unknown[]) => {
      if (
        input.some(
          (value) => value instanceof Transaction || Array.isArray(value),
        )
      )
        return dispatch(...input)
      let transaction: Transaction
      try {
        transaction = editor.state.update(...(input as TransactionSpec[]))
      } catch (error) {
        reject(editor, error, input as TransactionSpec[])
        return
      }
      dispatch(transaction)
    }) as EditorView['dispatch']
    const observer = (
      editor as unknown as {
        observer: { flush: (readSelection?: boolean) => boolean }
      }
    ).observer
    const flush = observer.flush.bind(observer)
    observer.flush = (readSelection) => {
      try {
        return flush(readSelection)
      } catch (error) {
        reject(editor, error)
        return true
      }
    }
    view.current = editor
    setMountedView(editor)
    const detachSession = bridge.attach(editor, (error) =>
      setFailedEcho({
        bridge,
        message:
          (error instanceof Error ? error.message : String(error)) ||
          'The source editor is synchronizing.',
      }),
    )
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
    // The keys of a started composition are the input method's, as in the
    // rich view. CodeMirror ignores them only once the composition changes
    // the text; before that, its keymap and focus keys would still take them.
    // The open list closes; nothing prevents the key's default.
    const passComposingKey = (event: KeyboardEvent) => {
      if (!event.isComposing && !editor.compositionStarted) return
      cancelCompletion()
      closeCompletion(editor)
      event.stopPropagation()
    }
    editor.dom.addEventListener('keydown', passComposingKey, true)
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
      kind,
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
        )
        if (!transaction)
          return { status: 'applied', contentVersion: current.contentVersion }
      } catch (error) {
        return { status: 'invalid', message: String(error) }
      }
      if (formatted) {
        const proof = formattedLiteralEdits(
          transaction,
          syntax.parser(editor.state),
          tree(editor.state),
        )
        if (proof === null)
          return {
            status: 'busy',
            message:
              'The document index is still building. Try the edits again in a moment.',
          }
        if (!proof)
          return {
            status: 'unsupported-view',
            message: 'Open source view to apply these edits.',
          }
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
          kind,
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
        const at = bridge.snapshot().rawToEditor(raw)
        if (at === null) return
        // Like the rich view, the formatted view puts the caret in a heading's
        // text, after the opening mark and the space it hides with it.
        const end = Math.min(editor.state.doc.lineAt(at).to, at + 7),
          mark = formatted
            ? /^#{1,6}(?:[ \t]|$)/.exec(editor.state.sliceDoc(at, end))
            : null
        editor.dispatch({
          selection: { anchor: at + (mark?.[0].length ?? 0) },
          effects: EditorView.scrollIntoView(at, {
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
    bridges.set(editor, bridge)
    const unregisterViewApi = editorViewRegistry.register(
      document.tabId,
      viewId as ViewId,
      kind,
      {
        surface: () => editor.contentDOM,
        read: () => {
          const source = bridge.snapshot()
          if (
            view.current !== editor ||
            !bridge.isCurrent() ||
            !session.ownsCurrentSnapshot(source)
          )
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
    // The formatted view parses changed code languages again in its own syntax.
    const unsubscribe = formatted
      ? () => {}
      : codeLanguages.subscribe(() => configureParser.current())
    // Flavors that bring no source syntax keep the parser and its parse.
    configureFlavors.current = () => {
      const configs = formatted ? null : flavorConfigs()
      if (
        !configs ||
        configs.length !== parsedFlavors.length ||
        configs.some((config, index) => config !== parsedFlavors[index])
      )
        configureParser.current()
    }
    const unsubscribeFlavors = markdownFlavors.subscribe(() => {
      if (!formatted) configureFlavors.current()
    })
    configureParser.current()
    // The index's code blocks keep their height in the formatted view before
    // it has drawn or parsed them. A late listener gets the index replayed.
    const unsubscribeCode = formatted
      ? getWorker().subscribeCodeExtents((page) => {
          if (
            disposed ||
            page.version !== session.snapshot().version ||
            !bridge.isCurrent()
          )
            return
          editor.dispatch({
            effects: setCodeExtents.of({
              from: page.from,
              to: page.to,
              extents: page.records.map((record) => ({
                from: record.from,
                to: record.to,
                lines: record.contentLines,
                columns: record.contentColumns,
              })),
            }),
          })
        })
      : () => {}
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
      .load(formatted ? '16px "Geist"' : '13px "Geist Mono"')
      .then(finishFont, finishFont)
    return () => {
      restoreFocus.current ??= captureEditorFocus(editor.contentDOM)
      cancelAnimationFrame(compositionFrame)
      editor.dom.removeEventListener('keydown', passComposingKey, true)
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
      renderedConfig.current = null
      renderedPage.current = null
      referenceUsed.current = false
      referenceFailed.current = false
      unsubscribe()
      unsubscribeFlavors()
      unsubscribeCode()
      configureParser.current = () => {}
      configureFlavors.current = () => {}
      disposed = true
      unsubscribeInteractions()
      unregisterSelection()
      formatting.current = null
      reportFormatting.current(null)
      unregister()
      bridges.delete(editor)
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
      setMountedView(null)
    }
  }, [
    bridge,
    preparedText,
    session,
    document.tabId,
    document.revision,
    requestFind,
    requestReference,
    resolveReference,
    getWorker,
    clearReferences,
    viewId,
    formatted,
    kind,
    onEditLink,
  ])

  useEffect(() => {
    if (mountedView !== view.current) return
    if (mountedView && (disabled || !editTarget || !inputReady))
      closeCompletion(mountedView)
  }, [mountedView, disabled, editTarget, inputReady])

  // Before paint and before focus moves here, a shown or targeted view catches up.
  useLayoutEffect(() => {
    shown.current = sourceVisible || editTarget
    bridge.setVisible(shown.current)
    documentProjections.invalidate()
  }, [bridge, sourceVisible, editTarget])

  // A view keeps its place while its pane still lays out: the cleanup that
  // destroys it runs after the pane has left the page.
  useLayoutEffect(
    () => () => {
      const editor = view.current
      if (!keepingPlace.current || !editor) return
      const { top, margin } = shownPlace.current ?? placeOf(editor)
      bridge.keepPlace(editor, top, margin)
    },
    [bridge],
  )

  useEffect(() => {
    const editor = view.current
    setExtensionError('')
    if (!editor || preparedText?.bridge !== bridge) return
    let canceled = false
    const context = Object.freeze({ viewId: viewId as ViewId })
    void Promise.allSettled(
      sourceExtensions.map(async (feature) => feature.create(context)),
    ).then((results) => {
      if (canceled) return
      const errors: unknown[] = []
      let parts: InstalledFeature[] = []
      results.forEach((result, index) => {
        const feature = sourceExtensions[index]!
        if (result.status === 'fulfilled')
          parts.push({ feature, extension: result.value })
        else if (feature.fail) feature.fail(result.reason)
        else errors.push(result.reason)
      })
      const install = () =>
        reconfiguration(
          editor.state,
          addons.current.reconfigure(featureExtensions(parts, formatted)),
        )
      let transaction = install()
      if (!transactionState(transaction)) {
        parts = isolateFeatures(
          editor.state,
          [],
          parts,
          addons.current,
          formatted,
        )
        transaction = install()
      }
      installed.current = parts
      editor.dispatch(transaction)
      if (errors.length) setExtensionError(String(errors[0]))
      else setInstalledExtensions({ bridge, extensions: sourceExtensions })
    })
    return () => {
      canceled = true
    }
  }, [bridge, preparedText, sourceExtensions, viewId, formatted])
  useEffect(
    () =>
      tabIndent.subscribe(() =>
        view.current?.dispatch({
          effects: indentation.current.reconfigure(
            formatted
              ? [
                  sourceIndentation(tabIndent.snapshot().unit),
                  formattedTabIndents.of(tabIndent.snapshot().enabled),
                ]
              : sourceIndentation(tabIndent.snapshot().unit),
          ),
        }),
      ),
    [formatted],
  )
  useEffect(() => {
    if (!formatted || mountedView !== view.current) return
    mountedView?.dispatch({
      effects: display.current.reconfigure([
        showMarkdownMarkers.of(markers),
        EditorView.contentAttributes.of({ spellcheck: String(spellCheck) }),
        formattedDocument.of({
          revision: documentRevision,
          tabId: document.tabId,
        }),
      ]),
    })
  }, [
    mountedView,
    formatted,
    markers,
    spellCheck,
    documentRevision,
    document.tabId,
  ])
  // Match the shell's ready state before input or focus can reach this view.
  useLayoutEffect(() => {
    if (mountedView !== view.current) return
    if (mountedView && (disabled || !inputReady))
      restoreFocus.current ??= captureEditorFocus(mountedView.contentDOM)
    mountedView?.dispatch({
      effects: editable.current.reconfigure([
        EditorView.editable.of(!disabled && inputReady),
        EditorState.readOnly.of(disabled || !inputReady),
        ...(echoError
          ? [EditorView.contentAttributes.of({ tabindex: '0' })]
          : []),
      ]),
    })
  }, [mountedView, disabled, inputReady, echoError])

  useEffect(() => {
    // Publish readiness after CodeMirror configures input, before its next frame.
    const status =
      extensionError || languageError || echoError
        ? 'failed'
        : inputReady && (!waitForFont || fontReadyBridge === bridge)
          ? 'ready'
          : 'loading'
    ready.current(status)
    if (status === 'ready' && !disabled) {
      const restore = restoreFocus.current
      restoreFocus.current = null
      restore?.()
    }
  }, [
    bridge,
    disabled,
    inputReady,
    waitForFont,
    fontReadyBridge,
    extensionError,
    languageError,
    echoError,
  ])

  useEffect(() => {
    if (mountedView !== view.current) return
    mountedView?.dispatch({
      effects: numbers.current.reconfigure(
        showLineNumbers && !formatted
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
  }, [mountedView, showLineNumbers, formatted])

  useEffect(() => {
    const editor = mountedView
    if (!editor || editor !== view.current) return
    const stopFind = () => {
      if (referenceUsed.current || formatted) sourceFind.current?.cancelFind()
      else {
        sourceFind.current?.dispose()
        sourceFind.current = null
      }
    }
    if (!findActive) {
      renderedPage.current = null
      closeSearchPanel(editor)
      editor.dispatch({ effects: findHighlights.current.reconfigure([]) })
      stopFind()
      findActions.current = []
      navigatingFind.current = false
      return
    }
    const query = new SearchQuery({ search: findQuery, literal: true })
    editor.dispatch({
      effects: [
        setSearchQuery.of(query),
        findHighlights.current.reconfigure([]),
      ],
    })
    findActions.current = []
    navigatingFind.current = query.valid
    if (query.valid) requestFind('first')
    else {
      stopFind()
      find.current.report({ current: 0, total: 0 })
    }
  }, [mountedView, formatted, findActive, findQuery, requestFind])

  useEffect(() => {
    if (
      !mountedView ||
      mountedView !== view.current ||
      handledFindMove.current === findMove.id
    )
      return
    handledFindMove.current = findMove.id
    if (findActive && findMove.id) {
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
  }, [mountedView, findActive, findMove, requestFind])

  return (
    <>
      {(extensionError || languageError || inputError || echoError) && (
        <DocumentNotice
          title={
            echoError || inputError
              ? 'Edit could not be applied'
              : 'Editor addon unavailable'
          }
          message={echoError || inputError || extensionError || languageError}
        >
          {echoError && (
            <Button onClick={() => retryBridge((retry) => retry + 1)}>
              Retry
            </Button>
          )}
          {!inputError && !extensionError && languageError && codeLanguage && (
            <Button onClick={() => void codeLanguages.retry(codeLanguage)}>
              Retry language
            </Button>
          )}
        </DocumentNotice>
      )}
      <div
        className={formatted ? 'formatted-editor' : 'source-editor'}
        ref={host}
      />
    </>
  )
}
