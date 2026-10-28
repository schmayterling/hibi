import { isolateHistory } from '@codemirror/commands'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { FormattedExtension } from '../../addons/api'
import { builtInFlavors } from '../../shared/built-in-grammar'
import { sourceChange } from '../../shared/document-journal'
import type { ViewId } from '../../shared/foundation-contracts'
import { headingAnchors } from '../../shared/heading-anchor'
import { isMediaFile } from '../../shared/media'
import { normalizedSource } from '../../shared/source-projection'
import { documentRuntime } from './document-runtime'
import { largeOpening, largeSource } from './document-shell'
import type { MarkdownEditor as RichMarkdownEditor } from './Editor'
import { EditorCursor } from './EditorCursor'
import { emitEditorKeyEvent } from './editor-events'
import { editorViewRegistry } from './editor-view-api'
import { FindBar, type FindMove, type FindStatus } from './FindBar'
import { useFormattingToolbar } from './FormattingToolbar'
import type { FormattedHeadingList } from './formatted-headings'
import { formattedProjectionSource } from './formatted-projection'
import { LoadingScreen } from './LoadingScreen'
import { linkScroll } from './linked-scroll'
import { MirrorCursor } from './MirrorCursor'
import { markdownSyntax } from './markdown-syntax'
import type { OutlineHeading } from './OutlineSidebar'
import { SourceEditor, sourceAfter } from './SourceEditor'
import { editorPosition, revealSourcePosition, sourceView } from './source-view'
import { useEditorPanes } from './use-editor-panes'
import { sourceOutlineSyntax, useSourceOutline } from './use-source-outline'

const MarkdownSourceEditor = lazy(() =>
  import('./MarkdownSourceEditor').then((module) => ({
    default: module.MarkdownSourceEditor,
  })),
)

/** Source extensions such as Vim belong to the source pane only. */
const noFormattedExtensions: readonly FormattedExtension[] = []
/** A properties editor above the text shows the frontmatter instead. */
const propertiesExtensions: readonly FormattedExtension[] = [
  {
    id: 'formatted.frontmatter',
    create: () =>
      import('./formatted-frontmatter').then(
        (module) => module.formattedFrontmatter,
      ),
  },
]

/**
 * Markdown notes on the CodeMirror formatted view, behind the temporary
 * `formatted-engine` switch. Both panes edit the same source session.
 */
