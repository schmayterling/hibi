import {
  ArrowLeft,
  ChevronDown,
  Code,
  Columns2,
  FileText,
  PanelLeft,
  PanelRight,
  Pin,
  PinOff,
  SettingsIcon,
} from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { DocumentState } from '../../shared/desktop'
import { type Hotkeys, shortcutLabels } from '../../shared/hotkeys'
import { IconButton } from '../../ui/Controls'
import { useMenus } from '../../ui/MenuHost'
import type { viewShortcut } from './AddonSidebar'
import type { ViewEntry } from './addon-views'
import { DocumentTabs } from './DocumentTabs'
import type { ViewMode } from './Editor'

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
  availableViews,
  onMode,
  hotkeys,
  platform,
  sidebarOpen,
  onSidebar,
  onSettings,
  onBack,
  sidebarOverlay,
  sidebarView,
  sidebarViews,
  onSidebarView,
  rightSidebarOpen,
  rightSidebarView,
  onRightSidebar,
  onRightSidebarView,
  onSelectTab,
  onCloseTab,
  onMoveTab,
  addonTabs,
  activeAddonTab,
  onSelectAddonTab,
  onCloseAddonTab,
  busy,
}: {
  document: DocumentState | null
  settingsOpen: boolean
  mode: ViewMode
  availableViews: readonly ViewMode[]
  onMode: (mode: ViewMode) => void
  hotkeys: Hotkeys
  platform: string
  sidebarOpen: boolean
  onSidebar: () => void
  onSettings: () => void
  onBack: () => void
  sidebarOverlay: boolean
  sidebarView: string
  sidebarViews: ReturnType<typeof viewShortcut>[]
  onSidebarView: (view: string) => void
  rightSidebarOpen: boolean
  rightSidebarView: string
  onRightSidebar: () => void
  onRightSidebarView: (view: string) => void
  onSelectTab: (id: string) => void
  onCloseTab: (id: string) => void
  onMoveTab: (id: string, beforeId: string | null) => void
  addonTabs: ViewEntry[]
  activeAddonTab: string | null
  onSelectAddonTab: (id: string) => void
  onCloseAddonTab: (id: string) => void
  busy: boolean
}) {
  const menus = useMenus(console.error)
  const [pinned, setPinned] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(
        localStorage.getItem('sidebar-pinned-views') ?? '[]',
      )
      return Array.isArray(saved)
        ? [...new Set(saved)]
            .filter((id): id is string => typeof id === 'string')
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
  const availablePins = pinned.filter((id) =>
    sidebarViews.some((view) => view.id === id),
  )
  const currentPinned = availablePins.includes(sidebarView)
  function togglePin() {
    const next = currentPinned
      ? availablePins.filter((id) => id !== sidebarView)
      : [...availablePins, sidebarView].slice(0, 3)
    localStorage.setItem('sidebar-pinned-views', JSON.stringify(next))
    setPinned(next)
  }
  return (
    <header className="titlebar" aria-busy={busy}>
      <div
        className="sidebar-toolbar"
        data-open={sidebarOpen}
        data-settings={settingsOpen}
        inert={!settingsOpen && sidebarOverlay && rightSidebarOpen}
      >
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
                      <view.icon size={16} />
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
                          label: `${currentPinned ? 'Unpin' : 'Pin'} ${currentView?.label ?? 'Workspace'} tab`,
                          icon: currentPinned ? PinOff : Pin,
                          disabled: !currentPinned && availablePins.length >= 3,
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
          </>
        )}
        {settingsOpen && !sidebarOpen && (
          <IconButton
            aria-label="Back to app"
            title="Back to app"
            onClick={onBack}
          >
            <ArrowLeft size={16} />
          </IconButton>
        )}
        <IconButton
          className="sidebar-toggle"
          aria-label={
            settingsOpen
              ? 'Toggle settings sidebar'
              : 'Toggle workspace sidebar'
          }
          aria-pressed={sidebarOpen}
          aria-expanded={sidebarOpen}
          title="Toggle sidebar"
          onClick={onSidebar}
        >
          <PanelLeft size={16} strokeWidth={1.5} />
        </IconButton>
      </div>
      <div
        className="document-toolbar"
        inert={
          sidebarOverlay && (sidebarOpen || (!settingsOpen && rightSidebarOpen))
        }
      >
        <div className="document-title">
          {settingsOpen ? (
            <span>Settings</span>
          ) : document?.tabs.length === 0 && addonTabs.length === 0 ? (
            <span>Hibi</span>
          ) : document?.tabsEnabled === false &&
            document.tabs.length > 0 &&
            addonTabs.length === 0 ? (
            <span
              className="single-document-title"
              data-tooltip={document.name}
              data-verbatim="true"
            >
              <span>{document.name}</span>
              {document.dirty && (
                <span
                  className="dirty-dot"
                  role="status"
                  aria-label="Unsaved changes"
                >
                  •
                </span>
              )}
            </span>
          ) : document ? (
            <DocumentTabs
              document={document}
              busy={busy}
              onSelect={onSelectTab}
              onClose={onCloseTab}
              onMove={onMoveTab}
              addonTabs={addonTabs}
              activeAddonTab={activeAddonTab}
              onSelectAddon={onSelectAddonTab}
              onCloseAddon={onCloseAddonTab}
            />
          ) : (
            <span>Hibi</span>
          )}
        </div>
        {!settingsOpen && !activeAddonTab && (
          <nav className="view-switch" aria-label="Editor view">
            {(['normal', 'side-by-side', 'markdown'] as const).map((view) => {
              const label = view === 'markdown' ? 'Source view' : view
              return (
                <IconButton
                  type="button"
                  key={view}
                  aria-label={label}
                  title={`${label}${hotkeys[view] ? ` (${shortcutLabels(hotkeys[view], platform).join('')})` : ''}`}
                  aria-pressed={mode === view}
                  disabled={!availableViews.includes(view)}
                  onClick={() => onMode(view)}
                >
                  <Icon name={view} />
                </IconButton>
              )
            })}
          </nav>
        )}
        {!settingsOpen && (
          <IconButton
            aria-label="Settings"
            title="Settings"
            onClick={onSettings}
          >
            <SettingsIcon size={16} aria-hidden="true" />
          </IconButton>
        )}
      </div>
      {!settingsOpen && (
        <div
          className="right-sidebar-toolbar"
          data-open={rightSidebarOpen}
          inert={sidebarOverlay && sidebarOpen}
        >
          <IconButton
            className="right-sidebar-toggle"
            aria-label="Toggle right sidebar"
            title="Toggle right sidebar"
            aria-pressed={rightSidebarOpen}
            aria-expanded={rightSidebarOpen}
            onClick={onRightSidebar}
          >
            <PanelRight size={16} strokeWidth={1.5} />
          </IconButton>
          {rightSidebarOpen && (
            <div className="right-sidebar-view-controls">
              <span>
                {sidebarViews.find((view) => view.id === rightSidebarView)
                  ?.label ?? 'No view'}
              </span>
              <IconButton
                aria-label="Right sidebar views"
                title="Right sidebar views"
                aria-haspopup="menu"
                onClick={(event) =>
                  menus.open({
                    label: 'Right sidebar views',
                    anchor: event.currentTarget,
                    items: [
                      {
                        id: 'none',
                        label: 'No view',
                        onSelect: () => onRightSidebarView('none'),
                      },
                      ...sidebarViews
                        .filter((view) => view.id !== 'workspace')
                        .map((view, index) => ({
                          ...view,
                          separatorBefore: index === 0,
                          onSelect: () => onRightSidebarView(view.id),
                        })),
                    ],
                  })
                }
              >
                <ChevronDown size={12} />
              </IconButton>
            </div>
          )}
        </div>
      )}
    </header>
  )
}
