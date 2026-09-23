import { FolderOpen, Folders, ListTree, PanelLeft } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import type { AddonView } from '../../addons/api'
import { Sidebar, type SidebarProps } from '../../ui/Sidebar'
import { AddonViewContent } from './AddonViewContent'
import { addonViews } from './addon-views'

export const builtInViews = [
  { id: 'workspace', label: 'Workspace', icon: FolderOpen },
  { id: 'workspaces', label: 'Workspaces', icon: Folders },
  { id: 'outline', label: 'On this page', icon: ListTree },
]

export function viewShortcut(view: AddonView) {
  return { id: view.id, label: view.label, icon: view.icon ?? PanelLeft }
}

export function AddonSidebar({
  view,
  input,
  open,
  overlay,
  onDismiss,
  resize,
  side = 'left',
  empty = false,
}: {
  view: AddonView | undefined
  input: unknown
  open: boolean
  overlay: boolean
  onDismiss: () => void
  resize: NonNullable<SidebarProps['resize']>
  side?: 'left' | 'right'
  empty?: boolean
}) {
  const state = useSyncExternalStore(addonViews.subscribe, addonViews.snapshot)
  useEffect(() => {
    if (open) addonViews.selectSidebar(view?.id ?? 'none', input, side)
  }, [open, view, input, side])
  return (
    <Sidebar
      className="document-sidebar addon-sidebar"
      side={side}
      label={view?.label ?? (empty ? 'Right sidebar' : 'Addon view')}
      header={side === 'left' ? <span>{view?.label}</span> : null}
      items={[]}
      selected={null}
      onSelect={() => {}}
      open={open && (!!view || empty)}
      overlay={overlay}
      onDismiss={onDismiss}
      resize={resize}
      content={
        <>
          {empty && (
            <div className="sidebar-empty">
              No view selected. Choose a view from the menu above.
            </div>
          )}
          {state.instances
            .filter(
              (entry) =>
                (!entry.definition.location ||
                  entry.definition.location === 'sidebar') &&
                entry.side === side,
            )
            .map((entry) => (
              <AddonViewContent
                key={entry.id}
                entry={entry}
                visible={
                  open &&
                  view?.id === entry.definition.id &&
                  (side === 'right'
                    ? state.activeRightSidebar
                    : state.activeSidebar) === entry.id
                }
              />
            ))}
        </>
      }
    />
  )
}
