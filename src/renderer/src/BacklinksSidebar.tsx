import { FileText } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { MarkdownExtension } from '../../addons/api'
import type { WorkspaceState } from '../../shared/workspace'
import { workspaceSyntaxEvents } from '../../shared/workspace-syntax-events'
import { Sidebar, type SidebarProps } from '../../ui/Sidebar'
import { captureWorkspaceSyntaxSnapshot } from './workspace-syntax-snapshot'

export function BacklinksSidebar({
  workspace,
  revision,
  hashtags,
  projections,
  onFile,
  open,
  overlay,
  onDismiss,
  resize,
  side = 'left',
}: {
  workspace: WorkspaceState | null
  revision: number | undefined
  hashtags: boolean
  projections: readonly MarkdownExtension[]
  onFile: (path: string) => void
  open: boolean
  overlay: boolean
  onDismiss: () => void
  resize: NonNullable<SidebarProps['resize']>
  side?: 'left' | 'right'
}) {
  const [links, setLinks] = useState<string[]>([])
  const [incomplete, setIncomplete] = useState(false)
  const syntaxRevision = useSyncExternalStore(
    workspaceSyntaxEvents.subscribe,
    workspaceSyntaxEvents.snapshot,
  )
  useEffect(() => {
    void revision
    void syntaxRevision
    const current = workspace?.activePath
    const workspaceId = workspace?.id
    setLinks([])
    setIncomplete(false)
    if (!open || !current || !workspaceId) return
    let active = true
    const timer = setTimeout(() => {
      const read = async () => {
        try {
          const snapshot = await window.hibi.getWorkspaceChangeSnapshot()
          if (!snapshot.target || snapshot.target.workspaceId !== workspaceId)
            return
          const paths: string[] = []
          const syntaxSnapshot = captureWorkspaceSyntaxSnapshot(
            hashtags,
            projections,
          )
          let offset = 0
          let complete = true
          while (active) {
            const response = await window.hibi.queryWorkspaceReferences({
              target: snapshot.target,
              kind: 'backlinks',
              path: current,
              offset,
              limit: 100,
              syntaxSnapshot,
            })
            if (!response.ok || response.value.kind !== 'backlinks') {
              if (active) setIncomplete(true)
              return
            }
            complete &&= response.value.complete
            paths.push(...response.value.items)
            if (!response.value.hasMore) break
            if (response.value.nextOffset <= offset) return
            offset = response.value.nextOffset
          }
          if (active) {
            setLinks(paths.filter((path) => path !== current))
            setIncomplete(!complete)
          }
        } catch {
          if (active) setIncomplete(true)
        }
      }
      void read()
    }, 200)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [open, workspace, revision, hashtags, projections, syntaxRevision])
  return (
    <Sidebar
      className="document-sidebar backlinks-sidebar"
      side={side}
      label="Backlinks"
      header={side === 'left' ? <span>Backlinks</span> : null}
      footer={
        incomplete ? (
          <span role="status">Backlinks may be incomplete.</span>
        ) : null
      }
      items={links.map((path) => ({ id: path, label: path, icon: FileText }))}
      selected={null}
      onSelect={onFile}
      open={open}
      overlay={overlay}
      onDismiss={onDismiss}
      resize={resize}
      collapsible={false}
      empty={
        workspace?.activePath
          ? 'No notes link to this note.'
          : 'Open a note to see its backlinks.'
      }
    />
  )
}
