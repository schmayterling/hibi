import { type KeyboardEvent, useEffect, useMemo, useState } from 'react'
import { errorMessage } from '../../shared/errors'
import {
  type DocumentVersion,
  HISTORY_PREVIEW_BYTES,
} from '../../shared/history'
import { Button } from '../../ui/Controls'
import { documentRuntime } from './document-runtime'
import { editorViewRegistry } from './editor-view-api'
import {
  changeLines,
  type HistoryPoint,
  historyChanges,
  historyOf,
  historyPoints,
  historySummary,
  returnTo,
  shownVersions,
  stepTime,
} from './history-points'
import { sourceCurrent } from './SourceEditor'
import { editorPosition, sourceView } from './source-view'
import './version-history.css'

/**
 * A saved version to restore; points and steps are taken in the dialog. One
 * too large to preview or to undo replaces the editor's text instead of
 * editing it.
 */
export type HistoryResult = { version: string; large: boolean }
type Entry = { id: string; label: string; time: number } & (
  | { kind: 'point' | 'step'; step: number; level: number }
  | { kind: 'version'; version: DocumentVersion }
)

// `label` fields are collected into the UI copy catalog.
const reasons: Record<HistoryPoint['reason'], { label: string }> = {
  oldest: { label: 'Oldest kept text' },
  stopped: { label: 'Before undo' },
  branched: { label: 'Where edits branched' },
  paused: { label: 'Pause' },
  'before-large': { label: 'Before a large edit' },
  typing: { label: 'While typing' },
}
const copy = {
  added: (count: number) =>
    count === 1 ? { label: '1 word added' } : { label: `${count} words added` },
  removed: (count: number) =>
    count === 1
      ? { label: '1 word removed' }
      : { label: `${count} words removed` },
  changed: (line: string) => ({ label: `Changed “${line}”` }),
  spacing: { label: 'Spacing or punctuation' },
  current: { label: 'Current' },
}
/** An entry's depth in the steps tree; points and versions are all at the top. */
const level = (item?: Entry) => (item && 'level' in item ? item.level : 1)
const summary = ({
  added,
  removed,
  line,
}: ReturnType<typeof historySummary>) =>
  added || removed
    ? [added && copy.added(added).label, removed && copy.removed(removed).label]
        .filter(Boolean)
        .join(', ')
    : line
      ? copy.changed(line.slice(0, 60)).label
      : copy.spacing.label

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
  const version = useMemo(() => session?.snapshot().version ?? 0, [session])
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
    const now = Date.now()
    if (mode === 'steps') {
      if (!tree) return []
      const current = (step: number) =>
        step === tree.current ? ` · ${copy.current.label}` : ''
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
          label: `${stepTime(group.time, now)} · ${summary(historySummary(tree, parent, step))}${current(step)}`,
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
        label: `${reasons.oldest.label}${current(-1)}`,
      })
      const top = tree.children[0]!
      for (const child of top) visit(child, child === top.at(-1) ? 2 : 3)
      return ordered
    }
    // Saved states are listed once, as their saved versions.
    const points = tree
      ? historyPoints(
          tree,
          now,
          versions.at(-1)?.savedAt ?? Number.POSITIVE_INFINITY,
        )
      : []
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
          label: `${new Date(time).toLocaleString()} · ${reasons[reason].label}${step === -1 ? '' : ` · ${summary(historySummary(tree!, previous(step), step))}`}`,
        }),
      ),
      ...shownVersions(
        versions,
        now,
        tree,
        points.map(({ time }) => time),
      ).map(
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
  // The selected entry stays in view as the keyboard moves it.
  useEffect(() => {
    if (selected)
      document
        .getElementById(`history-${selected}`)
        ?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  // A restore past a session's 8 MiB history cap would be trimmed as it is
  // recorded, losing unsaved text: such a version replaces the text as before,
  // after asking to save.
  const replaces =
    entry?.kind === 'version' &&
    (entry.version.bytes > HISTORY_PREVIEW_BYTES ||
      2 * (entry.version.bytes + text.length) + 96 > 8 * 1024 * 1024)
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
      close({ version: entry.version.id, large: replaces })
      return
    }
    // The editor the user works in, as undo from the palette finds it.
    const view = documentRuntime.captureActiveView()
    const surface =
      view && view.documentId === documentRuntime.captureDocument()?.documentId
        ? editorViewRegistry.surface(view)
        : null
    const editor = surface && sourceView(surface)
    // As with its own undo, a read-only editor takes no step.
    if (editor?.state.readOnly) {
      setError('The editor is read-only right now.')
      return
    }
    try {
      const at = returnTo(
        session,
        tree,
        text,
        version,
        entry.step,
        entry.kind === 'step',
      )
      // The editor shows the change, with its caret after it.
      if (editor && at !== null && sourceCurrent(editor)) {
        const position = editorPosition(editor, at)
        if (position !== null)
          editor.dispatch({
            selection: { anchor: position },
            scrollIntoView: true,
          })
      }
      close(null)
    } catch (error) {
      setError(errorMessage(error))
    }
  }
  function key(event: KeyboardEvent) {
    const index = entries.findIndex(({ id }) => id === selected)
    const next =
      event.key === 'ArrowDown'
        ? entries[Math.min(entries.length - 1, index + 1)]?.id
        : event.key === 'ArrowUp'
          ? entries[Math.max(0, index - 1)]?.id
          : event.key === 'Home'
            ? entries[0]?.id
            : event.key === 'End'
              ? entries.at(-1)?.id
              : // As in a tree, Left goes to the item holding this one, and
                // Right to the first item this one holds.
                event.key === 'ArrowLeft' && entry?.kind === 'step'
                ? (entries
                    .slice(0, index)
                    .findLast((item) => level(item) < level(entry))?.id ?? null)
                : event.key === 'ArrowRight' && entry?.kind === 'step'
                  ? holds(index)
                    ? entries[index + 1]!.id
                    : null
                  : undefined
    if (event.key === 'Enter') act()
    else if (next === undefined) return
    else if (next !== null) setSelected(next)
    event.preventDefault()
  }
  const steps = mode === 'steps'
  // An item with deeper items after it holds them, always shown.
  const holds = (index: number) =>
    level(entries[index + 1]) > level(entries[index])
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
              {entries.map((item, index) => (
                <div
                  key={item.id}
                  id={`history-${item.id}`}
                  role="treeitem"
                  aria-selected={item.id === selected}
                  aria-level={'level' in item ? item.level : 1}
                  aria-expanded={holds(index) || undefined}
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
      {replaces && (
        <p>
          Restoring this version replaces the text and its undo history, so undo
          cannot take it back.
        </p>
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
