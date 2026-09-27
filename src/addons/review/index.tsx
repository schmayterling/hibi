import { Check, CheckCheck, Pin, RefreshCw, SpellCheck } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import {
  projectionRange,
  type TextProjection,
} from '../../shared/document-projection'
import { type AddonViewProps, defineAddon, type ViewInstance } from '../api'
import {
  Button,
  ControlRow,
  DocumentNotice,
  IconButton,
  PanelMessage,
} from '../ui'
import type { Finding } from './analyze'
import manifest from './manifest'
import css from './style.css?inline'

let stop: (() => void) | undefined
export default defineAddon({
  manifest,
  start(context) {
    context.styles.register('review', css)
    let generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let visible = false,
      disposed = false
    let state = {
      projection: null as TextProjection | null,
      findings: [] as Finding[],
      selected: '',
      busy: false,
      error: '',
    }
    const listeners = new Set<() => void>()
    const publish = (changes: Partial<typeof state>) => {
      state = { ...state, ...changes }
      for (const listener of listeners) listener()
    }
    const subscribe = (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
    const send = (projection: TextProjection) => {
      if (disposed || !visible) return
      const request = generation
      void context.analysis
        .run(projection)
        .then((result) => {
          if (
            disposed ||
            !visible ||
            request !== generation ||
            context.editor.getTextProjection()?.id !== projection.id
          )
            return
          if (result.status !== 'complete') {
            publish({
              busy: false,
              error: result.status === 'failed' ? result.message : '',
            })
            return
          }
          if (
            !Array.isArray(result.value) ||
            result.value.length > 100 ||
            result.value.some(
              (finding) =>
                !finding ||
                typeof finding.id !== 'string' ||
                finding.id.length > 100 ||
                typeof finding.message !== 'string' ||
                finding.message.length > 500 ||
                typeof finding.replacement !== 'string' ||
                finding.replacement.length > 500 ||
                !projectionRange(projection, finding.from, finding.to),
            )
          ) {
            publish({
              busy: false,
              error: 'Could not read the analysis result.',
            })
            return
          }
          context.editor.clearDecorations()
          publish({
            projection,
            findings: result.value as Finding[],
            selected: '',
            busy: false,
            error: '',
          })
        })
        .catch(() => {
          if (!disposed && visible && request === generation)
            publish({
              busy: false,
              error: 'Could not check this document. Try again.',
            })
        })
    }
    const refresh = () => {
      generation++
      clearTimeout(timer)
      if (!visible || disposed) return
      publish({ projection: null, selected: '', busy: true, error: '' })
      timer = setTimeout(() => {
        const document = context.editor.getDocument()
        const projection = context.editor.getTextProjection()
        if (
          !document ||
          !/\.(?:md|markdown|txt)$/i.test(document.name) ||
          !projection
        ) {
          publish({ projection: null, findings: [], busy: false })
          return
        }
        send(projection)
      }, 180)
    }
    context.editor.onDocumentChange(refresh)
    context.editor.onProjectionChange(refresh)
    let pinned: ViewInstance | undefined
    const report = context.views.register({
      id: 'report',
      label: 'Pinned review',
      location: 'panel',
      lifetime: 'session',
      Content({ input, close }: AddonViewProps) {
        const findings = input as Finding[]
        return (
          <div className="review-panel">
            <ControlRow>
              <Button onClick={close}>Unpin</Button>
            </ControlRow>
            {findings.length ? (
              <ul className="review-findings">
                {findings.map((finding) => (
                  <li key={finding.id}>
                    <span className="review-finding">{finding.message}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <PanelMessage
                icon={<CheckCheck size={28} />}
                title="No suggestions"
              />
            )}
          </div>
        )
      },
    })
    function Content() {
      const current = useSyncExternalStore(subscribe, () => state)
      useEffect(() => {
        visible = true
        refresh()
        return () => {
          visible = false
          clearTimeout(timer)
          generation++
          context.analysis.cancel()
          context.editor.clearDecorations()
        }
      }, [])
      const select = (finding: Finding) => {
        if (!current.projection) return
        if (
          context.editor.setDecorations(current.projection.id, [
            { ...finding, severity: 'warning' },
          ])
        )
          publish({ selected: finding.id })
        else refresh()
      }
      const apply = (finding: Finding) => {
        const projection = current.projection
        if (!projection) return
        const range = projectionRange(projection, finding.from, finding.to)
        if (!range) return
        const result = context.editor.applySourceEdits({
          requestId: crypto.randomUUID(),
          tabId: projection.tabId,
          revision: projection.revision,
          contentVersion: projection.contentVersion,
          projectionId: projection.id,
          changes: [
            {
              ...range,
              insert: finding.replacement,
              expectedText: projection.text.slice(finding.from, finding.to),
            },
          ],
        })
        if (result.status !== 'applied') publish({ error: result.message })
      }
      return (
        <div className="review-panel">
          <ControlRow>
            <IconButton
              aria-label="Pin review"
              disabled={!current.projection || current.busy}
              onClick={() => {
                pinned?.close()
                pinned = report.open({
                  binding: 'pinned',
                  input: current.findings,
                })
              }}
            >
              <Pin size={16} />
            </IconButton>
            <Button onClick={refresh} disabled={current.busy}>
              <RefreshCw size={14} />
              Check again
            </Button>
          </ControlRow>
          {current.error && (
            <DocumentNotice
              title="Could not apply suggestion"
              message={current.error}
            />
          )}
          {current.busy ? (
            <PanelMessage
              icon={<SpellCheck size={28} />}
              title="Checking document…"
            />
          ) : !current.projection ? (
            <PanelMessage
              icon={<SpellCheck size={28} />}
              title="Open a Markdown or text document"
            />
          ) : !current.findings.length ? (
            <PanelMessage
              icon={<CheckCheck size={28} />}
              title="No suggestions"
            />
          ) : (
            <ul className="review-findings">
              {current.findings.map((finding) => (
                <li
                  key={finding.id}
                  data-selected={current.selected === finding.id}
                >
                  <button
                    type="button"
                    className="review-finding"
                    onClick={() => select(finding)}
                  >
                    {finding.message}
                  </button>
                  <IconButton
                    aria-label={`Apply: ${finding.message}`}
                    title="Apply suggestion"
                    onClick={() => apply(finding)}
                  >
                    <Check size={16} />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      )
    }
    const view = context.sidebar.register({
      id: 'document',
      label: 'Review',
      icon: SpellCheck,
      Content,
    })
    const open = () => view.open()
    context.commands.register({
      id: 'open',
      label: 'Review document',
      keywords: 'typos repeated words proofreading',
      run: open,
    })
    context.commands.register({
      id: 'show-report',
      label: 'Show pinned review',
      run: () => {
        pinned?.show()
        pinned?.focus()
      },
    })
    context.toolbar.register({
      id: 'open',
      label: 'Review document',
      icon: SpellCheck,
      commandId: 'open',
    })
    stop = () => {
      disposed = true
      visible = false
      clearTimeout(timer)
      generation++
      context.analysis.cancel()
      context.editor.clearDecorations()
    }
  },
  stop() {
    stop?.()
    stop = undefined
  },
})
