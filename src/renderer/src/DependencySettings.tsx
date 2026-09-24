import {
  ChevronDown,
  ExternalLink,
  Package,
  RefreshCw,
  Search,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AddonState } from '../../addons/api'
import {
  type DependencyState,
  dependencyChangedEvent,
} from '../../shared/dependencies'
import type { DesktopApi } from '../../shared/desktop'
import { errorMessage } from '../../shared/errors'
import {
  Button,
  IconButton,
  Panel,
  PanelMessage,
  TextInput,
} from '../../ui/Controls'
import { useDialogs } from '../../ui/DialogProvider'
import { DocumentNotice } from '../../ui/DocumentNotice'
import { SettingsFilter } from '../../ui/SettingsFilter'
import './dependencies.css'

function DependencyPath({
  tool,
  disabled,
  configure,
}: {
  tool: DependencyState
  disabled: boolean
  configure: (
    action: Parameters<DesktopApi['configureDependency']>[1],
  ) => Promise<DependencyState>
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const id = `dependency-path-${tool.key}`
  const apply = async (
    action: Parameters<DesktopApi['configureDependency']>[1],
  ) => {
    if (disabled || pending.current) return
    pending.current = true
    setError('')
    try {
      await configure(action)
      setDraft(null)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      pending.current = false
    }
  }
  const commit = () => {
    if (draft === (tool.path ?? '')) setDraft(null)
    else if (draft !== null) void apply(draft ? { path: draft } : 'reset')
  }
  const invalid =
    !!error ||
    tool.status === 'error' ||
    (tool.customPath && tool.status === 'missing')
  const message =
    error ||
    tool.message ||
    (tool.status === 'available'
      ? tool.version
        ? `Executable available · ${tool.version}`
        : 'Executable available.'
      : tool.status === 'installing'
        ? 'Installing…'
        : tool.customPath
          ? 'No executable found at this path.'
          : 'No executable found. Enter a path or choose a file.')
  return (
    <div className="dependency-path">
      <div className="dependency-path-heading">
        <label htmlFor={id}>Path</label>
        {tool.customPath && (
          <button
            type="button"
            className="dependency-addon-link"
            data-path-action
            disabled={disabled}
            onClick={() => void apply('reset')}
          >
            Use PATH
          </button>
        )}
      </div>
      <div className="dependency-path-row">
        <TextInput
          id={id}
          aria-label={`${tool.name} executable path`}
          aria-describedby={`${id}-status`}
          aria-invalid={invalid}
          data-verbatim="true"
          spellCheck={false}
          placeholder="Absolute path to executable"
          value={draft ?? tool.path ?? ''}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value)
            setError('')
          }}
          onBlur={(event) => {
            if (
              !(
                event.relatedTarget instanceof Element &&
                event.relatedTarget.closest('[data-path-action]')
              )
            )
              commit()
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setDraft(null)
              setError('')
            }
          }}
        />
        <Button
          disabled={disabled}
          data-path-action
          onClick={() => void apply('choose')}
        >
          Choose executable…
        </Button>
      </div>
      <p
        id={`${id}-status`}
        role="status"
        data-verbatim="true"
        data-error={invalid}
      >
        {draft !== null && !error
          ? 'Press Enter or leave the field to apply. Clear it to use PATH.'
          : message}
      </p>
    </div>
  )
}

