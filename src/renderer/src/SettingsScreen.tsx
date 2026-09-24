import { ArrowLeft, CircleX, ExternalLink, Search } from 'lucide-react'
import {
  Component,
  type ReactNode,
  Suspense,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { AddonState } from '../../addons/api'
import type { AppInfo } from '../../shared/desktop'
import { type DocumentView, isDocumentView } from '../../shared/document-types'
import { actions, type Hotkeys } from '../../shared/hotkeys'
import { ColorschemeSettings } from '../../ui/ColorschemeSettings'
import {
  Button,
  IconButton,
  Panel,
  PanelMessage,
  Select,
  SettingRow,
  Slider,
  TextInput,
  Toggle,
} from '../../ui/Controls'
import { DocumentNotice } from '../../ui/DocumentNotice'
import { Sidebar, type SidebarItem, type SidebarProps } from '../../ui/Sidebar'
import { SettingsDiscovery, settingsIndex } from '../../ui/settings-index'
import { uiCase } from '../../ui/ui-case'
import { AddonMetadata, AddonSettings, useAddonReadme } from './AddonSettings'
import { AutosaveSettings } from './AutosaveSettings'
import { addons } from './addons'
import { CodeSyntaxSettings } from './CodeSyntaxSettings'
import { colorschemes } from './colorschemes'
import { DependencySettings } from './DependencySettings'
import type { CursorSettings } from './EditorCursor'
import { ToolbarSettings } from './EditorToolbar'
import { FormatsSettings } from './FormatsSettings'
import { HibiSettings } from './HibiSettings'
import { HotkeySettings } from './HotkeySettings'
import { LicenseSettings } from './LicenseSettings'
import { ModalEditingSettings } from './ModalEditingSettings'
import { NotificationSettings } from './NotificationSettings'
import type { StatusBarVisibility } from './StatusBar'
import { SyntaxSettings } from './SyntaxSettings'
import {
  settingsCategories,
  settingsIcon,
  settingsNavigation,
} from './settings-categories'
import { settingsCategory, settingsPages } from './settings-pages'
import { WorkspaceSettings } from './WorkspaceSettings'

class PluginSettingsBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <DocumentNotice
        title="Settings unavailable"
        message="Could not load this addon’s settings. Try again."
      >
        <button type="button" onClick={() => this.setState({ failed: false })}>
          Retry
        </button>
      </DocumentNotice>
    ) : (
      this.props.children
    )
  }
}

