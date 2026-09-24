import { FileDown } from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { dependencyChangedEvent } from '../../shared/dependencies'
import type { WorkspaceChange } from '../../shared/workspace'
import { Button } from '../../ui/Controls'
import { DocumentNotice } from '../../ui/DocumentNotice'
import { PreviewActions } from '../../ui/PreviewActions'
import type { AddonContext } from '../api'
import { settingsEvent, systemCompilerEnabled } from './preferences'
import { svgSource } from './syntax'
import type { TypstResult } from './types'

const rendererId = crypto.randomUUID()
let workspaceRevision = 0
let stopWorkspaceListener: (() => void) | undefined
const workspaceListeners = new Set<(change?: WorkspaceChange) => void>()

function onWorkspaceChange(listener: (change?: WorkspaceChange) => void) {
  workspaceListeners.add(listener)
  if (!stopWorkspaceListener) {
    workspaceRevision++
    stopWorkspaceListener = window.hibi.onWorkspaceChanged(
      (_workspace, change) => {
        workspaceRevision++
        for (const notify of workspaceListeners) notify(change)
      },
    )
  }
  return () => {
    workspaceListeners.delete(listener)
    if (workspaceListeners.size === 0) {
      stopWorkspaceListener?.()
      stopWorkspaceListener = undefined
    }
  }
}

function onCompilerChange(listener: () => void) {
  window.addEventListener(settingsEvent, listener)
  return () => window.removeEventListener(settingsEvent, listener)
}

function affectsPreview(
  change: WorkspaceChange | undefined,
  paths: string[] | null,
) {
  if (!change || change.paths === null || paths === null) return true
  return change.paths.some((path) => {
    const changed = path.replaceAll('\\', '/')
    return (
      /\.(ttf|otf|ttc|otc)$/i.test(changed) ||
      paths.some(
        (dependency) =>
          dependency === changed || dependency.startsWith(`${changed}/`),
      )
    )
  })
}

export function TypstPreview({
  value,
  documentId,
  context,
  block = false,
  toolbar,
  onExport,
}: {
  value: string
  documentId?: string | undefined
  context: AddonContext
  block?: boolean
  toolbar?: HTMLElement | null | undefined
  onExport?: () => Promise<void>
}) {
  const [result, setResult] = useState<TypstResult | null>(null)
  const [busy, setBusy] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const systemCompiler = useSyncExternalStore(
    onCompilerChange,
    systemCompilerEnabled,
  )
  const compiled = useRef<{
    source: string
    documentId: string | undefined
    block: boolean
    paths: string[] | null
  } | null>(null)
  const images = useMemo(
    () => (result?.svgs ?? (result?.svg ? [result.svg] : [])).map(svgSource),
    [result?.svg, result?.svgs],
  )
  const [projectRevision, setProjectRevision] = useState(0)
  useEffect(() => {
    const refresh = () => {
      if (systemCompilerEnabled())
        setProjectRevision((revision) => revision + 1)
    }
    window.addEventListener(dependencyChangedEvent, refresh)
    return () => window.removeEventListener(dependencyChangedEvent, refresh)
  }, [])
  useEffect(
    () =>
      onWorkspaceChange((change) => {
        const current = compiled.current
        if (
          !current ||
          current.source !== value ||
          current.documentId !== documentId ||
          current.block !== block ||
          affectsPreview(change, current.paths)
        ) {
          compiled.current = null
          setProjectRevision(workspaceRevision)
        }
      }),
    [value, documentId, block],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: relevant workspace paths explicitly invalidate unchanged Typst source.
  useEffect(() => {
    let active = true
    compiled.current = null
    setBusy(true)
    const timer = setTimeout(() => {
      void context.native
        .query<TypstResult>('compile', {
          source: value,
          documentId,
          block,
          compiler: systemCompiler ? 'system' : 'bundled',
          revision: `${rendererId}:${workspaceRevision}`,
        })
        .then((result) => {
          if (active) {
            compiled.current = {
              source: value,
              documentId,
              block,
              paths: result.dependencies ?? null,
            }
            setResult(result)
          }
        })
        .catch((error: unknown) => {
          if (active) {
            compiled.current = null
            setResult({
              diagnostics: [
                {
                  severity: 'error',
                  message:
                    error instanceof Error
                      ? error.message
                      : 'Typst compilation failed.',
                },
              ],
            })
          }
        })
        .finally(() => {
          if (active) setBusy(false)
        })
    }, 250)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [value, documentId, context, block, projectRevision, systemCompiler])
  return (
    <div
      className="typst-preview"
      data-block={block || undefined}
      aria-busy={busy}
    >
      {onExport && (
        <PreviewActions target={toolbar}>
          <Button
            disabled={busy || exporting || images.length === 0}
            onClick={async () => {
              setExporting(true)
              setExportError('')
              try {
                await onExport()
              } catch (error) {
                setExportError(
                  error instanceof Error ? error.message : String(error),
                )
              } finally {
                setExporting(false)
              }
            }}
          >
            <FileDown size={14} aria-hidden />
            Export PDF
          </Button>
        </PreviewActions>
      )}
      {exportError && (
        <DocumentNotice title="Export unavailable" message={exportError} />
      )}
      {busy && (
        <p className="typst-progress" role="status">
          Compiling Typst…
        </p>
      )}
      {images.map((image, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Page order is fixed by the compiler.
        <figure key={index}>
          <img
            src={image}
            alt={
              block
                ? 'Typst block preview'
                : images.length > 1
                  ? `Typst document preview, page ${index + 1} of ${images.length}`
                  : `Typst document preview, ${result?.pages ?? 1} ${(result?.pages ?? 1) === 1 ? 'page' : 'pages'}`
            }
          />
        </figure>
      ))}
      {!!result?.diagnostics.length && (
        <DocumentNotice
          title={result.svg ? 'Compilation notes' : 'Preview unavailable'}
          message={result.diagnostics
            .map((diagnostic) => diagnostic.message)
            .join('\n')}
        />
      )}
    </div>
  )
}
