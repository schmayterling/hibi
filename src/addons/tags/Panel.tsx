import { CircleAlert, FileText, Tags } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { WorkspaceTagSummary } from '../../shared/workspace-query'
import type { AddonContext } from '../api'
import { Button, ControlRow, Panel, PanelMessage, TextInput } from '../ui'
import { useWorkspaceQueryTarget } from '../use-workspace-query'

export function TagsPanel({
  context,
  selection,
}: {
  context: AddonContext
  selection: unknown
}) {
  const {
    target,
    workspace,
    loading: targetLoading,
    error: targetError,
  } = useWorkspaceQueryTarget(context)
  const [query, setQuery] = useState('')
  const [selected, select] = useState('')
  const [summary, setSummary] = useState<{
    workspaceId: string
    generation: number
    tags: readonly WorkspaceTagSummary[]
    complete: boolean
  } | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<{
    workspaceId: string
    generation: number
    tag: string
    files: readonly string[]
  } | null>(null)
  const [queryError, setQueryError] = useState('')
  const [loading, setLoading] = useState(true)
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
  useEffect(() => {
    if (!target) {
      setSummary(null)
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    setQueryError('')
    const load = async () => {
      try {
        const tags: WorkspaceTagSummary[] = []
        let offset = 0
        let complete = false
        do {
          const response = await context.workspace.query({
            target,
            kind: 'tags',
            offset,
            limit: 100,
          })
          if (!response.ok) throw new Error(response.message)
          if (response.value.kind !== 'tags')
            throw new Error('Invalid tags query.')
          tags.push(...response.value.items)
          complete = response.value.complete
          if (!response.value.hasMore) break
          if (response.value.nextOffset <= offset)
            throw new Error('Tags query stopped early.')
          offset = response.value.nextOffset
        } while (active)
        if (active)
          setSummary({
            workspaceId: target.workspaceId,
            generation: target.workspaceGeneration,
            tags,
            complete,
          })
      } catch (error) {
        if (active)
          setQueryError(error instanceof Error ? error.message : String(error))
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [context, target])
  useEffect(() => {
    if (!target || !selected) {
      setSelectedFiles(null)
      return
    }
    let active = true
    const load = async () => {
      try {
        const files: string[] = []
        let offset = 0
        do {
          const response = await context.workspace.query({
            target,
            kind: 'tag',
            tag: selected,
            offset,
            limit: 100,
          })
          if (!response.ok) throw new Error(response.message)
          if (response.value.kind !== 'tag')
            throw new Error('Invalid tag query.')
          files.push(...response.value.items)
          if (!response.value.hasMore) break
          if (response.value.nextOffset <= offset)
            throw new Error('Tag query stopped early.')
          offset = response.value.nextOffset
        } while (active)
        if (active)
          setSelectedFiles({
            workspaceId: target.workspaceId,
            generation: target.workspaceGeneration,
            tag: selected,
            files,
          })
      } catch (error) {
        if (active)
          setQueryError(error instanceof Error ? error.message : String(error))
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [context, target, selected])
  const current =
    summary?.workspaceId === target?.workspaceId &&
    summary?.generation === target?.workspaceGeneration
      ? summary
      : null
  const index = current?.tags ?? []
  const matches = index.filter(({ tag }) =>
    tag.includes(query.trim().replace(/^#/, '').toLowerCase()),
  )
  const files =
    selectedFiles?.workspaceId === target?.workspaceId &&
    selectedFiles?.generation === target?.workspaceGeneration &&
    selectedFiles?.tag === selected
      ? selectedFiles.files
      : []
  const error = targetError || queryError
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
      ) : (targetLoading || loading) && !current ? (
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
            {!current?.complete && <p role="status">Tag index incomplete.</p>}
            {matches.map(({ tag, count }) => (
              <Button
                variant="row"
                key={tag}
                aria-pressed={selected === tag}
                onClick={() => select(tag)}
              >
                <span>#{tag}</span>
                <span>{count}</span>
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
