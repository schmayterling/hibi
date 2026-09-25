import { FileText } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { WorkspaceState } from '../../shared/workspace'
import { Sidebar, type SidebarProps } from '../../ui/Sidebar'

export function BacklinksSidebar({
  workspace,
  revision,
  onFile,
  open,
  overlay,
  onDismiss,
  resize,
  side = 'left',
}: {
  workspace: WorkspaceState | null
  revision: number | undefined
  onFile: (path: string) => void
  open: boolean
  overlay: boolean
  onDismiss: () => void
  resize: NonNullable<SidebarProps['resize']>
  side?: 'left' | 'right'
}) {
  const [links, setLinks] = useState<string[]>([])
  useEffect(() => {
    void revision
    const current = workspace?.activePath
    const workspaceId = workspace?.id
    setLinks([])
    if (!open || !current || !workspaceId) return
    let active = true
    const timer = setTimeout(() => {
      const read = async () => {
        try {
          const snapshot = await window.hibi.getWorkspaceChangeSnapshot()
          if (!snapshot.target || snapshot.target.workspaceId !== workspaceId)
            return
          const paths: string[] = []
          let offset = 0
          while (active) {
            const response = await window.hibi.queryWorkspaceReferences({
              target: snapshot.target,
              kind: 'backlinks',
              path: current,
              offset,
              limit: 100,
            })
            if (!response.ok || response.value.kind !== 'backlinks') return
            paths.push(...response.value.items)
            if (!response.value.hasMore) break
            if (response.value.nextOffset <= offset) return
            offset = response.value.nextOffset
          }
          if (active) setLinks(paths.filter((path) => path !== current))
        } catch {
          if (active) setLinks([])
        }
      }
      void read()
    }, 200)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [open, workspace, revision])
  return (
    <Sidebar
      className="document-sidebar backlinks-sidebar"
      side={side}
      label="Backlinks"
      header={side === 'left' ? <span>Backlinks</span> : null}
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
