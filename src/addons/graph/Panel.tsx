import { CircleAlert, FileText, Network } from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { WorkspaceGraphItem } from '../../shared/workspace-query'
import { workspaceSyntaxEvents } from '../../shared/workspace-syntax-events.ts'
import type { AddonContext } from '../api'
import { Button, ControlRow, Panel, PanelMessage, TextInput } from '../ui'
import { useWorkspaceQueryTarget } from '../use-workspace-query'
import { GraphCanvas } from './Canvas'
import { metadataGraph } from './model'

export function GraphPanel({
  context,
  expandedView = false,
  initialQuery = '',
  onExpand,
}: {
  context: AddonContext
  expandedView?: boolean
  initialQuery?: string
  onExpand?: (query: string) => void
}) {
  const {
    target,
    workspace,
    loading: targetLoading,
    error: targetError,
  } = useWorkspaceQueryTarget(context)
  const [query, setQuery] = useState(initialQuery)
  const syntaxRevision = useSyncExternalStore(
    workspaceSyntaxEvents.subscribe,
    workspaceSyntaxEvents.snapshot,
  )
  const previous = useRef<ReturnType<typeof metadataGraph> | null>(null)
  const [result, setResult] = useState<{
    workspaceId: string
    generation: number
    syntaxRevision: number
    graph: ReturnType<typeof metadataGraph>
    complete: boolean
  } | null>(null)
  const [queryError, setQueryError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    if (!target) {
      setResult(null)
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    setQueryError('')
    const load = async () => {
      try {
        const items: WorkspaceGraphItem[] = []
        let cursor: string | undefined
        let complete = false
        do {
          const response = await context.workspace.query({
            target,
            kind: 'graph',
            ...(cursor ? { cursor } : {}),
            limit: 100,
          })
          if (!response.ok) throw new Error(response.message)
          if (response.value.kind !== 'graph')
            throw new Error('Invalid graph query.')
          items.push(...response.value.items)
          complete = response.value.complete
          if (!response.value.hasMore) break
          if (!response.value.nextCursor)
            throw new Error('Graph query stopped early.')
          cursor = response.value.nextCursor
        } while (active)
        if (!active) return
        const next = metadataGraph(items)
        const last = previous.current
        const graph =
          last &&
          last.nodes.length === next.nodes.length &&
          last.edges.length === next.edges.length &&
          last.nodes.every(
            (node, index) => node.id === next.nodes[index]?.id,
          ) &&
          last.edges.every(
            (edge, index) =>
              edge.source === next.edges[index]?.source &&
              edge.target === next.edges[index]?.target,
          )
            ? last
            : next
        previous.current = graph
        setResult({
          workspaceId: target.workspaceId,
          generation: target.workspaceGeneration,
          syntaxRevision,
          graph,
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
  }, [context, target, syntaxRevision])
  const current =
    result?.workspaceId === target?.workspaceId &&
    result?.generation === target?.workspaceGeneration &&
    result?.syntaxRevision === syntaxRevision
      ? result
      : null
  const full = current?.graph ?? metadataGraph([])
  const error = targetError || queryError
  const connections = useMemo(() => {
    const neighbors = new Set<string>()
    for (const edge of full.edges)
      if (
        edge.source === workspace?.activePath ||
        edge.target === workspace?.activePath
      ) {
        neighbors.add(edge.source)
        neighbors.add(edge.target)
      }
    neighbors.delete(workspace?.activePath ?? '')
    return full.nodes.filter((node) => neighbors.has(node.id))
  }, [full, workspace?.activePath])
  const graph = useMemo(() => {
    const matching = full.nodes.filter((node) =>
      node.id.toLowerCase().includes(query.trim().toLowerCase()),
    )
    // ponytail: SVG caps at 500 visible notes; use a canvas renderer for larger simultaneous graphs.
    const nodes = matching.slice(0, 500),
      ids = new Set(nodes.map((node) => node.id))
    return {
      nodes,
      edges: full.edges.filter(
        (edge) => ids.has(edge.source) && ids.has(edge.target),
      ),
      total: matching.length,
    }
  }, [full, query])
  const open = (path: string) => {
    void context.workspace.openFile(path)
  }
  return (
    <Panel className={`graph-panel${expandedView ? ' graph-tab' : ''}`}>
      <ControlRow className="graph-controls">
        <TextInput
          type="search"
          aria-label="Filter graph notes"
          placeholder="Filter notes…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </ControlRow>
      {error ? (
        <PanelMessage
          icon={<CircleAlert size={24} />}
          title="Graph unavailable"
          role="alert"
        >
          {error}
        </PanelMessage>
      ) : (targetLoading || loading) && !current ? (
        <PanelMessage
          icon={<Network size={24} />}
          title="Reading workspace…"
          loading
        />
      ) : !workspace ? (
        <PanelMessage icon={<Network size={24} />} title="No workspace open">
          Open a workspace to explore connections between notes.
        </PanelMessage>
      ) : !full.nodes.length ? (
        <PanelMessage icon={<Network size={24} />} title="No notes yet">
          Add notes to this workspace to see them here.
        </PanelMessage>
      ) : (
        <>
          <p className="graph-summary" role="status">
            {graph.nodes.length} of {graph.total} notes · {graph.edges.length}{' '}
            {graph.edges.length === 1 ? 'connection' : 'connections'}
            {graph.total > 500 ? ' · filter to see more notes' : ''}
            {current && !current.complete ? ' · graph index incomplete' : ''}
          </p>
          {graph.nodes.length ? (
            <GraphCanvas
              graph={graph}
              active={workspace.activePath}
              open={open}
              resetKey={`${workspace.id ?? workspace.name}:${query}`}
              expand={onExpand ? () => onExpand(query) : undefined}
            />
          ) : (
            <PanelMessage
              icon={<Network size={24} />}
              title="No matching notes"
            >
              Try another filter.
            </PanelMessage>
          )}
          {!expandedView && (
            <section className="graph-connections" aria-label="Connections">
              <h3>Connections</h3>
              {connections.length ? (
                connections.map((node) => (
                  <Button
                    key={node.id}
                    variant="row"
                    onClick={() => open(node.id)}
                  >
                    <FileText size={14} aria-hidden="true" />
                    <span data-tooltip={node.id} data-verbatim="true">
                      {node.id}
                    </span>
                  </Button>
                ))
              ) : (
                <p>
                  {workspace.activePath
                    ? 'No links to this note yet.'
                    : 'Open a note to see its connections.'}
                </p>
              )}
            </section>
          )}
        </>
      )}
    </Panel>
  )
}
