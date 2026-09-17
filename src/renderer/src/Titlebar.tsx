import {
  ChevronDown,
  Code,
  Columns2,
  FileText,
  FolderOpen,
  ListTree,
  PanelLeft,
  Pin,
  PinOff,
} from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { DocumentState } from '../../shared/desktop'
import { isMarkdownDocument } from '../../shared/document-types'
import { type Hotkeys, shortcutLabels } from '../../shared/hotkeys'
import { IconButton } from '../../ui/Controls'
import { useMenus } from '../../ui/MenuHost'
import { DocumentTabs } from './DocumentTabs'
import type { ViewMode } from './Editor'
import type { SidebarView } from './OutlineSidebar'

const sidebarViews = [
  { id: 'workspace', label: 'Workspace', icon: FolderOpen },
  { id: 'outline', label: 'In this page', icon: ListTree },
] as const

const icons = {
  normal: FileText,
  'side-by-side': Columns2,
  markdown: Code,
} as const

function Icon({ name }: { name: keyof typeof icons }) {
  const Glyph = icons[name]
  return <Glyph size={16} strokeWidth={1.5} aria-hidden="true" />
}

export function Titlebar({
  document,
  settingsOpen,
  mode,
  onMode,
  hotkeys,
  platform,
  sidebarOpen,
  onSidebar,
  sidebarView,
  onSidebarView,
  onSelectTab,
  onCloseTab,
  busy,
}: {
  document: DocumentState | null
  settingsOpen: boolean
  mode: ViewMode
  onMode: (mode: ViewMode) => void
  hotkeys: Hotkeys
  platform: string
  sidebarOpen: boolean
  onSidebar: () => void
  sidebarView: SidebarView
  onSidebarView: (view: SidebarView) => void
  onSelectTab: (id: string) => void
  onCloseTab: (id: string) => void
  busy: boolean
}) {
  const menus = useMenus(console.error)
  const [pinned, setPinned] = useState<SidebarView[]>(() => {
    try {
      const saved: unknown = JSON.parse(
        localStorage.getItem('sidebar-pinned-views') ?? '[]',
      )
      return Array.isArray(saved)
        ? [...new Set(saved)]
            .filter((id): id is SidebarView =>
              sidebarViews.some((view) => view.id === id),
            )
            .slice(0, 3)
        : []
    } catch {
      return []
    }
  })
  const shortcuts = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(0)
  useLayoutEffect(() => {
    const element = shortcuts.current
    if (settingsOpen || !sidebarOpen || !element) return
    const measure = () => {
      const style = getComputedStyle(element)
      const size = Number.parseFloat(
        style.getPropertyValue('--sidebar-action-size'),
      )
      const gap = Number.parseFloat(style.columnGap)
      setVisibleCount(
        Math.max(0, Math.floor((element.clientWidth + gap) / (size + gap))),
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [settingsOpen, sidebarOpen])
  const orderedViews = [
    ...pinned.flatMap((id) => sidebarViews.filter((view) => view.id === id)),
    ...sidebarViews.filter((view) => !pinned.includes(view.id)),
  ]
  const currentView =
    sidebarViews.find((view) => view.id === sidebarView) ?? sidebarViews[0]
  const currentPinned = pinned.includes(sidebarView)
  function togglePin() {
    const next = currentPinned
      ? pinned.filter((id) => id !== sidebarView)
      : [...pinned, sidebarView].slice(0, 3)
    localStorage.setItem('sidebar-pinned-views', JSON.stringify(next))
    setPinned(next)
  }
  return (
    <header className="titlebar" aria-busy={busy}>
      <div className="sidebar-toolbar" data-open={sidebarOpen || settingsOpen}>
        {!settingsOpen && (
          <>
            {sidebarOpen && (
              <div className="sidebar-view-controls">
                <div ref={shortcuts} className="sidebar-view-shortcuts">
                  {orderedViews.slice(0, visibleCount).map((view) => (
                    <IconButton
                      key={view.id}
                      aria-label={`${view.label} view`}
                      title={view.label}
                      aria-pressed={sidebarOpen && sidebarView === view.id}
                      onClick={() => onSidebarView(view.id)}
                    >
                      <view.icon size={16} strokeWidth={1.5} />
                    </IconButton>
                  ))}
                </div>
                <IconButton
                  className="sidebar-view-menu"
                  aria-label="Sidebar views"
                  aria-haspopup="menu"
                  title="Sidebar views"
                  onClick={(event) =>
                    menus.open({
                      label: 'Sidebar views',
                      anchor: event.currentTarget,
                      items: [
                        {
                          id: 'pin-current-view',
                          label: `${currentPinned ? 'Unpin' : 'Pin'} ${currentView.label}`,
                          icon: currentPinned ? PinOff : Pin,
                          disabled: !currentPinned && pinned.length >= 3,
                          onSelect: togglePin,
                        },
                        ...orderedViews.map((view, index) => ({
                          ...view,
                          separatorBefore: index === 0,
                          onSelect: () => onSidebarView(view.id),
                        })),
                      ],
                    })
                  }
                >
                  <ChevronDown size={12} />
                </IconButton>
              </div>
            )}
            <IconButton
              className="sidebar-toggle"
              aria-label="Toggle workspace sidebar"
              aria-pressed={sidebarOpen}
              title="Toggle sidebar"
              onClick={onSidebar}
            >
              <PanelLeft size={16} strokeWidth={1.5} />
            </IconButton>
          </>
        )}
      </div>
      <div className="document-toolbar">
        <div className="document-title">
          {settingsOpen ? (
            <span>Settings</span>
          ) : document ? (
            <DocumentTabs
              document={document}
              busy={busy}
              onSelect={onSelectTab}
              onClose={onCloseTab}
            />
          ) : (
            <span>Hibi</span>
          )}
        </div>
        {!settingsOpen && (
          <nav className="view-switch" aria-label="Editor view">
            {(['normal', 'side-by-side', 'markdown'] as const).map((view) => {
              const label =
                view === 'markdown'
                  ? document && !isMarkdownDocument(document.name)
                    ? 'Source only'
                    : 'Markdown only'
                  : view
              return (
                <IconButton
                  type="button"
                  key={view}
                  aria-label={label}
                  title={`${label}${hotkeys[view] ? ` (${shortcutLabels(hotkeys[view], platform).join('')})` : ''}`}
                  aria-pressed={mode === view}
                  onClick={() => onMode(view)}
                >
                  <Icon name={view} />
                </IconButton>
              )
            })}
          </nav>
        )}
      </div>
    </header>
  )
}