export function SettingsScreen({
  statusBar,
  onStatusBar,
  zen,
  onZen,
  discover,
  selected,
  onCategory,
  onSetting,
  onBack,
  open,
  sidebarOpen,
  overlay,
  onSidebarClose,
  padding,
  onPadding,
  hideTitlebar,
  onHideTitlebar,
  info,
  hotkeys,
  onHotkeys,
  addonStates,
  onAddonEnabled,
  onInstallAddon,
  onRemoveAddon,
  resize,
  cursorSettings,
  onCursorSettings,
  showLineNumbers,
  onShowLineNumbers,
  spellCheck,
  onSpellCheck,
  showMarkdownMarkers,
  onShowMarkdownMarkers,
  focusOutlines,
  onFocusOutlines,
  defaultView,
  onDefaultView,
  tabsEnabled,
  tabsBusy,
  onTabsEnabled,
  onWorkspaceChanged,
}: {
  statusBar: StatusBarVisibility
  onStatusBar: (visibility: StatusBarVisibility) => void
  zen: boolean
  onZen: (enabled: boolean) => void
  discover: boolean
  selected: string
  onCategory: (category: string) => void
  onWorkspaceChanged: () => Promise<void>
  onSetting: (category: string, id: string) => void
  onBack: () => void
  open: boolean
  sidebarOpen: boolean
  overlay: boolean
  onSidebarClose: () => void
  padding: number
  onPadding: (padding: number) => void
  hideTitlebar: boolean
  onHideTitlebar: (hide: boolean) => void
  info: AppInfo | null
  hotkeys: Hotkeys
  onHotkeys: (hotkeys: Hotkeys) => void
  addonStates: AddonState[]
  onAddonEnabled: (id: string, enabled: boolean) => Promise<void>
  onInstallAddon: (url?: string) => Promise<void>
  onRemoveAddon: (id: string) => Promise<void>
  resize: NonNullable<SidebarProps['resize']>
  cursorSettings: CursorSettings
  onCursorSettings: (settings: CursorSettings) => void
  showLineNumbers: boolean
  onShowLineNumbers: (show: boolean) => void
  spellCheck: boolean
  onSpellCheck: (enabled: boolean) => void
  showMarkdownMarkers: boolean
  onShowMarkdownMarkers: (enabled: boolean) => void
  focusOutlines: boolean
  onFocusOutlines: (enabled: boolean) => void
  defaultView: DocumentView
  onDefaultView: (view: DocumentView) => void
  tabsEnabled: boolean
  tabsBusy: boolean
  onTabsEnabled: (enabled: boolean) => void
}) {
  const screen = useRef<HTMLElement>(null)
  const openReadme = useAddonReadme()
  const wasOpen = useRef(false)
  const search = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [searchSelection, setSearchSelection] = useState<string | null>(null)
  const indexed = useSyncExternalStore(
    settingsIndex.subscribe,
    settingsIndex.snapshot,
  )
  const registered = useSyncExternalStore(
    settingsPages.subscribe,
    settingsPages.snapshot,
  )
  const extraPages = registered.pages.filter((page) =>
    addonStates.some((state) => state.id === page.owner && state.enabled),
  )
  const searchable = [
    ...indexed,
    ...actions.map(({ id, label, category }) => ({
      id: `hotkey-${id}`,
      label,
      category: 'hotkeys',
      keywords: category,
    })),
  ]
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const searching = terms.length > 0
  useLayoutEffect(() => {
    const opening = open && !wasOpen.current
    wasOpen.current = open
    if (!opening) return
    const target = sidebarOpen
      ? (screen.current?.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"]',
        ) ?? search.current)
      : screen.current?.querySelector<HTMLElement>('.settings-content')
    target?.focus({ preventScroll: true })
  }, [open, sidebarOpen])
  const casing = useSyncExternalStore(uiCase.subscribe, uiCase.snapshot)
  const pluginPages = addons.filter(
    (addon) =>
      (!!addon.manifest.fileExtensions?.length || addon.Settings) &&
      addonStates.some(
        (state) => state.id === addon.manifest.id && state.enabled,
      ),
  )
  const items: SidebarItem[] = settingsNavigation(
    [
      ...settingsCategories,
      ...pluginPages.map(({ manifest }) => ({
        id: `plugin-${manifest.id}`,
        label: manifest.name,
        icon: settingsIcon(
          manifest.settings?.icon ??
            (manifest.fileExtensions?.length ? 'file-text' : 'puzzle'),
        ),
        category: settingsCategory(
          manifest.id,
          manifest.settings?.category ?? 'addons',
        ),
      })),
      ...extraPages.map((page) => ({
        ...page,
        icon: page.icon ?? settingsIcon(),
      })),
    ],
    registered.categories,
  )
  const category = items.some((item) => item.id === selected)
    ? selected
    : selected.startsWith('plugin-') || selected.startsWith('addon-')
      ? 'addons'
      : 'workspace'
  const matches = (text: string) =>
    terms.every((term) => text.toLocaleLowerCase().includes(term))
  const results = searching
    ? items.flatMap(({ section: _section, divider: _divider, ...item }) => {
        const children = searchable
          .filter(
            (setting) =>
              setting.category === item.id &&
              matches(`${item.label} ${setting.label} ${setting.keywords}`),
          )
          .map((setting) => ({
            id: `setting:${setting.category}:${setting.id}`,
            label: setting.label,
          }))
        return matches(item.label) || children.length
          ? [{ ...item, ...(children.length ? { children } : {}) }]
          : []
      })
    : []
  const selectResult = (id: string) => {
    setSearchSelection(id)
    const setting = searchable.find(
      (setting) => `setting:${setting.category}:${setting.id}` === id,
    )
    if (setting) onSetting(setting.category, setting.id)
    else onCategory(id)
  }
  const selectCategory = (id: string) => {
    if (searching) selectResult(id)
    else onCategory(id)
    if (overlay) {
      onSidebarClose()
      if (!id.startsWith('setting:'))
        requestAnimationFrame(() =>
          screen.current
            ?.querySelector<HTMLElement>('.settings-content')
            ?.focus({ preventScroll: true }),
        )
    }
  }

  return (
    <SettingsDiscovery value={true}>
      <main
        ref={screen}
        className="settings-screen"
        data-sidebar={sidebarOpen}
        data-sidebar-overlay={overlay}
        aria-label="Settings"
        hidden={!open}
        inert={!open}
      >
        <Sidebar
          resize={{ ...resize, onCollapse: onSidebarClose }}
          open={sidebarOpen}
          overlay={overlay}
          onDismiss={onSidebarClose}
          className={`settings-sidebar${searching ? ' settings-searching' : ''}`}
          fadeEdges
          items={searching ? results : items}
          selected={searching ? (searchSelection ?? category) : category}
          onSelect={selectCategory}
          label={searching ? 'Settings search results' : 'Settings categories'}
          mode={searching ? 'tree' : 'tabs'}
          collapsible={false}
          empty={
            <Panel className="settings-search-empty">
              <PanelMessage
                icon={<Search size={32} strokeWidth={1.5} />}
                title="No matching settings"
              />
            </Panel>
          }
          idPrefix="category"
          panelPrefix="settings-"
          header={
            <>
              <div className="sidebar-items">
                <button type="button" onClick={onBack}>
                  <ArrowLeft size={16} aria-hidden />
                  <span className="sidebar-label">Back to app</span>
                </button>
              </div>
              <search className="settings-search" aria-label="Settings">
                <Search size={16} aria-hidden />
                <TextInput
                  ref={search}
                  aria-label="Search settings"
                  placeholder="Search settings…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && query) {
                      event.preventDefault()
                      event.stopPropagation()
                      setQuery('')
                    } else if (event.key === 'ArrowDown' && searching) {
                      event.preventDefault()
                      screen.current
                        ?.querySelector<HTMLElement>('[role="treeitem"]')
                        ?.focus()
                    }
                  }}
                />
                {query && (
                  <IconButton
                    aria-label="Clear settings search"
                    onClick={() => {
                      setQuery('')
                      search.current?.focus()
                    }}
                  >
                    <CircleX size={16} aria-hidden />
                  </IconButton>
                )}
              </search>
            </>
          }
          afterItems={
            !searching &&
            info && (
              <div className="settings-versions">
                <span>Hibi {info.version}</span>
                <span>Electron {info.electron}</span>
              </div>
            )
          }
        />
        <div
          className="settings-content"
          tabIndex={-1}
          inert={overlay && sidebarOpen}
        >
          <section
            id="settings-hibi"
            role="tabpanel"
            aria-labelledby="category-hibi"
            aria-label="About"
            hidden={category !== 'hibi'}
          >
            {(discover || (open && (category === 'hibi' || searching))) && (
              <HibiSettings info={info} />
            )}
          </section>
          <section
            id="settings-licenses"
            role="tabpanel"
            aria-labelledby="category-licenses"
            aria-label="Credits"
            hidden={category !== 'licenses'}
          >
            {(discover || (open && category === 'licenses')) && (
              <LicenseSettings />
            )}
          </section>
          <section
            id="settings-editor"
            role="tabpanel"
            aria-labelledby="category-editor"
            aria-label="Editor"
            hidden={category !== 'editor'}
          >
            <h1>Editor</h1>
            <h2>Documents</h2>
            <div className="settings-group">
              <SettingRow
                id="document-tabs"
                label="Use tabs"
                description="Turn off to open one file at a time."
              >
                <Toggle
                  id="document-tabs"
                  aria-describedby="document-tabs-description"
                  checked={tabsEnabled}
                  aria-disabled={tabsBusy}
                  onChange={(event) => {
                    if (!tabsBusy) onTabsEnabled(event.target.checked)
                  }}
                />
              </SettingRow>
            </div>
            <h2>Writing</h2>
            <div className="settings-group">
              <SettingRow
                id="spell-check"
                label="Spell check"
                description="Check spelling in formatted text."
              >
                <Toggle
                  id="spell-check"
                  aria-describedby="spell-check-description"
                  checked={spellCheck}
                  onChange={(event) => onSpellCheck(event.target.checked)}
                />
              </SettingRow>
              <SettingRow
                id="markdown-markers"
                label="Show Markdown markers"
                description="Show formatting hints in the active block while editing formatted text."
              >
                <Toggle
                  id="markdown-markers"
                  aria-describedby="markdown-markers-description"
                  checked={showMarkdownMarkers}
                  onChange={(event) =>
                    onShowMarkdownMarkers(event.target.checked)
                  }
                />
              </SettingRow>
            </div>
            <AutosaveSettings />
            <h2>Layout</h2>
            <div className="settings-group">
              <SettingRow id="default-view" label="Default view">
                <Select
                  id="default-view"
                  value={defaultView}
                  onChange={(event) => {
                    const view = event.target.value
                    if (isDocumentView(view)) onDefaultView(view)
                  }}
                >
                  <option value="normal">Normal</option>
                  <option value="side-by-side">Side-by-side</option>
                  <option value="markdown">Source view</option>
                </Select>
              </SettingRow>
              <SettingRow id="editor-padding" label="Content padding">
                <div className="setting-controls">
                  <div className="padding-control">
                    <Slider
                      id="editor-padding"
                      min="0"
                      max="96"
                      step="4"
                      value={padding}
                      onChange={(event) =>
                        onPadding(Number(event.target.value))
                      }
                    />
                    <output htmlFor="editor-padding">{padding} px</output>
                  </div>
                  <Button type="button" onClick={() => onPadding(48)}>
                    Reset to 48 px
                  </Button>
                </div>
              </SettingRow>
              <SettingRow id="line-numbers" label="Show line numbers">
                <Toggle
                  id="line-numbers"
                  checked={showLineNumbers}
                  onChange={(event) => onShowLineNumbers(event.target.checked)}
                />
              </SettingRow>
            </div>
            {(discover || (open && (category === 'editor' || searching))) && (
              <ModalEditingSettings
                manifests={addons.map(({ manifest }) => manifest)}
                states={addonStates}
                openAddons={() => onCategory('addons')}
              />
            )}
          </section>
          <section
            id="settings-syntax"
            role="tabpanel"
            aria-labelledby="category-syntax"
            aria-label="Syntax"
            hidden={category !== 'syntax'}
          >
            <SyntaxSettings />
          </section>
          <section
            id="settings-code-syntax"
            role="tabpanel"
            aria-labelledby="category-code-syntax"
            aria-label="Code Highlight"
            hidden={category !== 'code-syntax'}
          >
            <CodeSyntaxSettings />
          </section>
          <section
            id="settings-appearance"
            role="tabpanel"
            aria-labelledby="category-appearance"
            aria-label="Appearance"
            hidden={category !== 'appearance'}
          >
            <h1>Appearance</h1>
            <h2>Interface text</h2>
            <div className="settings-group">
              <SettingRow id="lowercase-interface" label="Lowercase interface">
                <Toggle
                  id="lowercase-interface"
                  checked={casing === 'lowercase'}
                  onChange={(event) =>
                    uiCase.set(event.target.checked ? 'lowercase' : 'sentence')
                  }
                />
              </SettingRow>
            </div>
            <h2>Focus</h2>
            <div className="settings-group">
              <SettingRow
                id="focus-outlines"
                label="Focus outlines"
                description="Show a border around focused buttons, links, and navigation."
              >
                <Toggle
                  id="focus-outlines"
                  checked={focusOutlines}
                  onChange={(event) => onFocusOutlines(event.target.checked)}
                />
              </SettingRow>
            </div>
            <h2>Colors</h2>
            <ColorschemeSettings store={colorschemes} showLicense={false} />
            <h2>Cursor</h2>
            <div className="settings-group">
              {(
                [
                  [
                    'style',
                    'Cursor style',
                    'Choose the cursor shape.',
                    [
                      ['bar', 'Line |'],
                      ['outline', 'Outline ▯'],
                      ['block', 'Filled ▮'],
                      ['underline', 'Underline _'],
                    ],
                  ],
                  [
                    'speed',
                    'Cursor blink',
                    'Choose how quickly the cursor blinks.',
                    [
                      ['fast', 'Fast'],
                      ['normal', 'Normal'],
                      ['slow', 'Slow'],
                    ],
                  ],
                  [
                    'animation',
                    'Cursor animation',
                    'Smooth fades and slides between positions. Blink moves instantly.',
                    [
                      ['smooth', 'Smooth'],
                      ['blink', 'Blink'],
                    ],
                  ],
                ] as const
              ).map(([key, label, description, options]) => (
                <SettingRow
                  key={key}
                  id={`cursor-${key}`}
                  label={label}
                  description={description}
                >
                  <Select
                    id={`cursor-${key}`}
                    aria-describedby={`cursor-${key}-description`}
                    value={cursorSettings[key]}
                    onChange={(event) =>
                      onCursorSettings({
                        ...cursorSettings,
                        [key]: event.target.value,
                      })
                    }
                  >
                    {options.map(([value, text]) => (
                      <option key={value} value={value}>
                        {text}
                      </option>
                    ))}
                  </Select>
                </SettingRow>
              ))}
            </div>
            <h2>Window</h2>
            <div className="settings-group">
              <SettingRow id="status-bar" label="Status bar">
                <Select
                  id="status-bar"
                  value={statusBar}
                  onChange={(event) =>
                    onStatusBar(event.target.value as StatusBarVisibility)
                  }
                >
                  <option value="shown">Show</option>
                  <option value="auto">Auto-hide</option>
                  <option value="hidden">Hide</option>
                </Select>
              </SettingRow>
              <SettingRow
                id="zen-mode"
                label="Zen mode"
                description="Hide navigation, toolbars, and status while writing."
              >
                <Toggle
                  id="zen-mode"
                  checked={zen}
                  onChange={(event) => onZen(event.target.checked)}
                />
              </SettingRow>
              <SettingRow
                id="hide-titlebar"
                label="Hide top bar while typing"
                description="The bar returns when you pause or move your pointer to the top."
              >
                <Toggle
                  id="hide-titlebar"
                  aria-describedby="hide-titlebar-description"
                  checked={hideTitlebar}
                  onChange={(event) => onHideTitlebar(event.target.checked)}
                />
              </SettingRow>
            </div>
            <ToolbarSettings />
            <NotificationSettings />
          </section>
          <section
            id="settings-hotkeys"
            role="tabpanel"
            aria-labelledby="category-hotkeys"
            aria-label="Hotkeys"
            hidden={category !== 'hotkeys'}
          >
            {category === 'hotkeys' && (
              <HotkeySettings
                active={open}
                hotkeys={hotkeys}
                onChange={onHotkeys}
                platform={info?.platform ?? 'darwin'}
              />
            )}
          </section>
          <section
            id="settings-addons"
            role="tabpanel"
            aria-labelledby="category-addons"
            aria-label="Addon Manager"
            hidden={category !== 'addons'}
          >
            <AddonSettings
              addons={addons}
              states={addonStates}
              setEnabled={onAddonEnabled}
              install={onInstallAddon}
              remove={onRemoveAddon}
            />
          </section>
          <section
            id="settings-dependencies"
            role="tabpanel"
            aria-labelledby="category-dependencies"
            aria-label="Dependencies"
            hidden={category !== 'dependencies'}
          >
            <DependencySettings
              active={open && category === 'dependencies'}
              states={addonStates}
              openAddon={(id) =>
                onCategory(
                  items.some((item) => item.id === `plugin-${id}`)
                    ? `plugin-${id}`
                    : 'addons',
                )
              }
            />
          </section>
          <section
            id="settings-formats"
            role="tabpanel"
            aria-labelledby="category-formats"
            aria-label="Formats"
            hidden={category !== 'formats'}
          >
            <FormatsSettings
              active={open && category === 'formats'}
              addons={addons}
              states={addonStates}
              setEnabled={onAddonEnabled}
              open={onCategory}
            />
          </section>
          <section
            id="settings-workspace"
            role="tabpanel"
            aria-labelledby="category-workspace"
            aria-label="Workspace settings"
            hidden={category !== 'workspace'}
          >
            <WorkspaceSettings
              active={open && category === 'workspace'}
              onChanged={onWorkspaceChanged}
            />
          </section>
          {extraPages.map(({ id, label, Content }) => (
            <section
              key={id}
              id={`settings-${id}`}
              role="tabpanel"
              aria-labelledby={`category-${id}`}
              aria-label={label}
              hidden={category !== id}
            >
              <h1>{label}</h1>
              {(discover || (open && (searching || category === id))) && (
                <PluginSettingsBoundary key={id}>
                  <Suspense
                    fallback={<DocumentNotice title="Loading settings…" busy />}
                  >
                    <Content />
                  </Suspense>
                </PluginSettingsBoundary>
              )}
            </section>
          ))}
          {pluginPages.map(({ manifest, Settings }) => (
            <section
              key={manifest.id}
              id={`settings-plugin-${manifest.id}`}
              role="tabpanel"
              aria-labelledby={`category-plugin-${manifest.id}`}
              aria-label={manifest.name}
              hidden={category !== `plugin-${manifest.id}`}
            >
              <h1>
                <button
                  type="button"
                  className="plugin-readme-title"
                  aria-label={`${manifest.name} readme`}
                  aria-haspopup="dialog"
                  onClick={() => openReadme(manifest)}
                >
                  <span>{manifest.name}</span>
                  <ExternalLink size={16} aria-hidden />
                </button>
              </h1>
              <div className="plugin-summary">
                <p className="plugin-description">{manifest.description}</p>
                <AddonMetadata manifest={manifest} />
              </div>
              {!!manifest.fileExtensions?.length && (
                <>
                  <h2>Format</h2>
                  <div className="settings-group">
                    <SettingRow
                      id={`plugin-format-${manifest.id}`}
                      label="Enable format"
                      description={manifest.fileExtensions
                        .map((extension) => `.${extension}`)
                        .join(' · ')}
                    >
                      {manifest.id === 'markdown' ? (
                        <Toggle
                          id={`plugin-format-${manifest.id}`}
                          checked
                          disabled
                        />
                      ) : (
                        <Toggle
                          id={`plugin-format-${manifest.id}`}
                          checked={addonStates.some(
                            (state) =>
                              state.id === manifest.id && state.enabled,
                          )}
                          onChange={(event) =>
                            void onAddonEnabled(
                              manifest.id,
                              event.target.checked,
                            )
                          }
                        />
                      )}
                    </SettingRow>
                    <SettingRow
                      id={`plugin-controls-${manifest.id}`}
                      label="Rendering and highlighting"
                      description="Choose syntax features and code highlighting."
                    >
                      <Button onClick={() => onCategory('syntax')}>
                        Syntax
                      </Button>
                      <Button onClick={() => onCategory('code-syntax')}>
                        Code highlighting
                      </Button>
                    </SettingRow>
                  </div>
                </>
              )}
              {Settings &&
                (discover ||
                  (open &&
                    (searching || category === `plugin-${manifest.id}`))) && (
                  <PluginSettingsBoundary key={manifest.id}>
                    <Suspense
                      fallback={
                        <DocumentNotice title="Loading settings…" busy />
                      }
                    >
                      <Settings />
                    </Suspense>
                  </PluginSettingsBoundary>
                )}
            </section>
          ))}
        </div>
      </main>
    </SettingsDiscovery>
  )
}
