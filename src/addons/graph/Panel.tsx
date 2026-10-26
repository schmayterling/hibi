import { CircleAlert, FileText, Network } from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { WorkspaceGraphItem } from '../../shared/workspace-query'
import { workspaceSyntaxEvents } from '../../shared/workspace-syntax-events.ts'
import type { AddonContext } from '../api'
import { Button, ControlRow, Panel, PanelMessage, TextInput } from '../ui'
import { useSerialRead, useWorkspaceQueryTarget } from '../use-workspace-query'
import { GraphCanvas } from './Canvas'
import { metadataGraph } from './model'

const layoutWorker = () =>
  new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })

/** Renders only rows near the scrolled view so hub notes stay cheap. */
function ConnectionRows({
  nodes,
  open,
}: {
  nodes: readonly { id: string }[]
  open: (path: string) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ from: 0, to: 40 })
  const [focused, setFocused] = useState<string | null>(null)
  useLayoutEffect(() => {
    const element = list.current
    let scroller = element?.parentElement ?? null
    while (
      scroller &&
      !/auto|scroll/.test(getComputedStyle(scroller).overflowY)
    )
      scroller = scroller.parentElement
    if (!element || !scroller) {
      setRange({ from: 0, to: nodes.length })
      return
    }
    const view = scroller
    const update = () => {
      const row =
        Number.parseFloat(
          getComputedStyle(element).getPropertyValue('--sidebar-row-height'),
        ) || 28
      const top =
        view.getBoundingClientRect().top - element.getBoundingClientRect().top
      const from = Math.max(0, Math.floor(top / row) - 8)
      const to = Math.min(
        nodes.length,
        Math.ceil((top + view.clientHeight) / row) + 8,
      )
      setRange((old) =>
        old.from === from && old.to === to ? old : { from, to },
      )
    }
    update()
    view.addEventListener('scroll', update, { passive: true })
    const resize = new ResizeObserver(update)
    resize.observe(view)
    return () => {
      view.removeEventListener('scroll', update)
      resize.disconnect()
    }
  }, [nodes])
  // Besides rows near the view, the first and last rows and the focused row's
  // neighbors stay mounted, so Tab and Shift+Tab always reach the next row in
  // order; focusing it scrolls it into view.
  const focusIndex = nodes.findIndex((node) => node.id === focused)
  const mounted = new Set([0, nodes.length - 1])
  for (let index = range.from; index < range.to; index++) mounted.add(index)
  if (focusIndex >= 0)
    for (const index of [focusIndex - 1, focusIndex, focusIndex + 1])
      mounted.add(index)
  const rows = [...mounted]
    .filter((index) => index >= 0 && index < nodes.length)
    .sort((a, b) => a - b)
  return (
    <div
      ref={list}
      className="graph-connection-rows"
      style={{ height: `calc(${nodes.length} * var(--sidebar-row-height))` }}
    >
      {rows.map((index) => {
        const node = nodes[index]!
        return (
          <Button
            key={node.id}
            variant="row"
            style={{ top: `calc(${index} * var(--sidebar-row-height))` }}
            onFocus={() => setFocused(node.id)}
            onClick={() => open(node.id)}
          >
            <FileText size={14} aria-hidden="true" />
            <span data-tooltip={node.id} data-verbatim="true">
              {node.id}
            </span>
          </Button>
        )
      })}
    </div>
  )
}

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
    revision,
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
  const read = useSerialRead()
  const latest = useRef(target)
  useEffect(() => {
    void revision
    latest.current = target
    if (!target) {
      setResult(null)
      read(null)
      return
    }
    read(async (alive, retry) => {
      // Each read reports its own outcome; a read for an older workspace stays quiet.
      setQueryError('')
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
          // The workspace changed while paging, such as opening a note.
          if (!response.ok && response.code === 'stale') return retry()
          if (!response.ok) throw new Error(response.message)
          if (response.value.kind !== 'graph')
            throw new Error('Invalid graph query.')
          items.push(...response.value.items)
          complete = response.value.complete
          if (!response.value.hasMore) break
          if (!response.value.nextCursor)
            throw new Error('Graph query stopped early.')
          cursor = response.value.nextCursor
        } while (alive())
        if (!alive()) return
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
        if (alive() && latest.current === target)
          setQueryError(error instanceof Error ? error.message : String(error))
      }
    })
  }, [context, target, revision, syntaxRevision, read])
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
    const filter = query.trim().toLowerCase()
    const nodes = full.nodes.filter((node) =>
      node.id.toLowerCase().includes(filter),
    )
    const ids = new Set(nodes.map((node) => node.id))
    return {
      nodes,
      edges: full.edges.filter(
        (edge) => ids.has(edge.source) && ids.has(edge.target),
      ),
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
      ) : (targetLoading || target) && !current ? (
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
            {graph.nodes.length} of {full.nodes.length} notes ·{' '}
            {graph.edges.length}{' '}
            {graph.edges.length === 1 ? 'connection' : 'connections'}
            {current && !current.complete ? ' · graph index incomplete' : ''}
          </p>
          {graph.nodes.length ? (
            <GraphCanvas
              graph={graph}
              active={workspace.activePath}
              open={open}
              resetKey={`${workspace.id ?? workspace.name}:${query}`}
              expand={onExpand ? () => onExpand(query) : undefined}
              worker={layoutWorker}
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
                <ConnectionRows nodes={connections} open={open} />
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
