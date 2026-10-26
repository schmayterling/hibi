import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { DocumentSession } from '../../shared/document-session'
import { Button } from '../../ui/Controls'
import { DocumentNotice } from '../../ui/DocumentNotice'
import { MarkdownFootnotePreview } from './MarkdownFootnotePreview'
import {
  markdownPreviewPage,
  type PreviewCursor,
} from './markdown-preview-pages'

type PagePosition = {
  source: ReturnType<DocumentSession['snapshot']>
  cursor: PreviewCursor
  previous: PagePosition | null
}

/** Temporary read-only bridge; remove with the CodeMirror formatted view (#402). */
export function LargeMarkdownPreview({
  session,
  documentId,
  version,
  supported,
}: {
  session: DocumentSession
  documentId: string
  version: string
  supported: boolean
}) {
  const subscribe = useCallback(
    (notify: () => void) => {
      const state = session.subscribe(notify)
      const storage = session.subscribeStorage(notify)
      return () => {
        state()
        storage()
      }
    },
    [session],
  )
  const source = useSyncExternalStore(subscribe, session.snapshot)
  const [position, setPosition] = useState<PagePosition>({
    source,
    cursor: { from: 0, continuation: false },
    previous: null,
  })
  const current: PagePosition =
    position.source === source
      ? position
      : {
          source,
          cursor: { from: 0, continuation: false },
          previous: null,
        }
  const { from, continuation, contextual = false } = current.cursor
  const [prepared, setPrepared] = useState<{
    source: typeof source
    from: number
    version: string
    supported: boolean
    page: ReturnType<typeof markdownPreviewPage>
  } | null>(null)
  const [rendered, setRendered] = useState(false)
  useEffect(() => {
    setRendered(false)
    const timer = setTimeout(() => {
      if (session.snapshot() !== source) return
      setPrepared({
        source,
        from,
        version,
        supported,
        page: markdownPreviewPage(source, { from, continuation, contextual }),
      })
    }, 0)
    return () => clearTimeout(timer)
  }, [session, source, from, continuation, contextual, version, supported])
  const ready = useCallback(() => setRendered(true), [])
  const page =
    prepared?.source === source &&
    prepared.from === from &&
    prepared.version === version &&
    prepared.supported === supported
      ? prepared.page
      : null
  const formatted = supported && !!page?.formatted
  return (
    <div className="large-markdown-preview" data-preview-from={page?.from}>
      <div
        className="preview-toolbar"
        role="toolbar"
        aria-label="Formatted preview pages"
      >
        <Button
          disabled={!current.previous}
          onClick={() => {
            if (current.previous) setPosition(current.previous)
          }}
        >
          Previous part
        </Button>
        <Button
          disabled={!page?.next}
          onClick={() => {
            if (page?.next)
              setPosition({ source, cursor: page.next, previous: current })
          }}
        >
          Next part
        </Button>
      </div>
      <DocumentNotice
        title={
          !page || (formatted && !rendered)
            ? 'Preparing formatted preview…'
            : 'Formatted preview'
        }
        message="This preview shows one part at a time. Edit in Source view."
        busy={!page || (formatted && !rendered)}
      />
      {page &&
        (formatted ? (
          <MarkdownFootnotePreview
            key={`${source.version}:${page.from}:${version}`}
            source={page.text}
            documentId={documentId}
            revision={source.document.revision}
            version={version}
            onReady={ready}
          />
        ) : (
          <>
            <DocumentNotice
              title="Source excerpt"
              message="This part is shown as source to preserve Markdown that needs surrounding context."
            />
            <pre className="format-content markdown-footnote-preview">
              {page.text}
            </pre>
          </>
        ))}
    </div>
  )
}