export function MarkdownEditor({
  document: documentState,
  viewId = 'default',
  focused = true,
  autoFocus = true,
  format,
  formatName,
  mode,
  disabled,
  findOpen,
  onCloseFind,
  markdownExtensions,
  sourceExtensions,
  formattedExtensions = noFormattedExtensions,
  richExtensions,
  cursorSettings,
  showLineNumbers,
  spellCheck,
  showMarkdownMarkers,
  flavors,
  documentRevision,
  value,
  onAttach,
  onLink,
  onOutline,
  onOutlineUnavailable,
  onActiveOutline,
  outlineTarget,
  outlineActive,
}: Parameters<typeof RichMarkdownEditor>[0]) {
  const markdownDocument = format?.editing === 'markdown'
  const showProperties =
    markdownDocument &&
    markdownExtensions.some(
      ({ id, Editor }) => id === 'frontmatter.metadata' && Editor,
    )
  // A large note's properties get its frontmatter from the formatted view's
  // bounded read, not the whole note.
  const largeProperties = largeOpening(documentRuntime, documentState)
  const [frontmatter, setFrontmatter] = useState('')
  const reportedProperties = useMemo<readonly FormattedExtension[]>(
    () => [
      {
        id: 'formatted.frontmatter',
        create: () =>
          import('./formatted-frontmatter').then((module) => [
            module.formattedFrontmatter,
            module.reportFrontmatter(setFrontmatter),
          ]),
      },
    ],
    [],
  )
  const projectionExtensions = useMemo<readonly FormattedExtension[]>(() => {
    if (
      !markdownExtensions.some(
        ({ id, preservation }) =>
          id !== 'frontmatter.metadata' && preservation?.level === 'verbatim',
      )
    )
      return []
    const adapters = markdownExtensions
    return [
      {
        id: 'formatted.projection',
        create: () =>
          import('./formatted-projection').then(({ formattedProjection }) =>
            formattedProjection(adapters, () =>
              documentRuntime.session(documentState.tabId)?.snapshot(),
            ),
          ),
      },
    ]
  }, [markdownExtensions, documentState.tabId])
  const editorExtensions = useMemo(
    () => [
      ...(showProperties
        ? largeProperties
          ? reportedProperties
          : propertiesExtensions
        : []),
      ...projectionExtensions,
      ...formattedExtensions,
    ],
    [
      showProperties,
      largeProperties,
      reportedProperties,
      projectionExtensions,
      formattedExtensions,
    ],
  )
  const syntaxVersion = useSyncExternalStore(
    markdownSyntax.subscribe,
    markdownSyntax.version,
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: syntaxVersion invalidates the current registry preferences.
  const referenceSyntax = useMemo(() => {
    // Unknown parser/projection contributions keep their existing link behavior.
    if (
      flavors.some(
        (flavor) =>
          (flavor.export?.extensions?.length ||
            flavor.richExtensions?.length) &&
          !builtInFlavors.has(flavor.id),
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
  const flavorIds = useMemo(() => flavors.map((flavor) => flavor.id), [flavors])
  const [formattedReady, setFormattedReady] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findStatus, setFindStatus] = useState<FindStatus>({
    current: 0,
    total: 0,
  })
  const [findMove, setFindMove] = useState<FindMove>({
    id: 0,
    direction: 'next',
  })
  // A large note's source view unmounts when it is left, keeping its place.
  // A note that grows large releases a hidden one as it crosses the size.
  const grownLarge = useSyncExternalStore(
    documentRuntime.subscribeDocument,
    () => largeSource(documentRuntime, documentState.tabId),
  )
  const releaseSource =
    largeOpening(documentRuntime, documentState) || grownLarge
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
  } = useEditorPanes(mode, markdownDocument, false, releaseSource)
  // The source bookmark stays independent of the hosting view identity.
  const sourceViewId = `${viewId}:source` as ViewId
  const documentTarget = documentRuntime.captureDocument(documentState.tabId)
  const findTarget =
    mode === 'normal' ? 'rich' : mode === 'markdown' ? 'source' : focusedPane
  useEffect(() => {
    editorViewRegistry.setActive(viewId as ViewId, findTarget)
  }, [viewId, findTarget])
  useEffect(
    () => () => editorViewRegistry.clearActive(viewId as ViewId),
    [viewId],
  )
  useEffect(() => {
    if (focused && documentTarget) documentRuntime.focusView(viewId as ViewId)
  }, [focused, documentTarget, viewId])
  useEffect(() => {
    onOutline([])
    onActiveOutline(null)
  }, [onOutline, onActiveOutline])
  // biome-ignore lint/correctness/useExhaustiveDependencies: syntaxVersion invalidates the current registry preferences.
  const outlineSyntax = useMemo(
    () => sourceOutlineSyntax(flavors, markdownExtensions, richExtensions),
    [flavors, markdownExtensions, richExtensions, syntaxVersion],
  )
  // The source outline also gives assistive technology the headings the
  // formatted view does not draw, so it is read while a screen reader is on,
  // with the sidebar closed too, and reported to the sidebar while it is open.
  // Its work grows with the note, not the edit: each reparse adds back the
  // blocks before the edit and a structural edit walks every block. Without
  // the sidebar or a screen reader nothing reads it. Addon windows get no
  // screen reader report and always read it.
  const [assistive, setAssistive] = useState(!window.hibi)
  useEffect(() => window.hibi?.onAccessibilitySupport(setAssistive), [])
  // A link to a heading of the note reads its outline until it moves there.
  const [anchor, setAnchor] = useState<{ target: string } | null>(null)
  const pendingAnchor = useRef<string | null>(null)
  const revealAnchor = useRef(() => {})
  /** Heading positions by destination, for the outline's published headings. */
  const anchorIndex = useRef<{
    headings: OutlineHeading[]
    index: Map<string, number>
  } | null>(null)
  const outlineRead =
    markdownDocument &&
    formattedReady &&
    (outlineActive || assistive || anchor !== null)
  const outlineShown = useRef(outlineActive)
  outlineShown.current = outlineActive
  const outline = useRef<{
    headings: OutlineHeading[]
    active: string | null
    unavailable: string | null
  }>({ headings: [], active: null, unavailable: null })
  const headingList = useRef<FormattedHeadingList | null>(null)
  const measureHeadings = useRef(() => {})
  const reportOutline = useCallback(
    (headings: OutlineHeading[]) => {
      outline.current.headings = headings
      if (anchorIndex.current?.headings !== headings) anchorIndex.current = null
      headingList.current?.update(headings)
      measureHeadings.current()
      if (outlineShown.current) onOutline(headings)
      revealAnchor.current()
    },
    [onOutline],
  )
  const reportActiveOutline = useCallback(
    (id: string | null) => {
      outline.current.active = id
      if (outlineShown.current) onActiveOutline(id)
    },
    [onActiveOutline],
  )
  const reportUnavailable = useCallback(
    (reason: string | null) => {
      outline.current.unavailable = reason
      if (outlineShown.current) onOutlineUnavailable?.(reason)
      if (reason) {
        pendingAnchor.current = null
        setAnchor(null)
      }
    },
    [onOutlineUnavailable],
  )
  // Entries of a stopped outline would go stale with the next edit.
  useEffect(() => {
    if (!outlineRead) reportOutline([])
  }, [outlineRead, reportOutline])
  useEffect(() => {
    if (!outlineActive) return
    onOutline(outline.current.headings)
    onActiveOutline(outline.current.active)
    onOutlineUnavailable?.(outline.current.unavailable)
  }, [outlineActive, onOutline, onActiveOutline, onOutlineUnavailable])
  // Both panes show the source outline; the pane that takes edits selects the
  // active heading and moves to a chosen one. The formatted view stays mounted
  // while the source pane loads.
  const sourceOutline = useSourceOutline({
    active: outlineRead,
    content,
    tabId: documentState.tabId,
    revision: documentState.revision,
    flavors,
    outlineSyntax,
    view: () => {
      const pane = (selector: string) => {
        const element = content.current?.querySelector<HTMLElement>(
          `${selector} .cm-content`,
        )
        return element && sourceView(element)
      }
      return (
        (findTarget === 'source' && pane('.source-pane')) || pane('.rich-pane')
      )
    },
    onOutline: reportOutline,
    onOutlineUnavailable: reportUnavailable,
    onActiveOutline: reportActiveOutline,
  })
  /**
   * Heading destinations as the exported site and the rich view assign
   * them, from the labels of all the note's headings.
   */
  revealAnchor.current = () => {
    const target = pendingAnchor.current,
      current = sourceOutline.outline(),
      { headings } = outline.current
    if (target === null || current?.headings.length !== headings.length) return
    // Destinations are assigned once per outline, not per link followed.
    if (anchorIndex.current?.headings !== headings) {
      const index = new Map<string, number>()
      headingAnchors(headings.map(({ label }) => label)).forEach(
        ({ anchor, legacy }, position) => {
          if (!index.has(anchor)) index.set(anchor, position)
          if (legacy !== null && !index.has(legacy)) index.set(legacy, position)
        },
      )
      anchorIndex.current = { headings, index }
    }
    const heading = headings[anchorIndex.current.index.get(target) ?? -1]
    // A stale outline is read again after the edit that made it stale.
    if (heading && !sourceOutline.reveal(heading.id)) return
    pendingAnchor.current = null
    setAnchor(null)
  }
  const followLink = (href: string) => {
    if (!href.startsWith('#')) {
      onLink(href)
      return
    }
    try {
      pendingAnchor.current = decodeURIComponent(href.slice(1))
    } catch {
      return
    }
    if (sourceOutline.outline()) revealAnchor.current()
    if (pendingAnchor.current !== null)
      setAnchor({ target: pendingAnchor.current })
  }
  const richView = () => {
    const element = content.current?.querySelector<HTMLElement>(
      '.rich-pane .cm-content',
    )
    return element ? sourceView(element) : null
  }
  /** Move the caret to a heading's text, after its opening mark, as the outline does. */
  const activateHeading = useRef((_index: number) => {})
  activateHeading.current = (index: number) => {
    const current = sourceOutline.outline(),
      view = richView()
    if (!current || !view || index >= current.headings.length) return
    revealSourcePosition(view, current.position(index))
    view.focus()
  }
  const beforeHeadings = useRef<HTMLDivElement>(null)
  const afterHeadings = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const before = beforeHeadings.current,
      after = afterHeadings.current
    if (!before || !after) return
    let stopped = false
    void import('./formatted-headings').then(({ FormattedHeadingList }) => {
      if (stopped) return
      headingList.current = new FormattedHeadingList(before, after, (index) =>
        activateHeading.current(index),
      )
      headingList.current.update(outline.current.headings)
      measureHeadings.current()
    })
    return () => {
      stopped = true
      headingList.current?.dispose()
      headingList.current = null
    }
  }, [])
  // The headings the formatted view draws change with its top-level lines.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a ready view is a new one.
  useEffect(() => {
    const view = formattedReady && richView()
    if (!view) return
    measureHeadings.current = () => {
      const current = sourceOutline.outline()
      if (current?.headings.length === outline.current.headings.length)
        headingList.current?.measure(view, current)
    }
    const observer = new MutationObserver(() => measureHeadings.current())
    observer.observe(view.contentDOM, { childList: true })
    measureHeadings.current()
    return () => {
      observer.disconnect()
      measureHeadings.current = () => {}
    }
  }, [formattedReady, sourceOutline])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pane that takes edits changed or loaded.
  useEffect(
    () => sourceOutline.reportActive(),
    [sourceOutline, findTarget, sourceReady],
  )
  const handledOutline = useRef(outlineTarget)
  useEffect(() => {
    if (!outlineTarget || handledOutline.current === outlineTarget) return
    if (sourceOutline.reveal(outlineTarget.id))
      handledOutline.current = outlineTarget
  }, [sourceOutline, outlineTarget])
  const { attachSource, attachRich, attachFiles } = useFormattingToolbar(
    null,
    paneMode,
    focusedPane,
    disabled || mode !== paneMode,
    onAttach,
    focusOwnedByEditor,
    markdownDocument,
    format,
    focused,
  )
  // Like the rich editor, a new view takes focus with the caret at the end,
  // unless the user already moved focus or the caret elsewhere.
  const placed = useRef(false)
  useEffect(() => {
    if (!autoFocus || placed.current || !formattedReady) return
    placed.current = true
    if (paneMode === 'markdown') return
    const element = content.current?.querySelector<HTMLElement>(
      '.rich-pane .cm-content',
    )
    const view = element && sourceView(element)
    const active = window.document.activeElement
    if (
      !view ||
      view.state.selection.main.head !== 0 ||
      (active &&
        active !== window.document.body &&
        !content.current?.contains(active))
    )
      return
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    view.focus()
  }, [autoFocus, formattedReady, paneMode, content])
  useEffect(() => {
    if (paneMode !== 'side-by-side' || !sourceReady || !formattedReady) return
    const rich = content.current?.querySelector<HTMLElement>('.rich-pane')
    const source = content.current?.querySelector<HTMLElement>(
      '.source-pane .cm-scroller',
    )
    if (!rich || !source) return
    return linkScroll(
      rich,
      source,
      source.contains(window.document.activeElement) ? source : rich,
      'source',
    )
  }, [content, paneMode, sourceReady, formattedReady])
  /**
   * Properties editors above the text return the whole source, as in the
   * rich editor; their change goes to the formatted view as one minimal edit
   * that addon protections let through and undo takes back alone.
   */
  const editSource = (markdown: string) => {
    const element = content.current?.querySelector<HTMLElement>(
      '.rich-pane .cm-content',
    )
    const view = element && sourceView(element)
    const change = sourceChange(value, markdown)
    if (!view || !change) return
    // The change is in source coordinates; the view's text has normalized
    // line breaks and no byte order mark.
    const from = editorPosition(view, change.from),
      to = editorPosition(view, change.to)
    // A change to text edited since the properties rendered is dropped.
    if (
      from === null ||
      to === null ||
      view.state.doc.length !== normalizedSource(value).length ||
      view.state.sliceDoc(from, to) !==
        normalizedSource(value.slice(change.from, change.to))
    )
      return
    view.dispatch({
      changes: { from, to, insert: normalizedSource(change.insert) },
      userEvent: 'input.addon',
      annotations: [
        isolateHistory.of('full'),
        formattedProjectionSource.of(markdown),
      ],
    })
  }
  /** A large note's properties return only the frontmatter they were given. */
  const editFrontmatter = (markdown: string) => {
    const element = content.current?.querySelector<HTMLElement>(
      '.rich-pane .cm-content',
    )
    const view = element && sourceView(element)
    const change = sourceChange(frontmatter, markdown)
    // A change to frontmatter edited since the properties rendered is dropped.
    if (
      !view ||
      !change ||
      view.state.sliceDoc(0, frontmatter.length) !== frontmatter
    )
      return
    const edit = { ...change, insert: normalizedSource(change.insert) }
    // Verbatim projections, which read the whole note, accept frontmatter
    // edits with the whole new source, as from small notes' properties: the
    // one this view commits.
    const replacement = projectionExtensions.length
      ? sourceAfter(view, [edit])
      : undefined
    if (replacement === null) return
    view.dispatch({
      changes: edit,
      userEvent: 'input.addon',
      annotations: [
        isolateHistory.of('full'),
        ...(replacement === undefined
          ? []
          : [formattedProjectionSource.of(replacement)]),
      ],
    })
  }
  const ready =
    (paneMode === 'markdown' || formattedReady) &&
    (paneMode === 'normal' || sourceReady)
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
          content.current
            ?.querySelector<HTMLElement>(
              findTarget === 'rich'
                ? '.rich-pane .cm-content'
                : '.source-pane .cm-content',
            )
            ?.focus()
        }}
      />
      <main
        className={`editor-panes mode-${paneMode}`}
        data-editor-view={viewId}
        data-source-ready={ready}
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
            root={content}
            active={
              paneMode === 'side-by-side' &&
              sourceReady &&
              formattedReady &&
              !disabled
            }
          />
          <div
            ref={beforeHeadings}
            className="formatted-headings"
            hidden={paneMode === 'markdown'}
          />
          <section
            className="rich-pane"
            onFocusCapture={() => {
              setFocusedPane('rich')
              editorViewRegistry.setActive(viewId as ViewId, 'rich')
              documentRuntime.focusView(viewId as ViewId)
            }}
            aria-label="Formatted document"
            aria-hidden={paneMode === 'markdown'}
            inert={paneMode === 'markdown'}
          >
            {markdownDocument &&
              markdownExtensions.map(({ id, Editor }) => {
                if (!Editor) return null
                const frontmatterOnly =
                  largeProperties && id === 'frontmatter.metadata'
                return (
                  <Editor
                    key={id}
                    value={frontmatterOnly ? frontmatter : value}
                    disabled={disabled}
                    onChange={frontmatterOnly ? editFrontmatter : editSource}
                  />
                )
              })}
            <div className="rich-editor-host">
              <SourceEditor
                presentation="formatted"
                document={documentState}
                viewId={viewId}
                focused={focused}
                editTarget={findTarget === 'rich'}
                sourceVisible={paneMode !== 'markdown'}
                markdownMode={markdownDocument}
                referenceSyntax={referenceSyntax}
                linksEnabled={markdownSyntax.enabled('core.links')}
                sourceLanguage={undefined}
                sourceFormat={format?.formatting}
                supportsMedia={!!format?.insertMedia}
                label={formatName}
                waitForFont
                onLink={followLink}
                onFormatting={attachRich}
                sourceExtensions={editorExtensions}
                showLineNumbers={false}
                onReady={(status) => setFormattedReady(status === 'ready')}
                disabled={disabled}
                findActive={findOpen && findTarget === 'rich'}
                findQuery={findQuery}
                findMove={findMove}
                onFindStatus={setFindStatus}
                markers={showMarkdownMarkers}
                spellCheck={spellCheck}
                flavors={flavorIds}
                documentRevision={documentRevision}
              />
            </div>
          </section>
          <div
            ref={afterHeadings}
            className="formatted-headings"
            hidden={paneMode === 'markdown'}
          />
          <section
            className="source-pane"
            onFocusCapture={() => {
              setFocusedPane('source')
              editorViewRegistry.setActive(viewId as ViewId, 'source')
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
                <MarkdownSourceEditor
                  document={documentState}
                  viewId={viewId}
                  sessionViewId={sourceViewId}
                  focused={focused}
                  editTarget={findTarget === 'source'}
                  sourceVisible={paneMode !== 'normal'}
                  markdownMode={markdownDocument}
                  referenceSyntax={referenceSyntax}
                  linksEnabled={markdownSyntax.enabled('core.links')}
                  sourceLanguage={format?.language}
                  sourceFormat={format?.formatting}
                  supportsMedia={!!format?.insertMedia}
                  codeLanguage={format?.codeLanguage}
                  label={formatName}
                  waitForFont
                  onLink={followLink}
                  onFormatting={attachSource}
                  sourceExtensions={sourceExtensions}
                  flavors={flavorIds}
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
                  keepPlace={releaseSource}
                />
              </Suspense>
            )}
          </section>
        </div>
      </main>
    </>
  )
}
