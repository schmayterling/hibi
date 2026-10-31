import { type KeyboardEvent, useEffect, useMemo, useState } from 'react'
import { errorMessage } from '../../shared/errors'
import {
  type DocumentVersion,
  HISTORY_PREVIEW_BYTES,
} from '../../shared/history'
import type { RawEdit } from '../../shared/source-operations'
import { Button } from '../../ui/Controls'
import { documentRuntime } from './document-runtime'
import {
  goToStep,
  type HistoryPoint,
  historyChanges,
  historyOf,
  historyPoints,
  historySummary,
} from './history-points'
import './version-history.css'

/**
 * A saved version to restore; points and steps are taken in the dialog. One
 * too large to preview replaces the editor's text instead of editing it.
 */
export type HistoryResult = { version: string; large: boolean }
type Entry = { id: string; label: string; time: number } & (
  | { kind: 'point' | 'step'; step: number; level: number }
  | { kind: 'version'; version: DocumentVersion }
)

const reasons: Record<HistoryPoint['reason'], string> = {
  oldest: 'Oldest kept text',
  stopped: 'Before undo',
  branched: 'Where edits branched',
  paused: 'Pause',
  'before-large': 'Before a large edit',
  typing: 'While typing',
}
const summary = ({
  added,
  removed,
  line,
}: ReturnType<typeof historySummary>) =>
  added || removed
    ? [added && `${added} words added`, removed && `${removed} words removed`]
        .filter(Boolean)
        .join(', ')
    : line
      ? `Changed “${line.slice(0, 60)}”`
      : 'Spacing or punctuation'

// ponytail: a preview part shows its first 10,000 characters; a streamed
// viewport would show all of a whole-note change.
const shown = (part: string) =>
  part.length > 10_000 ? `${part.slice(0, 10_000)}…` : part
/** Each change with the line before it and after it. */
function changeLines(text: string, changes: readonly RawEdit[]) {
  const start = (at: number) => text.lastIndexOf('\n', at - 1) + 1
  const end = (at: number) => {
    const found = text.indexOf('\n', at)
    return found < 0 ? text.length : found
  }
  return changes.map(({ from, to, insert }) => ({
    before: text.slice(start(Math.max(0, start(from) - 1)), from),
    removed: shown(text.slice(from, to)),
    added: shown(insert),
    after: text.slice(to, end(Math.min(text.length, end(to) + 1))),
  }))
}

