import { lazy, Suspense, useEffect, useState } from 'react'
import { isMediaFile } from '../../shared/media'
import { documentProjections } from './document-projections'
import type { MarkdownEditor } from './Editor'
import { EditorCursor } from './EditorCursor'
import { emitEditorKeyEvent } from './editor-events'
import { FindBar, type FindMove, type FindStatus } from './FindBar'
import { useFormattingToolbar } from './FormattingToolbar'
import { LoadingScreen } from './LoadingScreen'
import { linkScroll } from './linked-scroll'
import { useEditorPanes } from './use-editor-panes'

const SourceEditor = lazy(() =>
  import('./SourceEditor').then((module) => ({ default: module.SourceEditor })),
)

/** Standalone formats own source and requested previews, without a hidden rich editor. */
export function FormatEditor({
  document,
  format,
  formatName,
  mode,
  disabled,
  findOpen,
  onCloseFind,
  sourceExtensions,
  cursorSettings,
  showLineNumbers,
  onAttach,
  onLink,
  onOutline,
  onOutlineUnavailable,
  onActiveOutline,
}: Parameters<typeof MarkdownEditor>[0]) {
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
  } = useEditorPanes(mode, false)
  const [findQuery, setFindQuery] = useState('')
  const [findStatus, setFindStatus] = useState<FindStatus>({
    current: 0,
    total: 0,
  })
  const [findMove, setFindMove] = useState<FindMove>({
    id: 0,
    direction: 'next',
  })
  const [previewToolbar, setPreviewToolbar] = useState<HTMLDivElement | null>(
    null,
  )
  const { attachSource, attachFiles } = useFormattingToolbar(
    null,
    paneMode,
    focusedPane,
    disabled || mode !== paneMode,
    onAttach,
    focusOwnedByEditor,
    false,
    format,
  )
  useEffect(() => {
    onOutline([])
    onOutlineUnavailable?.(null)
    onActiveOutline(null)
  }, [onOutline, onOutlineUnavailable, onActiveOutline])
  // biome-ignore lint/correctness/useExhaustiveDependencies: pane transitions invalidate captured source projections.
  useEffect(() => {
    documentProjections.invalidate()
  }, [mode, sourceReady])
  useEffect(() => {
    if (paneMode !== 'side-by-side' || !sourceReady) return
    const rich = content.current?.querySelector<HTMLElement>('.rich-pane'),
      source = content.current?.querySelector<HTMLElement>('.cm-scroller')
    if (!rich || !source) return
    return linkScroll(
      rich,
      source,
      source.contains(window.document.activeElement) ? source : rich,
    )
  }, [paneMode, sourceReady, content])
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
          content.current?.querySelector<HTMLElement>('.cm-content')?.focus()
        }}
      />
      <main
        className={`editor-panes mode-${paneMode}`}
        data-source-ready={sourceReady}
        onClickCapture={(event) => {
          const link = (event.target as HTMLElement).closest<HTMLAnchorElement>(
            '.format-content a[href]',
          )
          if (!link) return
          event.preventDefault()
          event.stopPropagation()
          onLink(link.getAttribute('href')!)
        }}
        onDropCapture={(event) => {
          const files = Array.from(event.dataTransfer.files)
          if (!files.length || !files.every(isMediaFile)) return
          event.preventDefault()
          event.stopPropagation()
          void attachFiles(files, 'source', {
            x: event.clientX,
            y: event.clientY,
          })
        }}
        onKeyDownCapture={(event) => emitEditorKeyEvent(event.nativeEvent)}
        onKeyUpCapture={(event) => emitEditorKeyEvent(event.nativeEvent)}
      >
        <div className="editor-content" ref={content}>
          <EditorCursor root={content} settings={cursorSettings} />
          <section
            className="rich-pane"
            aria-label="Formatted document"
            aria-hidden={paneMode === 'markdown'}
            inert={paneMode === 'markdown'}
          >
            {paneMode !== 'markdown' && (
              <>
                <div
                  className="preview-toolbar"
                  ref={setPreviewToolbar}
                  role="toolbar"
                  aria-label="Preview actions"
                />
                {format ? (
                  <Suspense
                    fallback={
                      <LoadingScreen label={`Loading ${formatName} preview`} />
                    }
                  >
                    <format.Preview
                      value={document.markdown}
                      document={document}
                      toolbar={previewToolbar}
                    />
                  </Suspense>
                ) : (
                  <p className="format-unavailable">
                    Enable {formatName} in Addons to preview this document. You
                    can still edit it in source view.
                  </p>
                )}
              </>
            )}
          </section>
          <section
            className="source-pane"
            onFocusCapture={() => setFocusedPane('source')}
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
                  document={document}
                  editTarget={true}
                  markdownMode={false}
                  sourceLanguage={format?.language}
                  sourceFormat={format?.formatting}
                  supportsMedia={!!format?.insertMedia}
                  codeLanguage={format?.codeLanguage}
                  label={formatName}
                  waitForFont={false}
                  onLink={onLink}
                  onFormatting={attachSource}
                  sourceExtensions={sourceExtensions}
                  showLineNumbers={showLineNumbers}
                  onReady={(status) => {
                    setSourceReady(status === 'ready')
                    if (status !== 'loading') setSourceSettled(true)
                  }}
                  disabled={disabled}
                  findActive={findOpen}
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
