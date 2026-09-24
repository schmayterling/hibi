import { FileText } from 'lucide-react'
import { useEffect, useState } from 'react'
import { noteTargets } from '../../shared/note-links'
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
    if (!open || !current) return
    let active = true
    const timer = setTimeout(() => {
      void window.hibi.getWorkspaceIndex().then(
        (index) => {
          if (!active || !index || index.workspace.id !== workspace.id) return
          const paths = new Set(index.pages.map((page) => page.path))
          setLinks(
            index.pages
              .filter(
                (page) =>
                  page.path !== workspace.activePath &&
                  noteTargets(page.markdown, page.path, paths).includes(
                    current,
                  ),
              )
              .map((page) => page.path),
          )
        },
        () => {
          if (active) setLinks([])
        },
      )
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
