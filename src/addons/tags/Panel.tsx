import { CircleAlert, FileText, Tags } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AddonContext } from '../api'
import { Button, ControlRow, Panel, PanelMessage, TextInput } from '../ui'
import { useWorkspaceSnapshot } from '../workspace-snapshot'
import { type TagIndexCache, tagIndex } from './model'

export function TagsPanel({
  context,
  selection,
}: {
  context: AddonContext
  selection: unknown
}) {
  const { snapshot, workspace, loading, error } = useWorkspaceSnapshot(context)
  const [query, setQuery] = useState('')
  const [selected, select] = useState('')
  const parsed = useRef<TagIndexCache>({
    workspaceId: undefined,
    pages: new Map(),
  }).current
  useEffect(() => {
    const tag =
      selection && typeof selection === 'object' && 'tag' in selection
        ? selection.tag
        : undefined
    if (typeof tag === 'string') {
      select(tag)
      setQuery('')
    }
  }, [selection])
  const index = useMemo(
    () => tagIndex(workspace?.id, snapshot?.pages ?? [], parsed),
    [workspace?.id, snapshot, parsed],
  )
  const matches = index.filter(([tag]) =>
    tag.includes(query.trim().replace(/^#/, '').toLowerCase()),
  )
  const files = index.find(([tag]) => tag === selected)?.[1] ?? []
  return (
    <Panel className="tags-panel">
      <ControlRow className="tags-controls">
        <TextInput
          type="search"
          aria-label="Filter tags"
          placeholder="Filter tags…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </ControlRow>
      {error ? (
        <PanelMessage
          icon={<CircleAlert size={24} />}
          title="Tags unavailable"
          role="alert"
        >
          {error}
        </PanelMessage>
      ) : loading && !snapshot ? (
        <PanelMessage icon={<Tags size={24} />} title="Reading tags…" loading />
      ) : !workspace ? (
        <PanelMessage icon={<Tags size={24} />} title="No workspace open">
          Open a workspace to browse tags across your notes.
        </PanelMessage>
      ) : !matches.length ? (
        <PanelMessage
          icon={<Tags size={24} />}
          title={index.length ? 'No matching tags' : 'No tags yet'}
        >
          {index.length
            ? 'Try another filter.'
            : 'Write #tag in a note to organize it here.'}
        </PanelMessage>
      ) : (
        <div className="tags-browser">
          <section className="tags-list" aria-label="Workspace tags">
            {matches.map(([tag, paths]) => (
              <Button
                variant="row"
                key={tag}
                aria-pressed={selected === tag}
                onClick={() => select(tag)}
              >
                <span>#{tag}</span>
                <span>{paths.length}</span>
              </Button>
            ))}
          </section>
          {files.length > 0 && (
            <section
              className="tags-files"
              aria-label={
                selected ? `Notes tagged #${selected}` : 'Tagged notes'
              }
            >
              <p>
                {selected
                  ? `#${selected} · ${files.length} ${files.length === 1 ? 'note' : 'notes'}`
                  : 'Select a tag to see its notes.'}
              </p>
              {files.map((path) => (
                <Button
                  variant="row"
                  key={path}
                  onClick={() => {
                    void context.workspace.openFile(path)
                  }}
                >
                  <FileText size={14} aria-hidden="true" />
                  <span data-tooltip={path} data-verbatim="true">
                    {path}
                  </span>
                </Button>
              ))}
            </section>
          )}
        </div>
      )}
    </Panel>
  )
}