export function DependencySettings({
  active,
  states,
  openAddon,
}: {
  active: boolean
  states: readonly AddonState[]
  openAddon: (id: string) => void
}) {
  const [tools, setTools] = useState<DependencyState[] | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const dialogs = useDialogs()
  // biome-ignore lint/correctness/useExhaustiveDependencies: addon state changes refresh the list of tool consumers.
  useEffect(() => {
    if (!active) return
    let current = true
    const refresh = () =>
      void window.hibi
        .getDependencies()
        .then((next) => {
          if (current) {
            setTools(next)
            setError('')
          }
        })
        .catch((error) => {
          if (current) setError(errorMessage(error))
        })
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      current = false
      window.removeEventListener('focus', refresh)
    }
  }, [active, states])
  useEffect(() => {
    if (!active || !tools?.some((tool) => tool.status === 'installing')) return
    const timer = setInterval(
      () =>
        void window.hibi
          .getDependencies()
          .then(setTools)
          .catch((error) => setError(errorMessage(error))),
      2000,
    )
    return () => clearInterval(timer)
  }, [active, tools])
  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key)
    try {
      await action()
      setTools(await window.hibi.getDependencies())
      window.dispatchEvent(new Event(dependencyChangedEvent))
      setError('')
    } catch (error) {
      await dialogs.alert({
        title: 'Dependency action failed',
        description: errorMessage(error),
      })
    } finally {
      setBusy(null)
    }
  }
  const waiting =
    !!busy || !!tools?.some((tool) => tool.status === 'installing')
  const matches = (tool: DependencyState) =>
    `${tool.name} ${tool.command} ${tool.addons.map((addon) => `${addon.name} ${addon.reason}`).join(' ')}`
      .toLowerCase()
      .includes(query.trim().toLowerCase())
  return (
    <>
      <header className="dependency-intro">
        <h1>Dependencies</h1>
        <p className="plugin-description">
          Tools requested by your addons, including disabled ones.
        </p>
      </header>
      <SettingsFilter
        id="dependencies-filter"
        label="Filter dependencies"
        placeholder="Filter tools or addons…"
        value={query}
        onChange={setQuery}
      />
      <div className="dependency-toolbar">
        <span>{tools ? `${tools.length} tools` : 'Tools'}</span>
        <Button
          disabled={waiting || !tools?.length}
          onClick={() =>
            void run('all', async () => {
              for (const tool of tools ?? [])
                await window.hibi.checkDependency(tool.key)
            })
          }
        >
          {busy === 'all' ? 'Checking…' : 'Check all'}
        </Button>
      </div>
      {error && (
        <DocumentNotice
          variant="warning"
          title="Dependencies unavailable"
          message={error}
        />
      )}
      {!tools && !error && (
        <DocumentNotice title="Checking dependencies…" busy />
      )}
      {tools && (
        <div
          className="settings-group dependency-list"
          hidden={!tools.some(matches)}
        >
          {tools.map((tool) => (
            <section
              key={tool.key}
              aria-label={tool.name}
              hidden={!matches(tool)}
            >
              <details className="dependency-group">
                <summary>
                  <span className="dependency-summary-copy">
                    <strong>{tool.name}</strong>
                    <span data-verbatim="true">
                      {tool.command} · {tool.addons.length}{' '}
                      {tool.addons.length === 1 ? 'addon' : 'addons'}
                    </span>
                  </span>
                  <span className="dependency-state" data-status={tool.status}>
                    {tool.status === 'installing'
                      ? 'Installing…'
                      : tool.status === 'available'
                        ? 'Available'
                        : tool.status === 'error'
                          ? 'Needs attention'
                          : 'Not found'}
                  </span>
                  <ChevronDown
                    className="dependency-chevron"
                    size={16}
                    aria-hidden
                  />
                </summary>
                <div className="dependency-details">
                  <div className="dependency-actions">
                    <a
                      href={tool.homepage}
                      onClick={(event) => {
                        event.preventDefault()
                        void run(tool.key, () =>
                          window.hibi.openDependencyGuide(tool.key),
                        )
                      }}
                    >
                      Installation guide <ExternalLink size={12} aria-hidden />
                    </a>
                    {tool.status !== 'available' && tool.installer && (
                      <Button
                        disabled={waiting}
                        title={tool.installer.command}
                        onClick={() =>
                          void run(tool.key, () =>
                            window.hibi.installDependency(tool.key),
                          )
                        }
                      >
                        Install with {tool.installer.manager}
                      </Button>
                    )}
                    <IconButton
                      aria-label={`Check ${tool.name}`}
                      disabled={waiting}
                      onClick={() =>
                        void run(tool.key, () =>
                          window.hibi.checkDependency(tool.key),
                        )
                      }
                    >
                      <RefreshCw size={15} />
                    </IconButton>
                  </div>
                  <DependencyPath
                    tool={tool}
                    disabled={waiting}
                    configure={async (action) => {
                      setBusy(tool.key)
                      try {
                        const next = await window.hibi.configureDependency(
                          tool.key,
                          action,
                        )
                        setTools(
                          (tools) =>
                            tools?.map((item) =>
                              item.key === tool.key ? next : item,
                            ) ?? null,
                        )
                        window.dispatchEvent(new Event(dependencyChangedEvent))
                        return next
                      } finally {
                        setBusy(null)
                      }
                    }}
                  />
                  <h2 className="dependency-section-label">Used by</h2>
                  <ul
                    className="dependency-addons"
                    aria-label={`Addons using ${tool.name}`}
                  >
                    {tool.addons.map((addon) => (
                      <li key={addon.id}>
                        <button
                          type="button"
                          className="dependency-addon-link"
                          data-tooltip={addon.reason}
                          onClick={() => openAddon(addon.id)}
                        >
                          {addon.name}
                        </button>
                        <span>
                          {addon.optional ? 'Optional' : 'Required'}
                          {!addon.enabled && ' · Addon disabled'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            </section>
          ))}
        </div>
      )}
      {tools && !tools.some(matches) && (
        <Panel>
          <PanelMessage
            icon={tools.length ? <Search size={32} /> : <Package size={32} />}
            title={
              tools.length
                ? 'No matching dependencies'
                : 'No addon dependencies'
            }
          >
            {tools.length
              ? 'Try another tool or addon name.'
              : 'Installed addons do not declare external tools.'}
          </PanelMessage>
        </Panel>
      )}
    </>
  )
}