export function History({
  close,
}: {
  close: (result: HistoryResult | null) => void
}) {
  const session = documentRuntime.session()
  const [mode, setMode] = useState<'points' | 'steps'>('points')
  const [versions, setVersions] = useState<DocumentVersion[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<ReturnType<typeof changeLines> | null>(
    null,
  )
  const [error, setError] = useState('')
  const tree = useMemo(() => (session ? historyOf(session) : null), [session])
  const text = useMemo(() => session?.snapshot().materialize() ?? '', [session])
  useEffect(() => {
    let active = true
    void window.hibi.listVersions().then(
      (versions) => {
        if (active) setVersions(versions)
      },
      (error: unknown) => {
        if (active) setError(errorMessage(error))
      },
    )
    return () => {
      active = false
    }
  }, [])
  const entries = useMemo((): Entry[] => {
    if (mode === 'steps') {
      if (!tree) return []
      // Oldest first; a step undo replaced sits one level in, under the
      // step it left from.
      const ordered: Entry[] = []
      const visit = (step: number, level: number) => {
        const { group, parent } = tree.steps[step]!
        ordered.push({
          id: `step-${step}`,
          kind: 'step',
          step,
          level,
          time: group.time,
          label: `${new Date(group.time).toLocaleTimeString()} · ${summary(historySummary(tree, parent, step))}${step === tree.current ? ' · Current' : ''}`,
        })
        const children = tree.children[step + 1]!
        for (const child of children)
          visit(child, child === children.at(-1) ? level : level + 1)
      }
      ordered.push({
        id: 'step--1',
        kind: 'step',
        step: -1,
        level: 1,
        time: 0,
        label: `Oldest kept text${tree.current === -1 ? ' · Current' : ''}`,
      })
      const top = tree.children[0]!
      for (const child of top) visit(child, child === top.at(-1) ? 2 : 3)
      return ordered
    }
    const points = tree ? historyPoints(tree, Date.now()) : []
    const listed = new Set(points.map(({ step }) => step))
    // A point's summary covers the edits since the point before it.
    const previous = (step: number) => {
      let parent = tree!.steps[step]!.parent
      while (parent !== -1 && !listed.has(parent))
        parent = tree!.steps[parent]!.parent
      return parent
    }
    return [
      ...points.map(
        ({ step, time, reason }): Entry => ({
          id: `point-${step}`,
          kind: 'point',
          step,
          level: 1,
          time,
          label: `${new Date(time).toLocaleString()} · ${reasons[reason]}${step === -1 ? '' : ` · ${summary(historySummary(tree!, previous(step), step))}`}`,
        }),
      ),
      ...versions.map(
        (version): Entry => ({
          id: `version-${version.id}`,
          kind: 'version',
          version,
          time: version.savedAt,
          label: `${new Date(version.savedAt).toLocaleString()} · Saved version`,
        }),
      ),
    ].sort((a, b) => b.time - a.time)
  }, [mode, tree, versions])
  const entry = entries.find(({ id }) => id === selected) ?? null
  useEffect(() => {
    setPreview(null)
    setError('')
    if (!entry || !tree) return
    if (entry.kind !== 'version') {
      setPreview(
        changeLines(text, historyChanges(tree, tree.current, entry.step)),
      )
      return
    }
    if (entry.version.bytes > HISTORY_PREVIEW_BYTES) return
    let active = true
    void window.hibi.previewVersion(entry.version.id).then(
      (version) => {
        if (!active) return
        let from = 0,
          to = text.length,
          end = version.length
        while (from < to && from < end && text[from] === version[from]) from++
        while (to > from && end > from && text[to - 1] === version[end - 1]) {
          to--
          end--
        }
        setPreview(
          from === to && from === end
            ? []
            : changeLines(text, [
                { from, to, insert: version.slice(from, end) },
              ]),
        )
      },
      (error: unknown) => {
        if (active) setError(errorMessage(error))
      },
    )
    return () => {
      active = false
    }
  }, [entry, tree, text])
  const current = entry?.kind === 'step' && entry.step === tree?.current
  function act() {
    if (!entry || !session || !tree || current) return
    if (entry.kind === 'version') {
      close({
        version: entry.version.id,
        large: entry.version.bytes > HISTORY_PREVIEW_BYTES,
      })
      return
    }
    try {
      if (entry.kind === 'step') goToStep(session, tree, entry.step)
      else {
        // Restoring is a new step: undo goes back to the text before it.
        const changes = historyChanges(tree, tree.current, entry.step).filter(
          ({ from, to, insert }) => text.slice(from, to) !== insert,
        )
        if (changes.length) session.edit(changes, 'visual', crypto.randomUUID())
      }
      close(null)
    } catch (error) {
      setError(errorMessage(error))
    }
  }
  function key(event: KeyboardEvent) {
    const index = entries.findIndex(({ id }) => id === selected)
    const parentOf = (step: number) =>
      step === -1 ? null : `step-${tree!.steps[step]!.parent}`
    const next =
      event.key === 'ArrowDown'
        ? entries[Math.min(entries.length - 1, index + 1)]?.id
        : event.key === 'ArrowUp'
          ? entries[Math.max(0, index - 1)]?.id
          : event.key === 'Home'
            ? entries[0]?.id
            : event.key === 'End'
              ? entries.at(-1)?.id
              : event.key === 'ArrowLeft' && entry?.kind === 'step'
                ? parentOf(entry.step)
                : event.key === 'ArrowRight' && entry?.kind === 'step'
                  ? tree!.children[entry.step + 1]![0] !== undefined
                    ? `step-${tree!.children[entry.step + 1]![0]}`
                    : null
                  : undefined
    if (event.key === 'Enter') act()
    else if (next === undefined) return
    else if (next !== null) setSelected(next)
    event.preventDefault()
  }
  const steps = mode === 'steps'
  return (
    <>
      <div className="history-modes">
        <Button
          aria-pressed={!steps}
          onClick={() => {
            setMode('points')
            setSelected(null)
          }}
        >
          Points
        </Button>
        <Button
          aria-pressed={steps}
          onClick={() => {
            setMode('steps')
            setSelected(tree ? `step-${tree.current}` : null)
          }}
        >
          All steps
        </Button>
      </div>
      {!entries.length ? (
        <p>
          {steps
            ? 'This note has no undo steps yet.'
            : 'Points to return to appear as you edit and save this note.'}
        </p>
      ) : (
        <div className="version-history">
          {steps ? (
            <div
              role="tree"
              aria-label="All undo steps"
              aria-activedescendant={entry ? `history-${entry.id}` : undefined}
              tabIndex={0}
              className="history-entries"
              onKeyDown={key}
            >
              {entries.map((item) => (
                <div
                  key={item.id}
                  id={`history-${item.id}`}
                  role="treeitem"
                  aria-selected={item.id === selected}
                  aria-level={'level' in item ? item.level : 1}
                  aria-current={
                    item.kind === 'step' && item.step === tree?.current
                      ? 'true'
                      : undefined
                  }
                  style={{
                    paddingInlineStart: `calc(${'level' in item ? item.level : 1} * var(--space-3))`,
                  }}
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    setSelected(item.id)
                    event.currentTarget.parentElement?.focus()
                  }}
                  onKeyDown={(event) => {
                    // One list handles each key, whichever holds focus.
                    event.stopPropagation()
                    key(event)
                  }}
                  onDoubleClick={act}
                >
                  {item.label}
                </div>
              ))}
            </div>
          ) : (
            <div
              role="listbox"
              aria-label="Points to return to"
              aria-activedescendant={entry ? `history-${entry.id}` : undefined}
              tabIndex={0}
              className="history-entries"
              onKeyDown={key}
              onFocus={() =>
                // A click selects its option before focusing the list.
                setSelected((selected) => selected ?? entries[0]!.id)
              }
            >
              {entries.map((item) => (
                <div
                  key={item.id}
                  id={`history-${item.id}`}
                  role="option"
                  aria-selected={item.id === selected}
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    setSelected(item.id)
                    event.currentTarget.parentElement?.focus()
                  }}
                  onKeyDown={(event) => {
                    // One list handles each key, whichever holds focus.
                    event.stopPropagation()
                    key(event)
                  }}
                  onDoubleClick={act}
                >
                  {item.label}
                </div>
              ))}
            </div>
          )}
          <section aria-label="Changes from the current text">
            {!entry ? (
              <p>Choose a point to see what returning to it changes.</p>
            ) : entry.kind === 'version' &&
              entry.version.bytes > HISTORY_PREVIEW_BYTES ? (
              <p role="status">
                This saved version is too large to preview. You can still
                restore it to the editor.
              </p>
            ) : !preview ? (
              <p role="status">Loading preview…</p>
            ) : !preview.length ? (
              <p>The text is the same as now.</p>
            ) : (
              <pre>
                {preview.map((change, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: changes have no identity but their order.
                  <span key={index}>
                    {index > 0 && '\n…\n'}
                    {change.before}
                    {change.removed && <del>{change.removed}</del>}
                    {change.added && <ins>{change.added}</ins>}
                    {change.after}
                  </span>
                ))}
              </pre>
            )}
          </section>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions">
        <Button onClick={() => close(null)}>Cancel</Button>
        <Button
          className="dialog-primary"
          onClick={act}
          disabled={!entry || !session || current}
        >
          {steps ? 'Go to step' : 'Restore'}
        </Button>
      </div>
    </>
  )
}
