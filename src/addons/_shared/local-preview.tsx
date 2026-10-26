import { FileDown } from 'lucide-react'
import {
  type ComponentType,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { errorMessage } from '../../shared/errors'
import { Button } from '../../ui/Controls'
import { DocumentNotice } from '../../ui/DocumentNotice'
import { PreviewActions } from '../../ui/PreviewActions'
import type {
  AddonContext,
  DocumentPreviewProps,
  RenderedMarkdown,
} from '../api'

export function localRender(
  context: AddonContext,
  render: (source: string, documentId?: string) => string | Promise<string>,
  css: string | (() => string),
) {
  return async (
    source: string,
    documentId?: string,
  ): Promise<RenderedMarkdown> => ({
    html: context.editor.isSyntaxEnabled('preview')
      ? await render(source, documentId)
      : `<pre>${source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>`,
    css: typeof css === 'function' ? css() : css,
  })
}

/**
 * The renderer must return sanitized HTML. Stale renders never replace newer input.
 * With Content, the preview draws the latest source itself and renders HTML only to export.
 */
export function localPreview(
  context: AddonContext,
  render: (source: string, documentId?: string) => Promise<RenderedMarkdown>,
  css?: () => string,
  Content?: ComponentType<{ source: string }>,
) {
  return function Preview({ value, document, toolbar }: DocumentPreviewProps) {
    const [result, setResult] = useState<RenderedMarkdown | null>(null)
    const [source, setSource] = useState(value)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const host = useRef<HTMLDivElement>(null)
    const enabled = useSyncExternalStore(context.editor.onSyntaxChange, () =>
      context.editor.isSyntaxEnabled('preview'),
    )
    useEffect(() => {
      let active = true
      if (!Content) setResult(null)
      setError('')
      const timer = setTimeout(() => {
        if (!enabled) return
        if (Content) setSource(value)
        else
          void render(value, document.id)
            .then((next) => {
              if (active) setResult(next)
            })
            .catch((reason) => {
              if (active) setError(errorMessage(reason))
            })
      }, 200)
      return () => {
        active = false
        clearTimeout(timer)
      }
    }, [value, enabled, document.id])
    useEffect(() => {
      if (host.current) host.current.innerHTML = result?.html ?? ''
    }, [result])
    return (
      <div className="format-preview">
        <PreviewActions target={toolbar}>
          <Button
            disabled={(Content ? !enabled : !result) || busy}
            onClick={async () => {
              setBusy(true)
              try {
                const exported = result ?? (await render(value, document.id))
                await context.native.invoke('export', {
                  html: exported.html,
                  css: css?.() ?? exported.css,
                  name: document.name,
                })
              } catch (reason) {
                setError(errorMessage(reason))
              } finally {
                setBusy(false)
              }
            }}
          >
            <FileDown size={14} aria-hidden />
            Export HTML
          </Button>
        </PreviewActions>
        {!enabled ? (
          <DocumentNotice
            title="Preview disabled"
            message="Enable this format’s preview in Settings → Syntax."
          />
        ) : error ? (
          <DocumentNotice title="Preview unavailable" message={error} />
        ) : !result && !Content ? (
          <DocumentNotice title="Rendering preview…" busy />
        ) : null}
        {Content ? (
          enabled && (
            <div className="format-content">
              <Content source={source} />
            </div>
          )
        ) : (
          <div ref={host} className="format-content" />
        )}
      </div>
    )
  }
}
