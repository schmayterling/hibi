import { isolateHistory } from '@codemirror/commands'
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { SourceExtension } from '../../addons/api'
import { sourceChange } from '../../shared/document-journal'
import type { ViewId } from '../../shared/foundation-contracts'
import { isMediaFile } from '../../shared/media'
import { normalizedSource } from '../../shared/source-projection'
import { documentRuntime } from './document-runtime'
import { largeOpening } from './document-shell'
import type { MarkdownEditor as RichMarkdownEditor } from './Editor'
import { EditorCursor } from './EditorCursor'
import { emitEditorKeyEvent } from './editor-events'
import { editorViewRegistry } from './editor-view-api'
import { FindBar, type FindMove, type FindStatus } from './FindBar'
import { useFormattingToolbar } from './FormattingToolbar'
import { LoadingScreen } from './LoadingScreen'
import { markdownSyntax } from './markdown-syntax'
import { SourceEditor } from './SourceEditor'
import { editorPosition, sourceView } from './source-view'
import { useEditorPanes } from './use-editor-panes'

const MarkdownSourceEditor = lazy(() =>
  import('./MarkdownSourceEditor').then((module) => ({
    default: module.MarkdownSourceEditor,
  })),
)

/** Source extensions such as Vim belong to the source pane only. */
const formattedExtensions: readonly SourceExtension[] = []
/** A properties editor above the text shows the frontmatter instead. */
const propertiesExtensions: readonly SourceExtension[] = [
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
  onActiveOutline,
}: Parameters<typeof RichMarkdownEditor>[0]) {
  const markdownDocument = format?.editing === 'markdown'
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
  const releaseSource = largeOpening(documentRuntime, documentState)
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
  const findTarget =
    mode === 'normal' ? 'rich' : mode === 'markdown' ? 'source' : focusedPane
  useEffect(() => {
    editorViewRegistry.setActive(viewId as ViewId, findTarget)
  }, [viewId, findTarget])
  useEffect(
    () => () => editorViewRegistry.clearActive(viewId as ViewId),
    [viewId],
  )
  // The outline follows the source outline in a later formatted-view slice.
  useEffect(() => {
    onOutline([])
    onActiveOutline(null)
  }, [onOutline, onActiveOutline])
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
      annotations: isolateHistory.of('full'),
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
          window.document
            .querySelector<HTMLElement>(
              findTarget === 'rich'
                ? '.rich-pane .cm-content'
                : '.source-pane .cm-content',
            )
            ?.focus()
        }}
      />
      <main
        className={`editor-panes mode-${paneMode}`}
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
              markdownExtensions.map(({ id, Editor }) =>
                Editor ? (
                  <Editor
                    key={id}
                    value={value}
                    disabled={disabled}
                    onChange={editSource}
                  />
                ) : null,
              )}
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
                onLink={onLink}
                onFormatting={attachRich}
                sourceExtensions={
                  markdownDocument &&
                  // A large note's properties are not read, so its
                  // frontmatter stays in the text.
                  value &&
                  markdownExtensions.some(
                    ({ id, Editor }) => id === 'frontmatter.metadata' && Editor,
                  )
                    ? propertiesExtensions
                    : formattedExtensions
                }
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
                  onLink={onLink}
                  onFormatting={attachSource}
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
