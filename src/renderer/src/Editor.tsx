import type { Editor, EditorEvents } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { Node as RichNode } from '@tiptap/pm/model'
import { AllSelection, TextSelection } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import { EditorContent, useEditor } from '@tiptap/react'
import {
  findNext,
  findPrev,
  getMatchHighlights,
  getSearchState,
  SearchQuery,
  setSearchState,
} from 'prosemirror-search'
import {
  lazy,
  type MouseEvent,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type {
  DocumentFormat,
  MarkdownExtension,
  MarkdownFlavor,
  RichExtension,
  SourceExtension,
} from '../../addons/api'
import type {
  CompletionItem,
  CompletionRequest,
  CompletionUpdate,
} from '../../shared/completions'
import type { DocumentState } from '../../shared/desktop'
import { MAX_DOCUMENT_BYTES } from '../../shared/desktop'
import { editedSource, sourceEditMatches } from '../../shared/document-edits'
import type {
  AcceptedSourceEdit,
  DocumentSession,
} from '../../shared/document-session'
import type { DocumentView } from '../../shared/document-types'
import {
  type EditorContextAction,
  type EditorInteractionRequest,
  sameInteraction,
} from '../../shared/editor-interactions'
import type { ViewId } from '../../shared/foundation-contracts'
import { isMediaFile } from '../../shared/media'
import type { SourceSnapshot } from '../../shared/source-buffer'
import {
  mapSourceSelection,
  type SourceSelection,
} from '../../shared/source-selection'
import { Button } from '../../ui/Controls'
import { DocumentNotice } from '../../ui/DocumentNotice'
import { performanceDiagnostics } from '../../ui/diagnostics'
import { addonRegistry } from './addon-registry'
import { completionBroker } from './completion-broker'
import { documentImage } from './DocumentImage'
import { documentEdits } from './document-edits'
import { editorDocument } from './document-formats'
import { documentHistory } from './document-history'
import { documentProjections } from './document-projections'
import { documentRuntime } from './document-runtime'
import { certifyVisualEcho } from './document-shell'
import { type CursorSettings, EditorCursor } from './EditorCursor'
import { emitEditorKeyEvent } from './editor-events'
import {
  hasEditorInteractionProviders,
  onEditorInteractionProvidersChanged,
} from './editor-interaction-presence'
import { FindBar, type FindMove, type FindStatus } from './FindBar'
import { useFormattingToolbar } from './FormattingToolbar'
import { flavors as flavorRegistry } from './flavors'
import { LoadingScreen } from './LoadingScreen'
import { linkScroll } from './linked-scroll'
import { MirrorCursor } from './MirrorCursor'
import { editorExtensions, projectMarkdown } from './markdown'
import { observeMarkdownMarkers } from './markdown-markers'
import {
  createMarkdownPositionCache,
  type MarkdownPositionLookup,
} from './markdown-positions'
import './markdown-markers.css'
import type { ReferenceValue } from '../../shared/source-references'
import { createMarkdownSemantics } from './markdown-semantics'
import { markdownSerializer } from './markdown-serialization'
import { markdownSyntax } from './markdown-syntax'
import type { OutlineHeading, OutlineRequest } from './OutlineSidebar'
import { outlineHeadingAt } from './outline-position'
import { createPlainSourceSync } from './plain-source-sync'
import { observeRichAnnotations } from './rich-annotations'
import { preserveRichSource } from './rich-source-preservation'
import {
  richSourceEcho,
  richSourceSession,
  richSourceSnapshot,
} from './rich-source-session'
import { flushRich, registerRichSync, richSourceCurrent } from './rich-sync'
import { exactRichRange } from './rich-text-range'
import { type SourceOutlineHeading, SourceOutlineModel } from './source-outline'
import {
  resolveSourceReference,
  revealSourcePosition,
  sourcePosition,
  sourceView,
} from './source-view'
import { textProjection } from './text-projection'
import { useEditorPanes } from './use-editor-panes'

const SourceEditor = lazy(() =>
  import('./MarkdownSourceEditor').then((module) => ({
    default: module.MarkdownSourceEditor,
  })),
)

const parseParagraph = (editor: Editor, source: string) =>
  performanceDiagnostics.measure('core', 'Markdown paragraph parsing', () =>
    editor.markdown!.parse(source),
  )

// These built-in attachments observe or dispatch edits without replacing codecs.
const grammarPreservingRich = new Map([
  ['word-count.text', 'word-count'],
  ['block-drag.handle', 'block-drag'],
  ['math.editing', 'math'],
  ['slash-commands.menu', 'slash-commands'],
  ['tags.highlights', 'tags'],
])

export type ViewMode = DocumentView

export function MarkdownEditor({
  document: documentState,
  viewId = 'default',
  format,
  formatName,
  value,
  onChange,
  mode,
  disabled,
  findOpen,
  onCloseFind,
  markdownExtensions,
  sourceExtensions,
  richExtensions,
  cursorSettings,
  showLineNumbers,
  spellCheck,
  showMarkdownMarkers,
  documentRevision,
  flavors,
  onAttach,
  onLink,
  onOutline,
  onOutlineUnavailable,
  onActiveOutline,
  outlineTarget,
  outlineActive,
}: {
  document: DocumentState
  viewId?: string
  format: DocumentFormat | undefined
  formatName: string
  value: string
  onChange: (value: string, historyGroup?: string) => void
  mode: ViewMode
  disabled: boolean
  findOpen: boolean
  onCloseFind: () => void
  markdownExtensions: readonly MarkdownExtension[]
  sourceExtensions: readonly SourceExtension[]
  richExtensions: readonly RichExtension[]
  cursorSettings: CursorSettings
  showLineNumbers: boolean
  spellCheck: boolean
  showMarkdownMarkers: boolean
  documentRevision: number
  flavors: readonly MarkdownFlavor[]
  onAttach: (
    files: File[] | null,
  ) => Promise<import('../../shared/media').MediaAttachment[] | null>
  onLink: (href: string) => void
  onOutline: (headings: OutlineHeading[]) => void
  onOutlineUnavailable?: (reason: string | null) => void
  onActiveOutline: (id: string | null) => void
  outlineTarget: OutlineRequest | null
  outlineActive: boolean
}) {
  const markdownDocument = format?.editing === 'markdown'
  const exactSource = useRef<{ source: string; document: RichNode } | null>(
    null,
  )
  const exactHistory = useRef(
    new WeakMap<Editor, Map<string, { source: string; document: RichNode }>>(),
  )
  const serializers = useRef(
    new WeakMap<Editor, ReturnType<typeof markdownSerializer>>(),
  )
  const plainSync = useRef<ReturnType<typeof createPlainSourceSync>>(null)
  const pendingPlainSync = useRef<{
    editor: Editor
    source: SourceSnapshot
    document: RichNode
    certificate: NonNullable<ReturnType<typeof createPlainSourceSync>>
    deferEcho?: boolean
  } | null>(null)
  const retainedPreview = useRef<{
    editor: Editor
    session: DocumentSession
    snapshot: SourceSnapshot
    selection: SourceSelection
  } | null>(null)
  const syntaxVersion = useSyncExternalStore(
    markdownSyntax.subscribe,
    markdownSyntax.version,
  )
  const richSyntaxCompatible = richExtensions.every(
    (extension) =>
      'addonId' in extension &&
      typeof extension.addonId === 'string' &&
      grammarPreservingRich.get(extension.id) === extension.addonId &&
      addonRegistry.origin(extension.addonId) === 'built-in',
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: syntaxVersion invalidates the current registry preferences.
  const referenceSyntax = useMemo(() => {
    // Unknown parser/projection contributions keep their existing link behavior.
    if (
      flavors.some(
        (flavor) =>
          (flavor.export?.extensions?.length ||
            flavor.richExtensions?.length) &&
          ![
            'markdown.github',
            'markdown.obsidian',
            'github-markdown.github',
            'text-extras.text-extras',
            'math.latex',
          ].includes(flavor.id),
      ) ||
      markdownExtensions.some(
        (extension) => extension.id !== 'frontmatter.metadata',
      )
    )
      return undefined
    return {
      gfm: Object.assign(
        { gfm: false },
        ...flavors.map((flavor) => flavor.markedOptions),
      ).gfm,
      alerts: flavors.some((flavor) => flavor.id === 'markdown.github'),
      textExtras: flavors.some(
        (flavor) => flavor.id === 'text-extras.text-extras',
      ),
      math: flavors.some((flavor) => flavor.id === 'math.latex'),
      frontmatter: markdownExtensions.some(
        (extension) => extension.id === 'frontmatter.metadata',
      ),
    }
  }, [flavors, markdownExtensions, syntaxVersion])
  // biome-ignore lint/correctness/useExhaustiveDependencies: registry preferences invalidate outline grammar ownership.
  const outlineSyntax = useMemo(() => {
    const known = new Map([
      ['markdown.github', 'markdown'],
      ['markdown.obsidian', 'markdown'],
      ['github-markdown.github', 'github-markdown'],
      ['text-extras.text-extras', 'text-extras'],
      ['math.latex', 'math'],
    ])
    if (
      !richSyntaxCompatible ||
      flavors.some((flavor) => {
        const entry = flavorRegistry
          .snapshot()
          .find((entry) => entry === flavor)
        return (
          !entry ||
          known.get(entry.id) !== entry.addonId ||
          addonRegistry.origin(entry.addonId) !== 'built-in'
        )
      }) ||
      markdownExtensions.some(
        (extension) =>
          extension.id !== 'frontmatter.metadata' ||
          !('addonId' in extension) ||
          extension.addonId !== 'frontmatter' ||
          addonRegistry.origin('frontmatter') !== 'built-in',
      ) ||
      markdownSyntax
        .snapshot()
        .some(
          (feature) =>
            !markdownSyntax.isCore(feature.id) &&
            feature.scope !== 'document' &&
            (![...known.values()].includes(feature.owner) ||
              addonRegistry.origin(feature.owner) !== 'built-in'),
        )
    )
      return null
    return {
      gfm: Object.assign(
        { gfm: false },
        ...flavors.map((flavor) => flavor.markedOptions),
      ).gfm,
      alerts: flavors.some((flavor) => flavor.id === 'markdown.github'),
      textExtras: flavors.some(
        (flavor) => flavor.id === 'text-extras.text-extras',
      ),
      math: flavors.some((flavor) => flavor.id === 'math.latex'),
      frontmatter: markdownExtensions.some(
        (extension) => extension.id === 'frontmatter.metadata',
      ),
    }
  }, [
    flavors,
    markdownExtensions,
    syntaxVersion,
    richSyntaxCompatible,
    richExtensions,
  ])
  // biome-ignore lint/correctness/useExhaustiveDependencies: syntaxVersion invalidates parser contribution compatibility.
  const plainSyncEligible = useMemo(() => {
    const knownOwner = (owner: string) =>
      ['markdown', 'github-markdown', 'text-extras'].includes(owner) &&
      addonRegistry.origin(owner) === 'built-in'
    return (
      richSyntaxCompatible &&
      flavors.every((flavor) => {
        const registered = flavorRegistry
          .snapshot()
          .find((entry) => entry === flavor)
        return (
          registered &&
          knownOwner(registered.addonId) &&
          [
            'markdown.github',
            'markdown.obsidian',
            'github-markdown.github',
            'text-extras.text-extras',
          ].includes(registered.id)
        )
      }) &&
      markdownExtensions.every(
        (extension) =>
          extension.id === 'frontmatter.metadata' &&
          'addonId' in extension &&
          extension.addonId === 'frontmatter' &&
          addonRegistry.origin('frontmatter') === 'built-in',
      ) &&
      markdownSyntax
        .snapshot()
        .every(
          (feature) =>
            markdownSyntax.isCore(feature.id) ||
            feature.scope === 'document' ||
            knownOwner(feature.owner),
        )
    )
  }, [flavors, markdownExtensions, syntaxVersion, richSyntaxCompatible])
  const projection = useMemo(
    () =>
      markdownDocument
        ? projectMarkdown(value, markdownExtensions)
        : { content: '', serialize: () => value, readOnly: true },
    [value, markdownExtensions, markdownDocument],
  )
  const projectionReadOnly = Boolean(projection.readOnly)
  const richHistoryGroup = useRef({
    id: '',
    time: 0,
    composition: undefined as number | undefined,
  })
  const [richInputError, setRichInputError] = useState('')
  const retryRich = useRef(() => {})
  const prepareRichRef = useRef(prepareRich)
  prepareRichRef.current = prepareRich
  const [richExtensionError, setRichExtensionError] = useState('')
  const [findQuery, setFindQuery] = useState('')
  const [findStatus, setFindStatus] = useState<FindStatus>({
    current: 0,
    total: 0,
  })
  const [findMove, setFindMove] = useState<FindMove>({
    id: 0,
    direction: 'next',
  })
  const handledFindMove = useRef(0)
  const {
    content,
    paneMode,
    focusedPane,
    setFocusedPane,
    sourceMounted,
    sourceReady,
    setSourceReady,
    setSourceSettled,
    focusOwnedByEditor,
  } = useEditorPanes(mode, markdownDocument)
  // Temporarily disable split visual editing while its typing performance is
  // unresolved. Keep preview synchronization and the performance work intact.
  const splitReadOnly = mode === 'side-by-side' || paneMode === 'side-by-side'
  const findTarget = !markdownDocument
    ? 'source'
    : mode === 'normal'
      ? 'rich'
      : mode === 'markdown'
        ? 'source'
        : focusedPane
  const scrollContent = useRef({
    source: value,
    body: projection.content,
    document: documentState,
  })
  scrollContent.current = {
    source: value,
    body: projection.content,
    document: documentState,
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: syntaxVersion rebuilds preference-dependent schema extensions.
  const extensions = useMemo(
    () => [
      ...editorExtensions(flavors, documentHistory),
      richSourceSession.configure({
        // Only a completed visible-pane synchronization may claim source ownership.
        initialSource: null,
        prepare: (event) => prepareRichRef.current(event),
        reject: (error) => {
          plainSync.current = null
          pendingPlainSync.current = null
          setRichInputError(
            error instanceof Error ? error.message : String(error),
          )
        },
        reconciled: (source) => {
          const pending = pendingPlainSync.current
          pendingPlainSync.current = null
          if (pending) {
            plainSync.current =
              source === pending.source &&
              pending.editor.state.doc === pending.document &&
              pending.certificate.matches(source, pending.document)
                ? pending.certificate
                : null
            if (plainSync.current && pending.deferEcho)
              certifyVisualEcho(source)
          }
          setRichInputError('')
        },
      }),
      ...(markdownSyntax.enabled('core.images')
        ? [documentImage(documentRevision)]
        : []),
    ],
    [flavors, syntaxVersion, documentRevision],
  )
  const editor = useEditor(
    {
      extensions,
      content: '',
      contentType: 'markdown',
      autofocus: false,
      injectCSS: false,
      shouldRerenderOnTransaction: false,
      editorProps: {
        handleDOMEvents: {
          keydown(view, event) {
            if (
              ((event.ctrlKey && !event.metaKey) ||
                (!view.editable && event.metaKey && !event.ctrlKey)) &&
              !event.altKey &&
              !event.shiftKey &&
              event.key.toLowerCase() === 'a'
            ) {
              event.preventDefault()
              if (!view.editable)
                view.dom.ownerDocument
                  .getSelection()
                  ?.selectAllChildren(view.dom)
              view.dispatch(
                view.state.tr.setSelection(new AllSelection(view.state.doc)),
              )
              return true
            }
            return false
          },
        },
        attributes: {
          'aria-label': 'Document editor',
          role: 'textbox',
          'aria-multiline': 'true',
          tabindex: '0',
        },
      },
      onSelectionUpdate: ({ transaction }) => {
        if (
          !transaction.docChanged &&
          transaction.getMeta('composition') == null
        )
          richHistoryGroup.current.id = ''
      },
    },
    [markdownExtensions, flavors, syntaxVersion],
  )
  const updateRichEditable = useCallback(() => {
    if (!editor || editor.isDestroyed) return
    editor.setEditable(
      paneMode !== 'markdown' &&
        !splitReadOnly &&
        !projectionReadOnly &&
        !disabled &&
        !richExtensionError &&
        richSourceCurrent(editor),
      false,
    )
    editor.view.dom.setAttribute('aria-readonly', String(!editor.isEditable))
  }, [
    editor,
    paneMode,
    splitReadOnly,
    projectionReadOnly,
    disabled,
    richExtensionError,
  ])
  const completionContext = useRef({
    tabId: documentState.tabId,
    viewId,
    paneMode,
    disabled,
    splitReadOnly,
    projectionReadOnly,
    plainSyncEligible,
    syntaxVersion,
    markdownExtensions,
  })
  completionContext.current = {
    tabId: documentState.tabId,
    viewId,
    paneMode,
    disabled,
    splitReadOnly,
    projectionReadOnly,
    plainSyncEligible,
    syntaxVersion,
    markdownExtensions,
  }
  useEffect(() => {
    const manager = editor?.markdown
    if (!editor || !manager || !markdownDocument) return
    const serializeCompletionSource = markdownSerializer(manager, true)
    const view = editor.view
    const menu = document.createElement('div')
    menu.id = `rich-completions-${crypto.randomUUID()}`
    menu.className = 'command-results'
    menu.popover = 'manual'
    menu.setAttribute('role', 'listbox')
    menu.setAttribute('aria-label', 'Completions')
    menu.setAttribute('aria-hidden', 'true')
    menu.inert = true
    Object.assign(menu.style, {
      position: 'fixed',
      inset: 'auto',
      margin: '0',
      width: 'min(320px, calc(100vw - 16px))',
      maxHeight: 'min(308px, calc(100vh - 16px))',
      overflowY: 'auto',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-popover)',
      background: 'var(--background)',
      color: 'var(--ink)',
      fontFamily: 'var(--font-ui)',
      fontSize: 'var(--text-ui)',
    })
    document.body.append(menu)
    const attributes = [
      'aria-controls',
      'aria-activedescendant',
      'aria-autocomplete',
      'aria-haspopup',
    ]
    let previous = new Map<string, string | null>()
    let visible: {
      request: CompletionRequest
      items: readonly CompletionItem[]
    } | null = null
    let selected = 0
    let cancel: (() => void) | null = null
    let pending = false
    let frame = 0
    let typed: string | null = null
    let disposed = false
    const open = () => menu.matches(':popover-open')
    const hide = () => {
      visible = null
      menu.inert = true
      menu.setAttribute('aria-hidden', 'true')
      if (open()) menu.hidePopover()
      for (const [name, value] of previous) {
        if (value === null) view.dom.removeAttribute(name)
        else view.dom.setAttribute(name, value)
      }
      previous = new Map()
    }
    const dismiss = () => {
      cancel?.()
      cancel = null
      pending = false
      cancelAnimationFrame(frame)
      frame = 0
      hide()
    }
    const capture = (
      trigger: CompletionRequest['trigger'],
    ): CompletionRequest | null => {
      const context = completionContext.current
      if (
        disposed ||
        !completionBroker.hasProviders() ||
        editor.isDestroyed ||
        context.paneMode === 'markdown' ||
        context.disabled ||
        context.splitReadOnly ||
        context.projectionReadOnly ||
        !context.plainSyncEligible ||
        markdownSyntax.version() !== context.syntaxVersion ||
        !editor.isEditable ||
        view.composing ||
        !view.hasFocus()
      )
        return null
      const target = documentRuntime.captureActiveView()
      if (
        !target ||
        target.viewId !== context.viewId ||
        !documentRuntime.isLiveView(target) ||
        !flushRich(editor)
      )
        return null
      const current = documentRuntime.get(context.tabId)
      const source = documentRuntime.session(context.tabId)?.snapshot()
      const selection = view.state.selection
      if (
        !current ||
        !source ||
        current.contentVersion !== source.version ||
        !(selection instanceof TextSelection) ||
        !selection.empty ||
        !selection.$head.parent.isTextblock ||
        selection.$head.parent.type.spec.code ||
        selection.$head.marks().some((mark) => mark.type.spec.code)
      )
        return null
      if (!plainSync.current)
        plainSync.current = createPlainSourceSync(
          source,
          view.state.doc,
          serializeCompletionSource(view.state.doc),
        )
      if (
        plainSync.current?.map(
          source,
          view.state.doc,
          selection.head,
          'rich',
        ) == null
      )
        return null
      const parent = selection.$head.parent
      const offset = selection.$head.parentOffset
      return {
        view: target,
        contentVersion: current.contentVersion,
        editor: 'rich',
        documentLength: view.state.doc.content.size,
        selection: { anchor: selection.anchor, head: selection.head },
        before: parent.textBetween(Math.max(0, offset - 128), offset),
        after: parent.textBetween(
          offset,
          Math.min(parent.content.size, offset + 128),
        ),
        trigger,
      }
    }
    const same = (left: CompletionRequest, right: CompletionRequest | null) =>
      !!right &&
      left.view.documentId === right.view.documentId &&
      left.view.documentGeneration === right.view.documentGeneration &&
      left.view.viewId === right.view.viewId &&
      left.view.viewGeneration === right.view.viewGeneration &&
      left.contentVersion === right.contentVersion &&
      left.documentLength === right.documentLength &&
      left.selection.anchor === right.selection.anchor &&
      left.selection.head === right.selection.head
    const range = (item: CompletionItem, request: CompletionRequest) => {
      if (
        item.to !== request.selection.head ||
        item.from > item.to ||
        /[\r\n]/.test(item.insertText)
      )
        return null
      const document = view.state.doc
      const from = document.resolve(item.from)
      const to = document.resolve(item.to)
      if (
        !from.sameParent(to) ||
        from.depth !== 1 ||
        !from.parent.isTextblock ||
        from.parent.type.spec.code
      )
        return null
      const source = documentRuntime
        .session(completionContext.current.tabId)
        ?.snapshot()
      if (!source || source.version !== request.contentVersion) return null
      const rawFrom = plainSync.current?.map(
        source,
        document,
        item.from,
        'rich',
      )
      const rawTo = plainSync.current?.map(source, document, item.to, 'rich')
      if (
        rawFrom == null ||
        rawTo == null ||
        rawFrom > rawTo ||
        source.sliceRaw(rawFrom, rawTo) !==
          document.textBetween(item.from, item.to)
      )
        return null
      return { source, rawFrom, rawTo }
    }
    const reposition = () => {
      if (!visible || !open() || view.isDestroyed) return
      const rect = view.coordsAtPos(visible.request.selection.head)
      const bounds = menu.getBoundingClientRect()
      const left = Math.max(
        8,
        Math.min(rect.left, innerWidth - bounds.width - 8),
      )
      const below = rect.bottom + 6
      const top =
        below + bounds.height <= innerHeight - 8
          ? below
          : rect.top - bounds.height - 6
      menu.style.left = `${left}px`
      menu.style.top = `${Math.max(8, top)}px`
    }
    const select = (index: number) => {
      if (!visible?.items.length) return
      selected = (index + visible.items.length) % visible.items.length
      for (const [position, option] of [...menu.children].entries()) {
        const active = position === selected
        option.setAttribute('aria-selected', String(active))
        const element = option as HTMLElement
        element.style.background = active ? 'var(--active)' : ''
      }
      const option = menu.children[selected]
      if (option) {
        view.dom.setAttribute('aria-activedescendant', option.id)
        option.scrollIntoView({ block: 'nearest' })
      }
    }
    const accept = (index: number) => {
      const shown = visible
      const item = shown?.items[index]
      if (
        !shown ||
        !item ||
        !same(shown.request, capture(shown.request.trigger))
      ) {
        dismiss()
        return
      }
      const mapped = range(item, shown.request)
      if (!mapped) {
        dismiss()
        return
      }
      try {
        const proposed =
          mapped.source.sliceRaw(0, mapped.rawFrom) +
          item.insertText +
          mapped.source.sliceRaw(mapped.rawTo, mapped.source.utf16Length)
        const projection = projectMarkdown(
          proposed,
          completionContext.current.markdownExtensions,
        )
        const transaction = closeHistory(view.state.tr).insertText(
          item.insertText,
          item.from,
          item.to,
        )
        if (
          projection.readOnly ||
          projection.serialize(projection.content) !== proposed ||
          !editor.schema
            .nodeFromJSON(manager.parse(projection.content))
            .eq(transaction.doc)
        )
          throw new Error('This completion needs Source view.')
        dismiss()
        richHistoryGroup.current.id = ''
        view.dispatch(transaction)
        richHistoryGroup.current.id = ''
        view.dispatch(closeHistory(view.state.tr))
        view.focus()
      } catch {
        dismiss()
        setRichInputError('This completion needs Source view.')
      }
    }
    const publish = (update: CompletionUpdate) => {
      if (update.done) pending = false
      if (disposed || !same(update.request, capture(update.request.trigger))) {
        hide()
        return
      }
      const items = update.items.filter((item) => range(item, update.request))
      if (!items.length) {
        hide()
        return
      }
      visible = { request: update.request, items }
      selected = Math.min(selected, items.length - 1)
      menu.replaceChildren(
        ...items.map((item, index) => {
          const option = document.createElement('div')
          option.id = `${menu.id}-${index}`
          option.setAttribute('role', 'option')
          option.className = 'command-copy'
          const label = document.createElement('span')
          label.className = 'command-label'
          label.textContent = item.label
          option.append(label)
          if (item.detail) {
            const detail = document.createElement('span')
            detail.className = 'command-detail'
            detail.textContent = item.detail
            option.append(detail)
          }
          option.addEventListener('pointermove', () => select(index))
          option.addEventListener('click', () => accept(index))
          return option
        }),
      )
      if (!open()) {
        previous = new Map(
          attributes.map((name) => [name, view.dom.getAttribute(name)]),
        )
        view.dom.setAttribute('aria-controls', menu.id)
        view.dom.setAttribute('aria-autocomplete', 'list')
        view.dom.setAttribute('aria-haspopup', 'listbox')
        menu.inert = false
        menu.removeAttribute('aria-hidden')
        menu.showPopover()
      }
      select(selected)
      reposition()
    }
    const request = (trigger: CompletionRequest['trigger']) => {
      if (!completionBroker.hasProviders()) return false
      dismiss()
      cancel = completionBroker.request(
        () => capture(trigger),
        () => capture(trigger),
        publish,
      )
      pending = !!cancel
      return !!cancel
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!completionBroker.hasProviders()) return
      if (event.isComposing || view.composing) {
        dismiss()
        return
      }
      if (
        event.key === ' ' &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        if (request({ kind: 'explicit' })) {
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }
      if (event.key === 'Escape' && (visible || pending)) {
        dismiss()
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (visible && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          select(selected + (event.key === 'ArrowDown' ? 1 : -1))
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          accept(selected)
          event.preventDefault()
          event.stopPropagation()
          return
        }
      }
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        [...event.key].length === 1
      ) {
        typed = event.key
        const character = typed
        setTimeout(() => {
          if (typed === character) typed = null
        }, 0)
      } else typed = null
    }
    const onTransaction = ({ transaction }: EditorEvents['transaction']) => {
      if (!completionBroker.hasProviders()) return
      if (!transaction.docChanged && !transaction.selectionSet) return
      const character = transaction.docChanged ? typed : null
      typed = null
      dismiss()
      if (!character) return
      const head = view.state.selection.head
      frame = requestAnimationFrame(() => {
        frame = 0
        if (view.state.selection.head === head)
          request({ kind: 'input', character })
      })
    }
    const onOutside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node)) dismiss()
    }
    const onScroll = () => reposition()
    menu.addEventListener('pointerdown', (event) => event.preventDefault())
    view.dom.addEventListener('keydown', onKeyDown, true)
    view.dom.addEventListener('blur', dismiss)
    view.dom.addEventListener('hibi:editor-actions-open', dismiss)
    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', reposition)
    window.addEventListener('blur', dismiss)
    editor.on('transaction', onTransaction)
    return () => {
      disposed = true
      dismiss()
      editor.off('transaction', onTransaction)
      view.dom.removeEventListener('keydown', onKeyDown, true)
      view.dom.removeEventListener('blur', dismiss)
      view.dom.removeEventListener('hibi:editor-actions-open', dismiss)
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('blur', dismiss)
      menu.remove()
    }
  }, [editor, markdownDocument])
  useEffect(() => {
    const manager = editor?.markdown
    if (!editor || !manager || !markdownDocument) return
    const view = editor.view
    const serialize = markdownSerializer(manager, true)
    const scope = documentEdits.scope(() => false)
    const capture = (position: number): EditorInteractionRequest | null => {
      const context = completionContext.current
      if (
        editor.isDestroyed ||
        context.paneMode === 'markdown' ||
        context.disabled ||
        context.splitReadOnly ||
        context.projectionReadOnly ||
        !context.plainSyncEligible ||
        markdownSyntax.version() !== context.syntaxVersion ||
        !editor.isEditable ||
        view.composing ||
        !view.hasFocus() ||
        !richSourceCurrent(editor) ||
        !Number.isSafeInteger(position) ||
        position < 0 ||
        position > view.state.doc.content.size
      )
        return null
      const target = documentRuntime.captureActiveView()
      const current = documentRuntime.get(context.tabId)
      const source = documentRuntime.session(context.tabId)?.snapshot()
      const selection = view.state.selection
      if (
        !target ||
        target.viewId !== context.viewId ||
        !documentRuntime.isLiveView(target) ||
        !current ||
        !source ||
        current.contentVersion !== source.version ||
        !(selection instanceof TextSelection) ||
        !selection.$from.sameParent(selection.$to) ||
        !selection.$from.parent.isTextblock ||
        selection.$from.parent.type.spec.code ||
        selection.$from.marks().some((mark) => mark.type.spec.code)
      )
        return null
      const at = view.state.doc.resolve(position)
      if (!at.parent.isTextblock || at.parent.type.spec.code) return null
      if (!plainSync.current)
        plainSync.current = createPlainSourceSync(
          source,
          view.state.doc,
          serialize(view.state.doc),
        )
      if (
        plainSync.current?.map(source, view.state.doc, position, 'rich') == null
      )
        return null
      const offset = at.parentOffset
      return {
        view: target,
        contentVersion: current.contentVersion,
        editor: 'rich',
        documentLength: view.state.doc.content.size,
        position,
        selection: { anchor: selection.anchor, head: selection.head },
        before: at.parent.textBetween(Math.max(0, offset - 128), offset),
        after: at.parent.textBetween(
          offset,
          Math.min(at.parent.content.size, offset + 128),
        ),
        selectedText: view.state.doc.textBetween(selection.from, selection.to),
      }
    }
    const apply = (
      action: EditorContextAction,
      request: EditorInteractionRequest,
    ) => {
      if (!sameInteraction(request, capture(request.position))) return false
      const source = documentRuntime
        .session(completionContext.current.tabId)
        ?.snapshot()
      if (!source || source.version !== request.contentVersion) return false
      const { from, to, insertText } = action.edit
      if (/[\r\n]/.test(insertText)) return false
      const start = view.state.doc.resolve(from)
      const end = view.state.doc.resolve(to)
      if (!start.sameParent(end) || !start.parent.isTextblock) return false
      const rawFrom = plainSync.current?.map(
        source,
        view.state.doc,
        from,
        'rich',
      )
      const rawTo = plainSync.current?.map(source, view.state.doc, to, 'rich')
      if (
        rawFrom == null ||
        rawTo == null ||
        rawFrom > rawTo ||
        source.sliceRaw(rawFrom, rawTo) !== view.state.doc.textBetween(from, to)
      )
        return false
      const current = documentRuntime.get(completionContext.current.tabId)
      if (!current) return false
      const result = scope.apply({
        requestId: crypto.randomUUID(),
        tabId: current.tabId,
        revision: current.revision,
        contentVersion: source.version,
        changes: [
          {
            from: rawFrom,
            to: rawTo,
            expectedText: source.sliceRaw(rawFrom, rawTo),
            insert: insertText,
          },
        ],
      })
      if (result.status !== 'applied') setRichInputError(result.message)
      return result.status === 'applied'
    }
    let detach = () => {}
    let generation = 0
    let disposed = false
    const refresh = () => {
      const current = ++generation
      detach()
      detach = () => {}
      if (!hasEditorInteractionProviders()) return
      void import('./editor-interactions')
        .then(({ attachEditorInteractions }) => {
          if (
            disposed ||
            current !== generation ||
            !hasEditorInteractionProviders()
          )
            return
          detach = attachEditorInteractions({
            element: view.dom,
            positionAt: (x, y) => {
              const result = view.posAtCoords({ left: x, top: y })
              return result && result.inside >= 0 ? result.pos : null
            },
            anchorAt: (position) => view.coordsAtPos(position),
            selectionPosition: () => view.state.selection.head,
            capture,
            apply,
            focus: () => view.focus(),
          })
        })
        .catch((error) => setRichInputError(String(error)))
    }
    const unsubscribe = onEditorInteractionProvidersChanged(refresh)
    refresh()
    const invalidate = () =>
      view.dom.dispatchEvent(new Event('hibi:editor-interactions-invalidate'))
    editor.on('transaction', invalidate)
    return () => {
      disposed = true
      unsubscribe()
      editor.off('transaction', invalidate)
      detach()
      scope.dispose()
    }
  }, [editor, markdownDocument])
  // biome-ignore lint/correctness/useExhaustiveDependencies: maps belong to this rich editor and syntax generation.
  const positions = useMemo<MarkdownPositionLookup>(() => {
    const fallback = createMarkdownPositionCache()
    return (source, document) => (position, from) => {
      const snapshot = documentRuntime.session(documentState.tabId)?.snapshot()
      const exact =
        snapshot && markdownSyntax.version() === syntaxVersion
          ? plainSync.current?.map(snapshot, document, position, from)
          : null
      return exact ?? fallback(source, document)(position, from)
    }
  }, [editor, syntaxVersion])
  const geometryContent = useMemo(
    () => () => {
      if (!editor || !richSourceCurrent(editor)) return null
      const current = documentRuntime.get(documentState.tabId)
      const text = scrollContent.current
      return current &&
        text.document.contentVersion === current.contentVersion &&
        text.document.tabId === current.tabId &&
        text.document.revision === current.revision
        ? text
        : null
    },
    [editor, documentState.tabId],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: delayed document props publish fresh geometry independently of rich transactions.
  useLayoutEffect(() => {
    content.current?.dispatchEvent(
      new Event('hibi:rich-content', { bubbles: true }),
    )
  }, [content, documentState, projection.content])
  const sourceOutline = useRef<{
    version: number
    headings: readonly SourceOutlineHeading[]
  } | null>(null)
  function prepareRich({
    editor,
    transaction,
    nextState,
  }: EditorEvents['beforeTransaction']): AcceptedSourceEdit | null {
    pendingPlainSync.current = null
    if (!markdownDocument) return null
    const known = richSourceSnapshot(editor),
      session = documentRuntime.session(documentState.tabId),
      current = session?.snapshot()
    if (
      !known ||
      !current ||
      known.version !== current.version ||
      known.document.tabId !== current.document.tabId ||
      known.document.revision !== current.document.revision
    )
      throw new Error(
        'The editor is still synchronizing. Retry before editing this view.',
      )
    if (exactSource.current && !exactSource.current.document.eq(nextState.doc))
      throw new Error(
        'An editor extension changed this edit. Review the document before continuing.',
      )
    const step = transaction.steps[0]
    const typing =
      !exactSource.current &&
      transaction.steps.length === 1 &&
      step instanceof ReplaceStep &&
      step.slice.content.childCount <= 1 &&
      (!step.slice.content.firstChild ||
        step.slice.content.firstChild.isText) &&
      !transaction.getMeta('uiEvent')
    const nativeComposition = transaction.getMeta('composition')
    const composition =
      typeof nativeComposition === 'number' ? nativeComposition : undefined
    const previous = richHistoryGroup.current
    const groupAt = (now: number) => {
      if (
        !previous.id ||
        composition !== previous.composition ||
        (!typing && composition === undefined) ||
        (composition === undefined && now - previous.time > 500)
      )
        previous.id = crypto.randomUUID()
      previous.composition = composition
    }
    const direct =
      typing &&
      plainSyncEligible &&
      !exactHistory.current.get(editor)?.size &&
      markdownSyntax.version() === syntaxVersion
        ? plainSync.current?.planVisual(
            current,
            editor.state,
            transaction,
            nextState.doc,
            (text) =>
              editor.markdown!.renderNodeToMarkdown(
                { type: 'text', text },
                { type: 'paragraph' },
              ),
          )
        : null
    if (direct && session) {
      const now = performance.now()
      groupAt(now)
      const accepted = performanceDiagnostics.measure(
        'core',
        'document update',
        () =>
          session.beginEdit(
            [direct.change],
            'visual',
            previous.id,
            undefined,
            viewId,
          ),
      )
      try {
        const certificate = direct.certify(accepted.prepared)
        if (certificate)
          pendingPlainSync.current = {
            editor,
            source: accepted.prepared.after,
            document: nextState.doc,
            certificate,
            deferEcho: true,
          }
      } catch {
        plainSync.current = null
      }
      previous.time = now
      setRichInputError('')
      return accepted
    }
    let serialize = serializers.current.get(editor)
    if (!serialize) {
      serialize = markdownSerializer(
        editor.markdown!,
        richSyntaxCompatible &&
          flavors.every((flavor) => flavor.serialization === 'block-local'),
      )
      serializers.current.set(editor, serialize)
    }
    const serialized = performanceDiagnostics.measure(
      'core',
      'Markdown serialization',
      () => serialize(nextState.doc),
    )
    const preserved =
      exactSource.current ??
      exactHistory.current.get(editor)?.get(serialized.source)
    const currentSource =
      documentRuntime.get(documentState.tabId)?.markdown ?? value
    const projection = projectMarkdown(currentSource, markdownExtensions)
    const original = projection.content
    let body = serialized.source
    if (
      plainSyncEligible &&
      !preserved?.document.eq(nextState.doc) &&
      original !== body
    ) {
      const before = serialize(editor.state.doc).source
      if (original !== before) {
        const baseline = editor.schema.nodeFromJSON(
          editor.markdown!.parse(original),
        )
        const patched = baseline.eq(editor.state.doc)
          ? preserveRichSource(original, before, body, (candidate) =>
              editor.schema
                .nodeFromJSON(editor.markdown!.parse(candidate))
                .eq(nextState.doc),
            )
          : null
        if (patched === null) {
          if (
            !(editor.state.selection instanceof AllSelection) ||
            !editor.schema
              .nodeFromJSON(editor.markdown!.parse(body))
              .eq(nextState.doc)
          )
            throw new Error(
              'This edit would rewrite other Markdown. Use Source view for this document.',
            )
        } else body = patched
      }
    }
    const source = preserved?.document.eq(nextState.doc)
      ? preserved.source
      : projection.serialize(body)
    const now = performance.now()
    groupAt(now)
    const accepted = performanceDiagnostics.measure(
      'core',
      'document update',
      () =>
        documentRuntime.beginReplace(
          source,
          previous.id,
          documentState.tabId,
          viewId,
        ),
    )
    // Regional proof is optional. Its failure must not strand an accepted source edit.
    try {
      const certificate =
        accepted && markdownSyntax.version() === syntaxVersion
          ? plainSync.current?.advance(
              accepted.prepared,
              editor.state,
              transaction,
              nextState.doc,
              (body) => parseParagraph(editor, body),
            )
          : null
      if (accepted && certificate)
        pendingPlainSync.current = {
          editor,
          source: accepted.prepared.after,
          document: nextState.doc,
          certificate,
        }
    } catch {
      plainSync.current = null
    }
    previous.time = now
    if (!typing && composition === undefined) previous.id = ''
    setRichInputError('')
    return accepted
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: attachment replacements invalidate codecs even when their compatibility flags match.
  useLayoutEffect(() => {
    pendingPlainSync.current = null
    if (!editor?.markdown || !markdownDocument || paneMode === 'markdown')
      return
    const serialize = markdownSerializer(
      editor.markdown,
      richSyntaxCompatible &&
        flavors.every((flavor) => flavor.serialization === 'block-local'),
    )
    serializers.current.set(editor, serialize)
    performanceDiagnostics.measure(
      'core',
      'Markdown cache initialization',
      () => serialize(editor.state.doc),
    )
  }, [
    editor,
    markdownDocument,
    paneMode,
    flavors,
    richSyntaxCompatible,
    richExtensions,
  ])
  useLayoutEffect(() => {
    const session = documentRuntime.session(documentState.tabId)
    const retained = retainedPreview.current
    retainedPreview.current = null
    if (!editor || !markdownDocument || !session) return
    const identity = session.snapshot().document
    if (
      identity.tabId !== documentState.tabId ||
      identity.revision !== documentState.revision
    )
      return
    const visible = paneMode !== 'markdown'
    let disposed = false,
      scheduled = false,
      syncing = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let preview: {
      snapshot: SourceSnapshot
      selection: SourceSelection
    } | null =
      retained?.editor === editor &&
      retained.session === session &&
      retained.snapshot.document.tabId === identity.tabId &&
      retained.snapshot.document.revision === identity.revision &&
      retained.snapshot.version === session.snapshot().version
        ? retained
        : null
    const canWait =
      paneMode === 'side-by-side' &&
      plainSyncEligible &&
      !projectionReadOnly &&
      !disabled &&
      !richExtensionError &&
      richExtensions.every((extension) =>
        ['word-count.text', 'slash-commands.menu', 'tags.highlights'].includes(
          extension.id,
        ),
      )
    plainSync.current = null
    pendingPlainSync.current = null
    const matches = (snapshot: SourceSnapshot) => {
      const known = richSourceSnapshot(editor)
      return (
        known?.version === snapshot.version &&
        known.document.tabId === snapshot.document.tabId &&
        known.document.revision === snapshot.document.revision
      )
    }
    const certify = (snapshot: SourceSnapshot) => {
      if (
        !plainSyncEligible ||
        !editor.markdown ||
        markdownSyntax.version() !== syntaxVersion
      )
        return
      let serialize = serializers.current.get(editor)
      if (!serialize) {
        serialize = markdownSerializer(editor.markdown, true)
        serializers.current.set(editor, serialize)
      }
      plainSync.current = createPlainSourceSync(
        snapshot,
        editor.state.doc,
        serialize(editor.state.doc),
      )
    }
    const sync = () => {
      clearTimeout(timer)
      timer = undefined
      scheduled = false
      if (disposed || editor.isDestroyed || syncing) return
      if (matches(session.snapshot())) {
        preview = null
        setRichInputError('')
        if (!plainSync.current) certify(session.snapshot())
        updateRichEditable()
        return
      }
      const snapshot = session.snapshot(),
        source = snapshot.materialize(),
        projected = projectMarkdown(source, markdownExtensions),
        bookmark = preview?.selection.ranges[0]
      syncing = true
      try {
        editor
          .chain()
          .setContent(projected.content, {
            contentType: 'markdown',
            emitUpdate: false,
          })
          .command(({ tr }) => {
            if (bookmark) {
              const offset =
                projected.sourceOffset ?? source.lastIndexOf(projected.content)
              const map = positions(projected.content, tr.doc)
              const anchor =
                offset < 0 ? null : map(bookmark.anchor - offset, 'source')
              const head =
                offset < 0 ? null : map(bookmark.head - offset, 'source')
              if (anchor !== null && head !== null)
                tr.setSelection(
                  TextSelection.between(
                    tr.doc.resolve(anchor),
                    tr.doc.resolve(head),
                  ),
                )
            }
            tr.setMeta(richSourceEcho, snapshot).setMeta('addToHistory', false)
            return true
          })
          .run()
      } catch (error) {
        setRichInputError(
          error instanceof Error ? error.message : String(error),
        )
      } finally {
        syncing = false
      }
      richHistoryGroup.current.id = ''
      plainSync.current = null
      if (matches(snapshot)) {
        preview = null
        certify(snapshot)
      }
      updateRichEditable()
    }
    retryRich.current = visible ? sync : () => {}
    const flush = () => {
      if (preview || scheduled) sync()
    }
    const removeSync = visible ? registerRichSync(editor, flush) : undefined
    const pane = visible ? editor.view.dom.closest('.rich-pane') : null
    const beforeInput = (event: Event) => {
      flush()
      if (!richSourceCurrent(editor) && event.cancelable) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    const events = [
      'pointerenter',
      'pointerdown',
      'focus',
      'keydown',
      'beforeinput',
      'paste',
      'drop',
    ]
    for (const event of events) pane?.addEventListener(event, beforeInput, true)
    const remove = session.subscribeOperations((prepared) => {
      if (prepared.operation.origin === 'visual' && matches(prepared.after)) {
        if (!plainSync.current?.matches(prepared.after, editor.state.doc))
          plainSync.current = null
        return
      }
      if (preview) {
        preview = {
          snapshot: prepared.after,
          selection: mapSourceSelection(
            prepared.after,
            preview.selection,
            prepared.operation.changes,
          )!,
        }
      }
      // Hidden rich state stays untouched; only its pending raw selection advances.
      if (!visible) return
      const active = window.document.activeElement
      if (
        canWait &&
        (prepared.operation.origin === 'source' ||
          prepared.operation.origin === 'composition') &&
        active instanceof HTMLElement &&
        active.classList.contains('cm-content') &&
        content.current?.contains(active)
      ) {
        if (!preview && editor.state.selection instanceof TextSelection) {
          const selection = editor.state.selection
          const anchor = plainSync.current?.map(
            prepared.before,
            editor.state.doc,
            selection.anchor,
            'rich',
          )
          const head = plainSync.current?.map(
            prepared.before,
            editor.state.doc,
            selection.head,
            'rich',
          )
          if (anchor != null && head != null)
            preview = {
              snapshot: prepared.after,
              selection: mapSourceSelection(
                prepared.after,
                {
                  ranges: [{ anchor, head, association: 1 }],
                  mainIndex: 0,
                },
                prepared.operation.changes,
              )!,
            }
        }
        if (preview) {
          plainSync.current = null
          clearTimeout(timer)
          timer = setTimeout(sync, 200)
          return
        }
      }
      if (preview) {
        sync()
        return
      }
      const incremental =
        markdownSyntax.version() === syntaxVersion
          ? plainSync.current?.prepare(prepared, editor.state, (source) =>
              parseParagraph(editor, source),
            )
          : null
      if (incremental) {
        editor.view.dispatch(
          incremental.transaction
            .setMeta(richSourceEcho, prepared.after)
            .setMeta('preventUpdate', true),
        )
        plainSync.current =
          matches(prepared.after) &&
          editor.state.doc === incremental.transaction.doc
            ? incremental.next
            : null
        richHistoryGroup.current.id = ''
        return
      }
      plainSync.current = null
      if (
        prepared.operation.origin === 'undo' ||
        prepared.operation.origin === 'redo'
      )
        sync()
      else if (!scheduled) {
        scheduled = true
        queueMicrotask(sync)
      }
    })
    const removeStorage = session.subscribeStorage((change) => {
      if (preview?.snapshot === change.before) preview.snapshot = change.after
      pendingPlainSync.current = null
      plainSync.current =
        markdownSyntax.version() === syntaxVersion
          ? (plainSync.current?.adoptStorage(change, editor.state.doc) ?? null)
          : null
    })
    // Explicit view/configuration changes synchronize immediately; source typing may catch up.
    if (visible) sync()
    return () => {
      disposed = true
      clearTimeout(timer)
      retainedPreview.current = preview ? { editor, session, ...preview } : null
      plainSync.current = null
      pendingPlainSync.current = null
      retryRich.current = () => {}
      removeSync?.()
      for (const event of events)
        pane?.removeEventListener(event, beforeInput, true)
      remove()
      removeStorage()
    }
  }, [
    editor,
    markdownDocument,
    markdownExtensions,
    paneMode,
    plainSyncEligible,
    projectionReadOnly,
    disabled,
    richExtensionError,
    richExtensions,
    syntaxVersion,
    documentState.tabId,
    documentState.revision,
    content,
    positions,
    updateRichEditable,
  ])
  const richEditContext = useRef({
    document: documentState,
    mode,
    findTarget,
    disabled,
    projectionReadOnly,
    markdownExtensions,
  })
  richEditContext.current = {
    document: documentState,
    mode,
    findTarget,
    disabled,
    projectionReadOnly,
    markdownExtensions,
  }
  useEffect(() => {
    if (!editor?.markdown || !markdownDocument) return
    const body = () => {
      const context = richEditContext.current
      const current = editorDocument.get()
      if (
        editor.isDestroyed ||
        context.findTarget !== 'rich' ||
        context.mode === 'markdown' ||
        context.disabled ||
        context.projectionReadOnly ||
        !editor.isEditable ||
        !current ||
        current.tabId !== context.document.tabId ||
        current.revision !== context.document.revision
      )
        return null
      if (!flushRich(editor)) return null
      const projection = projectMarkdown(
        current.markdown,
        context.markdownExtensions,
      )
      if (
        projection.readOnly ||
        projection.sourceOffset === undefined ||
        projection.serialize(projection.content) !== current.markdown
      )
        return null
      return { current, projection }
    }
    const removeAnnotations = observeRichAnnotations(
      editor,
      () => body()?.projection ?? null,
    )
    const removeProjection = documentProjections.register('rich', (cached) => {
      const value = body()
      return value
        ? (cached ??
            textProjection(
              value.projection.content,
              true,
              value.projection.sourceOffset,
            ))
        : null
    })
    const removeEdits = documentEdits.register((request) => {
      const value = body()
      const unsupported = {
        status: 'unsupported-view' as const,
        message: 'This range needs source view.',
      }
      if (!value) return unsupported
      const { current, projection } = value
      if (!sourceEditMatches(request, current))
        return {
          status: 'stale',
          message: 'The document changed. Review the edits again.',
        }
      if (editor.view.composing)
        return {
          status: 'composing',
          message: 'Finish composing text before applying edits.',
        }
      if (request.changes.length > 32) return unsupported
      try {
        const source = editedSource(
          current.markdown,
          request.changes,
          MAX_DOCUMENT_BYTES,
        )
        if (source === current.markdown)
          return { status: 'applied', contentVersion: current.contentVersion }
        const offset = projection.sourceOffset!
        const suffix =
          current.markdown.length - offset - projection.content.length
        const nextBody = source.slice(offset, source.length - suffix)
        if (projection.serialize(nextBody) !== source) return unsupported
        const ranges = request.changes.map((change) => {
          if (/[\r\n]/.test(change.insert)) return null
          const range = exactRichRange(
            editor.state.doc,
            editor.markdown!,
            projection.content,
            change.from - offset,
            change.to - offset,
          )
          return range ? { ...range, insert: change.insert } : null
        })
        if (ranges.some((range) => !range)) return unsupported
        const tr = closeHistory(editor.state.tr)
        let boundary = editor.state.doc.content.size + 1
        for (const range of ranges.toReversed()) {
          if (!range || range.to > boundary) return unsupported
          boundary = range.from
          if (range.insert)
            tr.replaceWith(
              range.from,
              range.to,
              editor.schema.text(range.insert, range.marks),
            )
          else tr.delete(range.from, range.to)
        }
        const expected = editor.schema.nodeFromJSON(
          editor.markdown!.parse(nextBody),
        )
        if (
          !tr.doc.eq(expected) ||
          !editor.state.applyTransaction(tr).state.doc.eq(expected)
        )
          return unsupported
        let history = exactHistory.current.get(editor)
        if (!history) {
          history = new Map()
          exactHistory.current.set(editor, history)
        }
        history.set(editor.markdown!.serialize(editor.state.doc.toJSON()), {
          source: current.markdown,
          document: editor.state.doc,
        })
        history.set(editor.markdown!.serialize(expected.toJSON()), {
          source,
          document: expected,
        })
        let size = [...history].reduce(
          (size, [body, entry]) => size + body.length + entry.source.length,
          0,
        )
        while (history.size > 32 || size > 8 * 1024 * 1024) {
          const first = history.keys().next().value!
          size -= first.length + history.get(first)!.source.length
          history.delete(first)
        }
        exactSource.current = { source, document: expected }
        editor.view.dispatch(tr)
        editor.view.dispatch(closeHistory(editor.state.tr))
        if (!editor.state.doc.eq(expected))
          return {
            status: 'invalid',
            message:
              'An editor extension changed this edit. Review the document before continuing.',
          }
        return {
          status: 'applied',
          contentVersion: editorDocument.get()!.contentVersion,
        }
      } catch (error) {
        return { status: 'invalid', message: String(error) }
      } finally {
        exactSource.current = null
      }
    }, 'rich')
    return () => {
      removeEdits()
      removeProjection()
      removeAnnotations()
    }
  }, [editor, markdownDocument])
  // biome-ignore lint/correctness/useExhaustiveDependencies: initial focus belongs to this editor instance, never subsequent mode or document updates.
  useLayoutEffect(() => {
    if (!editor || !markdownDocument || paneMode === 'markdown') return
    const focus = () => {
      if (editor.isDestroyed || !editor.view.dom.isConnected) return
      const active = window.document.activeElement
      if (
        active?.closest(
          '.settings-screen, [role="dialog"], .source-pane, input, textarea, select',
        )
      )
        return
      editor.view.dispatch(
        editor.state.tr
          .setSelection(TextSelection.atEnd(editor.state.doc))
          .setMeta('addToHistory', false),
      )
      editor.view.focus()
    }
    editor.on('mount', focus)
    focus()
    return () => {
      editor.off('mount', focus)
    }
  }, [editor])
  // biome-ignore lint/correctness/useExhaustiveDependencies: parser ownership and syntax preferences change independently of its source snapshot.
  useEffect(() => {
    if (
      paneMode !== 'markdown' ||
      !markdownDocument ||
      !outlineActive ||
      !sourceReady
    )
      return
    const session = documentRuntime.session(documentState.tabId)
    if (!session) return
    const semantics =
      outlineSyntax && createMarkdownSemantics(flavors, documentState.revision)
    if (!outlineSyntax || !semantics) {
      sourceOutline.current = null
      onOutline([])
      onActiveOutline(null)
      onOutlineUnavailable?.(
        'Source outline is unavailable for the active addon syntax. Switch to visual mode to see its headings.',
      )
      return
    }
    onOutlineUnavailable?.(null)
    const model = new SourceOutlineModel(session.snapshot(), {
      ...outlineSyntax,
      renderLabel: (tokens, level) =>
        semantics.read(
          [
            {
              type: 'heading',
              raw: '',
              text: '',
              depth: level,
              tokens: [...tokens],
            },
          ],
          { before: false, after: false },
        )?.headings[0]?.label ?? null,
      disabled: markdownSyntax
        .snapshot()
        .filter((feature) => !feature.enabled)
        .map((feature) => feature.id),
    })
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | null = null,
      idle: number | null = null,
      work: ReturnType<SourceOutlineModel['read']> | null = null,
      referenceValue: ReferenceValue | null | undefined,
      referenceAbort = new AbortController()
    const root = content.current
    const reportActive = () => {
      const current = sourceOutline.current,
        element = root?.querySelector<HTMLElement>('.cm-content'),
        view = element && sourceView(element)
      onActiveOutline(
        current?.version === session.snapshot().version && view
          ? (outlineHeadingAt(
              current.headings,
              sourcePosition(view, view.state.selection.main.head),
              (heading) => heading.from,
            )?.id ?? null)
          : null,
      )
    }
    const cancel = () => {
      referenceAbort.abort()
      referenceAbort = new AbortController()
      referenceValue = undefined
      if (timer !== null) clearTimeout(timer)
      if (idle !== null) cancelIdleCallback(idle)
      timer = idle = null
      work?.return([])
      work = null
    }
    const queue = () => {
      if (typeof requestIdleCallback === 'function')
        idle = requestIdleCallback(read, { timeout: 16 })
      else timer = setTimeout(read, 16)
    }
    const read = () => {
      timer = idle = null
      if (disposed) return
      work ??= model.read()
      const started = performance.now(),
        version = session.snapshot().version
      try {
        do {
          const step = work.next(referenceValue)
          referenceValue = undefined
          if (step.done) {
            work = null
            if (version !== session.snapshot().version) return
            const headings = step.value.map((heading) => ({
              ...heading,
              id: `${heading.id}:${version}`,
            }))
            sourceOutline.current = { version, headings }
            onOutlineUnavailable?.(null)
            onOutline(headings)
            reportActive()
            return
          }
          if (step.value) {
            const pending = work,
              element = root?.querySelector<HTMLElement>('.cm-content'),
              view = element && sourceView(element)
            if (!view)
              throw new Error('Source outline reference lookup is unavailable.')
            void resolveSourceReference(
              view,
              outlineSyntax,
              step.value.reference,
              referenceAbort.signal,
            ).then((result) => {
              if (
                disposed ||
                work !== pending ||
                version !== session.snapshot().version
              )
                return
              if (result.status !== 'resolved') {
                cancel()
                if (result.status === 'unavailable')
                  onOutlineUnavailable?.(
                    'Source outline could not resolve this note’s references. Reopen the outline to retry.',
                  )
                return
              }
              referenceValue = result.value
              queue()
            })
            return
          }
        } while (performance.now() - started < 2)
        // Continue a started read on the next task; waiting for idle between
        // every short slice makes large outlines stall on busy pages.
        timer = setTimeout(read, 0)
      } catch (error) {
        work = null
        sourceOutline.current = null
        onOutline([])
        onActiveOutline(null)
        onOutlineUnavailable?.(
          'Source outline could not read this note’s syntax. Switch to visual mode to see its headings.',
        )
        console.error('Source outline failed:', error)
      }
    }
    const schedule = () => {
      cancel()
      timer = setTimeout(queue, 120)
    }
    const removeOperations = session.subscribeOperations((prepared) => {
      cancel()
      sourceOutline.current = null
      model.apply(prepared)
      schedule()
    })
    const removeStorage = session.subscribeStorage((change) => {
      cancel()
      model.adoptStorage(change)
      schedule()
    })
    sourceOutline.current = null
    onOutline([])
    onActiveOutline(null)
    root?.addEventListener('hibi:source-caret', reportActive)
    schedule()
    return () => {
      disposed = true
      cancel()
      sourceOutline.current = null
      removeOperations()
      removeStorage()
      root?.removeEventListener('hibi:source-caret', reportActive)
      model.dispose()
    }
  }, [
    paneMode,
    markdownDocument,
    outlineActive,
    sourceReady,
    content,
    documentState.tabId,
    documentState.revision,
    flavors,
    markdownExtensions,
    syntaxVersion,
    outlineSyntax,
    onOutline,
    onOutlineUnavailable,
    onActiveOutline,
  ])
  type VisualOutlineHeading = OutlineHeading & {
    position: number
    raw: number | null
  }
  const visualOutline = useRef<{
    document: RichNode
    source: Pick<SourceSnapshot, 'document' | 'version'>
    generation: number
    headings: VisualOutlineHeading[]
    sourceHeadings: { id: string; start: number }[]
  } | null>(null)
  const visualOutlineGeneration = useRef(0)
  const visualCaret = useRef({ findTarget, sourceReady })
  visualCaret.current = { findTarget, sourceReady }
  const reportVisualCaret = useRef(() => {})
  useEffect(() => {
    visualOutline.current = null
    if (paneMode === 'markdown') return
    onOutlineUnavailable?.(null)
    if (!editor || !markdownDocument) {
      onOutline([])
      onActiveOutline(null)
      return
    }
    if (!outlineActive) return
    // Rows from the previous view/configuration cannot navigate this new cache.
    // Remove them during setup; ordinary edits keep the last displayed outline.
    onOutline([])
    onActiveOutline(null)
    const root = content.current
    let frame = 0,
      timer: ReturnType<typeof setTimeout> | undefined,
      idle: number | undefined,
      disposed = false
    const current = () => {
      const cached = visualOutline.current,
        source = documentRuntime.session(documentState.tabId)?.snapshot()
      return cached &&
        source &&
        cached.document === editor.state.doc &&
        cached.source.version === source.version &&
        cached.source.document.tabId === source.document.tabId &&
        cached.source.document.revision === source.document.revision
        ? cached
        : null
    }
    const reportSelection = () => {
      frame = 0
      if (editor.isDestroyed) return
      const cached = current()
      const { findTarget, sourceReady } = visualCaret.current
      let selected: string | null = null
      if (cached && findTarget === 'source') {
        const element = root?.querySelector<HTMLElement>('.cm-content')
        const view = element && sourceView(element)
        if (sourceReady && view) {
          const rawPosition = sourcePosition(
            view,
            view.state.selection.main.head,
          )
          selected =
            outlineHeadingAt(
              cached.sourceHeadings,
              rawPosition,
              (heading) => heading.start,
            )?.id ?? null
        }
      } else if (cached) {
        selected =
          outlineHeadingAt(
            cached.headings,
            editor.state.selection.head,
            (heading) => heading.position,
          )?.id ?? null
      }
      onActiveOutline(selected)
    }
    const cancelRead = () => {
      clearTimeout(timer)
      if (idle !== undefined) cancelIdleCallback(idle)
      timer = idle = undefined
    }
    const read = () => {
      timer = idle = undefined
      if (disposed || editor.isDestroyed) return
      const document = editor.state.doc,
        source = documentRuntime.session(documentState.tabId)?.snapshot(),
        known = richSourceSnapshot(editor)
      if (
        !source ||
        known?.version !== source.version ||
        known.document.tabId !== source.document.tabId ||
        known.document.revision !== source.document.revision
      )
        return
      const previous = visualOutline.current
      const headings: VisualOutlineHeading[] = []
      document.descendants((node, position) => {
        if (node.type.name === 'heading')
          headings.push({
            id: '',
            position,
            raw: null,
            label: node.textContent || 'Untitled heading',
            level: Number(node.attrs.level),
          })
      })
      const unchanged =
        previous !== null &&
        previous.headings.length === headings.length &&
        headings.every((heading, index) => {
          const before = previous.headings[index]
          return (
            before !== undefined &&
            before.position === heading.position &&
            before.label === heading.label &&
            before.level === heading.level
          )
        })
      const generation = unchanged
        ? previous.generation
        : ++visualOutlineGeneration.current
      for (const heading of headings)
        heading.id = `rich:${generation}:${heading.position}`
      const sourceHeadings: { id: string; start: number }[] = []
      if (paneMode === 'side-by-side' && headings.length) {
        const raw = source.materialize(),
          body = projectMarkdown(raw, markdownExtensions).content,
          offset = raw.lastIndexOf(body),
          map = positions(body, document)
        if (offset >= 0)
          for (const heading of headings) {
            const exact = plainSync.current?.map(
              source,
              document,
              heading.position + 1,
              'rich',
            )
            const mapped =
              exact == null ? map(heading.position + 1, 'rich') : null
            heading.raw = exact ?? (mapped === null ? null : offset + mapped)
            if (heading.raw !== null)
              sourceHeadings.push({
                id: heading.id,
                start: raw.lastIndexOf('\n', heading.raw - 1) + 1,
              })
          }
      }
      const latest = documentRuntime.session(documentState.tabId)?.snapshot()
      if (
        disposed ||
        editor.state.doc !== document ||
        latest?.version !== source.version ||
        latest.document.tabId !== source.document.tabId ||
        latest.document.revision !== source.document.revision
      )
        return
      visualOutline.current = {
        document,
        source: { document: source.document, version: source.version },
        generation,
        headings,
        sourceHeadings,
      }
      if (!unchanged) onOutline(headings)
      reportSelection()
    }
    const schedule = () => {
      if (current()) {
        if (!frame) frame = requestAnimationFrame(reportSelection)
        return
      }
      cancelAnimationFrame(frame)
      frame = 0
      onActiveOutline(null)
      cancelRead()
      timer = setTimeout(() => {
        timer = undefined
        if (typeof requestIdleCallback === 'function')
          idle = requestIdleCallback(read, { timeout: 500 })
        else timer = setTimeout(read, 16)
      }, 120)
    }
    editor.on('transaction', schedule)
    root?.addEventListener('hibi:source-caret', schedule)
    reportVisualCaret.current = schedule
    // View/schema setup is explicit work. Publish its first rows immediately;
    // subsequent document changes still wait for quiet and idle time.
    read()
    if (!current()) schedule()
    return () => {
      disposed = true
      cancelRead()
      cancelAnimationFrame(frame)
      visualOutline.current = null
      reportVisualCaret.current = () => {}
      editor.off('transaction', schedule)
      root?.removeEventListener('hibi:source-caret', schedule)
    }
  }, [
    content,
    editor,
    markdownDocument,
    outlineActive,
    onOutline,
    onOutlineUnavailable,
    onActiveOutline,
    positions,
    paneMode,
    markdownExtensions,
    documentState.tabId,
  ])
  // biome-ignore lint/correctness/useExhaustiveDependencies: pane focus/readiness changes refresh selection through the current context ref without rebuilding the outline.
  useEffect(() => reportVisualCaret.current(), [findTarget, sourceReady])
  const handledOutline = useRef<OutlineRequest | null>(outlineTarget)
  // biome-ignore lint/correctness/useExhaustiveDependencies: these transitions invalidate the exact projection even when text is unchanged.
  useEffect(() => {
    documentProjections.invalidate()
  }, [mode, findTarget, sourceReady, syntaxVersion, flavors])
  useEffect(() => {
    if (!editor || !outlineTarget || handledOutline.current === outlineTarget)
      return
    if (mode !== 'normal' && !sourceReady) return
    if (paneMode === 'markdown') {
      const current = sourceOutline.current,
        session = documentRuntime.session(documentState.tabId),
        heading = current?.headings.find(
          (item) => item.id === outlineTarget.id,
        ),
        element = content.current?.querySelector<HTMLElement>('.cm-content'),
        view = element && sourceView(element)
      if (
        !session ||
        current?.version !== session.snapshot().version ||
        !heading ||
        !view
      )
        return
      handledOutline.current = outlineTarget
      revealSourcePosition(view, heading.from)
      view.focus()
      return
    }
    handledOutline.current = outlineTarget
    const cached = visualOutline.current,
      source = documentRuntime.session(documentState.tabId)?.snapshot(),
      heading = cached?.headings.find((item) => item.id === outlineTarget.id)
    const position = heading?.position
    if (
      !cached ||
      !source ||
      !heading ||
      position === undefined ||
      cached.document !== editor.state.doc ||
      cached.source.version !== source.version ||
      cached.source.document.tabId !== source.document.tabId ||
      cached.source.document.revision !== source.document.revision ||
      position >= editor.state.doc.content.size ||
      editor.state.doc.nodeAt(position)?.type.name !== 'heading'
    )
      return
    if (mode === 'normal') {
      handledOutline.current = outlineTarget
      editor
        .chain()
        .focus()
        .setTextSelection(position + 1)
        .scrollIntoView()
        .run()
    } else {
      const element = content.current?.querySelector<HTMLElement>('.cm-content')
      const view = element && sourceView(element)
      if (!view) return
      if (heading.raw === null) return
      handledOutline.current = outlineTarget
      revealSourcePosition(view, heading.raw)
      view.focus()
    }
  }, [
    content,
    editor,
    outlineTarget,
    mode,
    sourceReady,
    paneMode,
    documentState.tabId,
  ])
  useEffect(() => {
    if (paneMode !== 'side-by-side' || !sourceReady || !editor) return
    const rich = content.current?.querySelector<HTMLElement>('.rich-pane')
    const source = content.current?.querySelector<HTMLElement>('.cm-scroller')
    if (!rich || !source) return
    return linkScroll(
      rich,
      source,
      source.contains(window.document.activeElement) ? source : rich,
      markdownDocument
        ? { editor, content: geometryContent, positions }
        : undefined,
    )
  }, [
    content,
    paneMode,
    sourceReady,
    editor,
    markdownDocument,
    positions,
    geometryContent,
  ])
  const { attachSource: attachSourceFormatting, attachFiles } =
    useFormattingToolbar(
      editor,
      paneMode,
      focusedPane,
      disabled ||
        mode !== paneMode ||
        (findTarget === 'rich' &&
          (splitReadOnly || projectionReadOnly || !!richExtensionError)),
      onAttach,
      focusOwnedByEditor,
      markdownDocument,
      format,
    )

  useLayoutEffect(() => {
    updateRichEditable()
  }, [updateRichEditable])

  useEffect(() => {
    if (!editor) return
    const apply = () => {
      if (!editor.isDestroyed)
        editor.view.dom.setAttribute('spellcheck', String(spellCheck))
    }
    editor.on('mount', apply)
    apply()
    return () => {
      editor.off('mount', apply)
    }
  }, [editor, spellCheck])

  useLayoutEffect(() => {
    if (
      !editor ||
      !showMarkdownMarkers ||
      !markdownDocument ||
      projectionReadOnly ||
      mode === 'markdown'
    )
      return
    return observeMarkdownMarkers(editor)
  }, [editor, showMarkdownMarkers, markdownDocument, projectionReadOnly, mode])

  useLayoutEffect(() => {
    if (!editor || paneMode === 'markdown') return
    let detach: (() => void)[] = []
    const cleanup = () => {
      for (const remove of detach) remove()
      detach = []
    }
    const attach = () => {
      cleanup()
      setRichExtensionError('')
      if (editor.isDestroyed) return
      try {
        for (const extension of richExtensions)
          detach.push(extension.attach(editor))
      } catch (error) {
        cleanup()
        editor.setEditable(false, false)
        setRichExtensionError(String(error))
      }
    }
    editor.on('mount', attach)
    editor.on('unmount', cleanup)
    attach()
    return () => {
      editor.off('mount', attach)
      editor.off('unmount', cleanup)
      cleanup()
    }
  }, [editor, richExtensions, paneMode])

  useEffect(() => {
    if (!editor || !findOpen || findTarget !== 'rich') return
    const report = () => {
      const matches = getMatchHighlights(editor.state).find()
      const selection = editor.state.selection
      setFindStatus({
        total: matches.length,
        current:
          matches.findIndex(
            (match) =>
              match.from === selection.from && match.to === selection.to,
          ) + 1,
      })
    }
    editor.on('transaction', report)
    report()
    return () => {
      editor.off('transaction', report)
    }
  }, [editor, findOpen, findTarget])

  useEffect(() => {
    if (!editor) return
    const query = new SearchQuery({
      search: findOpen && findTarget === 'rich' ? findQuery : '',
      literal: true,
    })
    if (!query.valid && !getSearchState(editor.state)?.query.valid) return
    if (!flushRich(editor)) return
    editor.view.dispatch(setSearchState(editor.state.tr, query))
    const first = query.valid ? query.findNext(editor.state, 0) : null
    if (first)
      editor.view.dispatch(
        editor.state.tr
          .setSelection(
            TextSelection.create(editor.state.doc, first.from, first.to),
          )
          .scrollIntoView(),
      )
  }, [editor, findQuery, findOpen, findTarget])

  useEffect(() => {
    if (handledFindMove.current === findMove.id) return
    handledFindMove.current = findMove.id
    if (editor && findOpen && findTarget === 'rich' && findMove.id) {
      if (!flushRich(editor)) return
      const command = findMove.direction === 'next' ? findNext : findPrev
      command(editor.state, (transaction) => editor.view.dispatch(transaction))
    }
  }, [editor, findMove, findOpen, findTarget])

  function updateFromSource(markdown: string) {
    onChange(markdown)
  }

  function followClickedLink(event: MouseEvent<HTMLElement>) {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>(
      '.tiptap a[href], .format-content a[href]',
    )
    if (
      !link ||
      (!link.closest('.format-content') &&
        !event.shiftKey &&
        !(event.ctrlKey && event.metaKey))
    )
      return
    event.preventDefault()
    event.stopPropagation()
    onLink(link.getAttribute('href')!)
  }

  return (
    <>
      <FindBar
        open={findOpen}
        query={findQuery}
        onQuery={setFindQuery}
        status={findStatus}
        onMove={(direction) =>
          setFindMove((move) => ({ id: move.id + 1, direction }))
        }
        onClose={() => {
          onCloseFind()
          if (findTarget === 'rich') editor?.commands.focus()
          else
            window.document
              .querySelector<HTMLElement>('.source-pane .cm-content')
              ?.focus()
        }}
      />
      <main
        className={`editor-panes mode-${paneMode}`}
        data-source-ready={sourceReady}
        onClickCapture={followClickedLink}
        onContextMenuCapture={(event) => {
          if (event.ctrlKey && event.metaKey) followClickedLink(event)
        }}
        onDropCapture={(event) => {
          const files = Array.from(event.dataTransfer.files)
          if (!files.length || !files.every(isMediaFile)) return
          event.preventDefault()
          event.stopPropagation()
          const pane = (event.target as HTMLElement).closest('.source-pane')
            ? 'source'
            : 'rich'
          void attachFiles(files, pane, { x: event.clientX, y: event.clientY })
        }}
        onKeyDownCapture={(event) => emitEditorKeyEvent(event.nativeEvent)}
        onKeyUpCapture={(event) => emitEditorKeyEvent(event.nativeEvent)}
      >
        <div className="editor-content" ref={content}>
          <EditorCursor root={content} settings={cursorSettings} />
          <MirrorCursor
            editor={editor}
            positions={positions}
            root={content}
            content={geometryContent}
            active={
              paneMode === 'side-by-side' &&
              sourceReady &&
              !disabled &&
              !projectionReadOnly
            }
          />
          <section
            className="rich-pane"
            onFocusCapture={() => {
              setFocusedPane('rich')
              documentRuntime.focusView(viewId as ViewId)
            }}
            aria-label="Formatted document"
            aria-hidden={paneMode === 'markdown'}
            inert={paneMode === 'markdown'}
          >
            {markdownDocument &&
              markdownExtensions.map(({ id, Editor }) =>
                Editor ? (
                  <Editor
                    key={id}
                    value={value}
                    disabled={disabled || splitReadOnly}
                    onChange={(markdown) => {
                      if (!splitReadOnly) updateFromSource(markdown)
                    }}
                  />
                ) : null,
              )}
            <div className="rich-editor-host" hidden={!markdownDocument}>
              {(richExtensionError || projectionReadOnly) && (
                <DocumentNotice
                  title="Editor addon unavailable"
                  message={
                    projectionReadOnly
                      ? 'The editor addon could not preserve this document.'
                      : richExtensionError
                  }
                />
              )}
              {richInputError && (
                <DocumentNotice
                  title="Edit could not be applied"
                  message={richInputError}
                >
                  {editor &&
                    richSourceSnapshot(editor)?.version !==
                      documentState.contentVersion && (
                      <Button onClick={() => retryRich.current()}>Retry</Button>
                    )}
                </DocumentNotice>
              )}
              <EditorContent editor={editor} />
            </div>
          </section>
          <section
            className="source-pane"
            onFocusCapture={() => {
              setFocusedPane('source')
              documentRuntime.focusView(viewId as ViewId)
            }}
            aria-label="Document source"
            aria-hidden={paneMode === 'normal'}
            inert={paneMode === 'normal'}
          >
            {sourceMounted && (
              <Suspense
                fallback={
                  <LoadingScreen label={`Loading ${formatName} editor`} />
                }
              >
                <SourceEditor
                  document={documentState}
                  viewId={viewId}
                  editTarget={findTarget === 'source'}
                  markdownMode={markdownDocument}
                  referenceSyntax={referenceSyntax}
                  linksEnabled={markdownSyntax.enabled('core.links')}
                  sourceLanguage={format?.language}
                  sourceFormat={format?.formatting}
                  supportsMedia={!!format?.insertMedia}
                  codeLanguage={format?.codeLanguage}
                  label={formatName}
                  waitForFont
                  onLink={onLink}
                  onFormatting={attachSourceFormatting}
                  sourceExtensions={sourceExtensions}
                  showLineNumbers={showLineNumbers}
                  onReady={(status) => {
                    setSourceReady(status === 'ready')
                    if (status !== 'loading') setSourceSettled(true)
                  }}
                  disabled={disabled}
                  findActive={findOpen && findTarget === 'source'}
                  findQuery={findQuery}
                  findMove={findMove}
                  onFindStatus={setFindStatus}
                />
              </Suspense>
            )}
          </section>
        </div>
      </main>
    </>
  )
}
