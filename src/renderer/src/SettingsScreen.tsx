import {
  ArrowLeft,
  Code,
  File,
  FileText,
  Keyboard,
  PanelTop,
  Puzzle,
  TextCursorInput,
} from 'lucide-react'
import { Component, type ReactNode, useSyncExternalStore } from 'react'
import type { AddonState } from '../../addons/api'
import type { AppInfo } from '../../shared/desktop'
import type { Hotkeys } from '../../shared/hotkeys'
import { ColorschemeSettings } from '../../ui/ColorschemeSettings'
import { Button, Select, SettingRow, Slider, Toggle } from '../../ui/Controls'
import { Sidebar, type SidebarProps } from '../../ui/Sidebar'
import { SettingsDiscovery } from '../../ui/settings-index'
import { uiCase } from '../../ui/ui-case'
import { AddonMetadata, AddonSettings } from './AddonSettings'
import { AutosaveSettings } from './AutosaveSettings'
import { addons } from './addons'
import { CodeSyntaxSettings } from './CodeSyntaxSettings'
import { colorschemes } from './colorschemes'
import type { CursorSettings } from './EditorCursor'
import { ToolbarSettings } from './EditorToolbar'
import { HibiSettings } from './HibiSettings'
import { HotkeySettings } from './HotkeySettings'
import { NotificationSettings } from './NotificationSettings'
import { SyntaxSettings } from './SyntaxSettings'

export const settingsCategories = [
  { id: 'hibi', label: 'Hibi', icon: File },
  { id: 'editor', label: 'Editor', icon: FileText },
  { id: 'syntax', label: 'Syntax', icon: TextCursorInput },
  { id: 'code-syntax', label: 'Code highlighting', icon: Code },
  { id: 'appearance', label: 'Appearance', icon: PanelTop },
  { id: 'hotkeys', label: 'Hotkeys', icon: Keyboard },
  { id: 'addons', label: 'Addons', icon: Puzzle },
] as const

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
      <p role="alert">
        These plugin settings could not load.{' '}
        <button type="button" onClick={() => this.setState({ failed: false })}>
          Retry
        </button>
      </p>
    ) : (
      this.props.children
    )
  }
}

export function SettingsScreen({
  selected,
  onCategory,
  onBack,
  open,
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
}: {
  selected: string
  onCategory: (category: string) => void
  onBack: () => void
  open: boolean
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
}) {
  const casing = useSyncExternalStore(uiCase.subscribe, uiCase.snapshot)
  const pluginPages = addons.filter(
    (addon) =>
      addon.Settings &&
      addonStates.some(
        (state) => state.id === addon.manifest.id && state.enabled,
      ),
  )
  const items = [
    ...settingsCategories,
    ...pluginPages.map(({ manifest }, index) => ({
      id: `plugin-${manifest.id}`,
      label: manifest.name,
      icon: Puzzle,
      ...(index === 0 ? { section: 'plugins' } : {}),
    })),
  ]
  const category = items.some((item) => item.id === selected)
    ? selected
    : 'hibi'

  return (
    <SettingsDiscovery value={true}>
      <main
        className="settings-screen"
        aria-label="Settings"
        hidden={!open}
        inert={!open}
      >
        <Sidebar
          resize={resize}
          className="settings-sidebar"
          items={items}
          selected={category}
          onSelect={onCategory}
          label="Settings categories"
          mode="tabs"
          idPrefix="category"
          panelPrefix="settings-"
          header={
            <div className="sidebar-items">
              <button type="button" onClick={onBack}>
                <ArrowLeft size={16} aria-hidden />
                <span className="sidebar-label">Back to app</span>
              </button>
            </div>
          }
          footer={
            info && (
              <div className="settings-versions">
                <span>Hibi {info.version}</span>
                <span>Electron {info.electron}</span>
              </div>
            )
          }
        />
        <div className="settings-content">
          <section
            id="settings-hibi"
            role="tabpanel"
            aria-labelledby="category-hibi"
            hidden={category !== 'hibi'}
          >
            {open && category === 'hibi' && <HibiSettings info={info} />}
          </section>
          <section
            id="settings-editor"
            role="tabpanel"
            aria-labelledby="category-editor"
            hidden={category !== 'editor'}
          >
            <h1>Editor</h1>
            <AutosaveSettings />
            <h2>Layout</h2>
            <div className="settings-group">
              <SettingRow
                id="editor-padding"
                label="Content padding"
                description="Space around your document in every view."
              >
                <div className="setting-controls">
                  <div className="padding-control">
                    <Slider
                      id="editor-padding"
                      aria-describedby="editor-padding-description"
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
              <SettingRow
                id="line-numbers"
                label="Show line numbers"
                description="Number each line in Markdown and side-by-side views."
              >
                <Toggle
                  id="line-numbers"
                  aria-describedby="line-numbers-description"
                  checked={showLineNumbers}
                  onChange={(event) => onShowLineNumbers(event.target.checked)}
                />
              </SettingRow>
            </div>
          </section>
          <section
            id="settings-syntax"
            role="tabpanel"
            aria-labelledby="category-syntax"
            hidden={category !== 'syntax'}
          >
            <SyntaxSettings />
          </section>
          <section
            id="settings-code-syntax"
            role="tabpanel"
            aria-labelledby="category-code-syntax"
            hidden={category !== 'code-syntax'}
          >
            <CodeSyntaxSettings />
          </section>
          <section
            id="settings-appearance"
            role="tabpanel"
            aria-labelledby="category-appearance"
            hidden={category !== 'appearance'}
          >
            <h1>Appearance</h1>
            <h2>Interface text</h2>
            <div className="settings-group">
              <SettingRow
                id="lowercase-interface"
                label="Lowercase interface"
                description="Display interface text in lowercase. Your documents and typed values keep their original spelling."
              >
                <Toggle
                  id="lowercase-interface"
                  checked={casing === 'lowercase'}
                  onChange={(event) =>
                    uiCase.set(event.target.checked ? 'lowercase' : 'sentence')
                  }
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
                    'cursor style',
                    'shape of the text insertion cursor.',
                    [
                      ['bar', 'line |'],
                      ['outline', 'outline ▯'],
                      ['block', 'filled ▮'],
                      ['underline', 'underline _'],
                    ],
                  ],
                  [
                    'speed',
                    'cursor blink',
                    'how quickly the cursor blinks.',
                    [
                      ['fast', 'fast'],
                      ['normal', 'normal'],
                      ['slow', 'slow'],
                    ],
                  ],
                  [
                    'animation',
                    'cursor animation',
                    'smooth fades and slides; blink moves instantly.',
                    [
                      ['smooth', 'smooth'],
                      ['blink', 'blink'],
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
              <SettingRow
                id="hide-titlebar"
                label="Hide top bar while typing"
                description="Show it after a pause, or move your pointer to the top."
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
          {pluginPages.map(({ manifest, Settings }) => (
            <section
              key={manifest.id}
              id={`settings-plugin-${manifest.id}`}
              role="tabpanel"
              aria-labelledby={`category-plugin-${manifest.id}`}
              hidden={category !== `plugin-${manifest.id}`}
            >
              <h1>{manifest.name}</h1>
              <p className="plugin-description">
                {manifest.description}
                <AddonMetadata manifest={manifest} />
              </p>
              {Settings && (
                <PluginSettingsBoundary key={manifest.id}>
                  <Settings />
                </PluginSettingsBoundary>
              )}
            </section>
          ))}
        </div>
      </main>
    </SettingsDiscovery>
  )
}
