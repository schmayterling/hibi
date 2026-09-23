import { EyeOff, FolderOpen, Pin, PinOff, Trash2 } from 'lucide-react'
import type { KnownWorkspace, WorkspaceState } from '../../shared/workspace'
import { IconButton } from '../../ui/Controls'
import { useDialogs } from '../../ui/DialogProvider'
import { useMenus } from '../../ui/MenuHost'
import { Sidebar, type SidebarProps } from '../../ui/Sidebar'

export function WorkspacesSidebar({
  workspaces,
  workspace,
  open,
  overlay,
  resize,
  onDismiss,
  onOpen,
  onChange,
  onError,
}: {
  workspaces: readonly KnownWorkspace[] | null
  workspace: WorkspaceState | null
  open: boolean
  overlay: boolean
  resize: NonNullable<SidebarProps['resize']>
  onDismiss: () => void
  onOpen: (id?: string) => void
  onChange: () => Promise<void>
  onError: (error: unknown) => void
}) {
  const dialogs = useDialogs()
  const menus = useMenus(onError)
  const visible = workspaces?.filter((item) => !item.hidden) ?? []
  const ordered = [
    ...visible.filter((item) => item.pinned),
    ...visible.filter((item) => !item.pinned),
  ]
  const name = (path: string) =>
    path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

  async function update(id: string, action: 'pin' | 'unpin' | 'hide') {
    try {
      await window.hibi.setKnownWorkspace(id, action)
      await onChange()
    } catch (error) {
      onError(error)
    }
  }

  async function remove(item: KnownWorkspace) {
    if (
      !(await dialogs.confirm({
        title: `Move ${item.path} to Trash?`,
        description:
          'This moves the workspace folder and all its contents to system Trash. You can restore it from Trash.',
        confirmLabel: 'Move to Trash',
        destructive: true,
      }))
    )
      return
    try {
      if (await window.hibi.deleteKnownWorkspace(item.id)) await onChange()
    } catch (error) {
      onError(error)
    }
  }

  function openMenu(id: string, anchor: HTMLElement) {
    const item = visible.find((entry) => entry.id === id)
    if (!item) return
    menus.open({
      label: `Actions for ${item.path}`,
      anchor,
      items: [
        {
          id: 'pin',
          label: item.pinned ? 'Unpin from top' : 'Pin to top',
          icon: item.pinned ? PinOff : Pin,
          onSelect: () => update(id, item.pinned ? 'unpin' : 'pin'),
        },
        {
          id: 'hide',
          label: 'Hide workspace',
          icon: EyeOff,
          onSelect: () => update(id, 'hide'),
        },
        {
          id: 'delete',
          label: 'Delete workspace…',
          icon: Trash2,
          separatorBefore: true,
          onSelect: () => remove(item),
        },
      ],
    })
  }

  return (
    <Sidebar
      className="document-sidebar workspaces-sidebar"
      label="Workspaces"
      header={
        <>
          <span>Workspaces</span>
          <IconButton
            aria-label="Open a folder"
            title="Open a folder"
            onClick={() => onOpen()}
          >
            <FolderOpen size={15} />
          </IconButton>
        </>
      }
      items={ordered.map((item) => ({
        id: item.id,
        label: name(item.path),
        icon: item.pinned ? Pin : FolderOpen,
        decoration: { label: item.path },
      }))}
      selected={workspace?.id ?? null}
      onSelect={onOpen}
      onMenu={openMenu}
      open={open}
      overlay={overlay}
      onDismiss={onDismiss}
      resize={resize}
      empty={
        workspaces === null
          ? 'Loading workspaces…'
          : 'No workspaces yet. Open a folder to add it here.'
      }
    />
  )
}
