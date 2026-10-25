import { ChevronRight, Image, X } from 'lucide-react'
import {
  type ComponentProps,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { bundledColorschemes } from '../../shared/color-palettes'
import type { Colorscheme, ThemePreferences } from '../../shared/colorschemes'
import { errorMessage } from '../../shared/errors'
import type { AddonContext } from '../api'
import {
  Button,
  ControlRow,
  DocumentNotice,
  IconButton,
  PanelMessage,
  Select,
  SettingRow,
  TextArea,
  TextInput,
  Toggle,
} from '../ui'
import { type ExportOptions, validateExportOptions } from './options'
import './style.css'

type ExportSetup = Omit<
  ComponentProps<typeof ExportDialog>,
  'formId' | 'context' | 'signal'
>

export function LoadingExportDialog({
  setup,
  close,
  ...props
}: {
  setup: Promise<ExportSetup>
  close: () => void
  formId: string
  context: AddonContext
  signal: AbortSignal
}) {
  const [loaded, setLoaded] = useState<ExportSetup | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void setup.then(
      (value) => {
        if (active) setLoaded(value)
      },
      (error) => {
        if (active) setError(errorMessage(error))
      },
    )
    return () => {
      active = false
    }
  }, [setup])
  if (error) return <DocumentNotice title="Could not export" message={error} />
  if (!loaded)
    return <PanelMessage icon={null} title="Loading export options…" loading />
  return (
    <ExportDialog
      {...props}
      {...loaded}
      save={async (...args) => {
        const saved = await loaded.save(...args)
        if (saved) close()
        return saved
      }}
    />
  )
}

export function ExportDialog({
  formId,
  context,
  initial,
  graph,
  warning,
  save,
  signal,
  pages = [],
  colorschemes = [],
  contributions = [],
}: {
  formId: string
  context: AddonContext
  initial: ExportOptions
  graph: boolean
  warning: string | null
  signal?: AbortSignal
  save: (
    options: ExportOptions,
    password: string,
    signal?: AbortSignal,
  ) => Promise<boolean>
  pages?: readonly { path: string }[]
  /** Enabled addon colorschemes; bundled schemes are always listed. */
  colorschemes?: readonly Colorscheme[]
  /** Enabled addons that add styles or behavior to exported sites. */
  contributions?: readonly { id: string; name: string; description: string }[]
}) {
  const schemes = [
    ...bundledColorschemes,
    ...colorschemes.filter(
      (scheme) =>
        !bundledColorschemes.some((bundled) => bundled.id === scheme.id),
    ),
  ]
  const [options, setOptions] = useState(initial)
  const locked = options.passwordProtected
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [footer, setFooter] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setFooter(document.getElementById(`${formId}-footer`))
  }, [formId])
  const set = <K extends keyof ExportOptions>(
    key: K,
    value: ExportOptions[K],
  ) => setOptions((old) => ({ ...old, [key]: value }))
  const text = (
    key:
      | 'title'
      | 'description'
      | 'author'
      | 'url'
      | 'socialImage'
      | 'language'
      | 'footer',
    label: string,
    placeholder?: string,
  ) => (
    <SettingRow id={`export-${key}`} label={label}>
      <TextInput
        id={`export-${key}`}
        value={options[key]}
        placeholder={placeholder}
        onChange={(event) => set(key, event.target.value)}
      />
    </SettingRow>
  )
  const toggle = (
    key:
      | 'singleFile'
      | 'autoSeo'
      | 'indexing'
      | 'lockTheme'
      | 'graph'
      | 'outline'
      | 'pagination',
    label: string,
    description?: string,
  ) => (
    <SettingRow id={`export-${key}`} label={label} description={description}>
      <Toggle
        id={`export-${key}`}
        checked={key === 'indexing' && locked ? false : options[key]}
        disabled={(key === 'graph' && !graph) || (key === 'indexing' && locked)}
        onChange={(event) => set(key, event.target.checked)}
      />
    </SettingRow>
  )
  return (
    <form
      id={formId}
      className="export-options"
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError('')
        try {
          const selected = validateExportOptions(options)
          if (locked && password.length < 8)
            throw new Error('Use a password of at least 8 characters.')
          await save(selected, locked ? password : '', signal)
        } catch (error) {
          if (!signal?.aborted) setError(errorMessage(error))
        } finally {
          setBusy(false)
        }
      }}
    >
      <fieldset disabled={busy}>
        {warning && (
          <DocumentNotice
            variant="warning"
            title="Saved export options unavailable"
            message={warning}
          />
        )}
        <div className="settings-group">
          {text('title', 'Site title')}
          {text('description', 'Description')}
          {toggle(
            'singleFile',
            'Single HTML file',
            options.singleFile
              ? 'One file with hash-based links.'
              : 'A folder with clean URLs and a separate HTML page for each document.',
          )}
        </div>
        {!options.singleFile && (
          <DocumentNotice
            variant="warning"
            title="Static-folder export is experimental."
          />
        )}
        <details className="ui-disclosure" open>
          <summary>
            <ChevronRight size={14} aria-hidden />
            Branding and appearance
          </summary>
          <div className="settings-group">
            {(['logo', 'favicon'] as const).map((key) => (
              <SettingRow
                key={key}
                id={`export-${key}`}
                label={key === 'logo' ? 'Logo' : 'Favicon'}
              >
                <ControlRow>
                  {options[key] && (
                    <img
                      className="export-image"
                      src={options[key]}
                      alt={key}
                    />
                  )}
                  <Button
                    id={`export-${key}`}
                    aria-label={`Choose ${key}`}
                    onClick={async () => {
                      try {
                        const value = await context.native.invoke<
                          string | null
                        >('image')
                        if (value) set(key, value)
                      } catch (error) {
                        setError(errorMessage(error))
                      }
                    }}
                  >
                    <Image size={14} aria-hidden />
                    Choose image…
                  </Button>
                  {options[key] && (
                    <IconButton
                      aria-label={`Remove ${key}`}
                      onClick={() => set(key, '')}
                    >
                      <X size={14} aria-hidden />
                    </IconButton>
                  )}
                </ControlRow>
              </SettingRow>
            ))}
            <SettingRow id="export-mode" label="Appearance">
              <Select
                id="export-mode"
                value={options.theme.mode}
                onChange={(event) =>
                  set('theme', {
                    ...options.theme,
                    mode: event.target.value as ThemePreferences['mode'],
                  })
                }
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </Select>
            </SettingRow>
            {(['light', 'dark'] as const).map((mode) => (
              <SettingRow
                key={mode}
                id={`export-${mode}`}
                label={`${mode} theme`}
              >
                <Select
                  id={`export-${mode}`}
                  value={options.theme[mode]}
                  onChange={(event) =>
                    set('theme', {
                      ...options.theme,
                      [mode]: event.target.value,
                    })
                  }
                >
                  {schemes
                    .filter((scheme) => scheme.appearance === mode)
                    .map((scheme) => (
                      <option key={scheme.id} value={scheme.id}>
                        {scheme.name}
                      </option>
                    ))}
                </Select>
              </SettingRow>
            ))}
            {toggle(
              'lockTheme',
              'Lock theme',
              'Use these colors without showing the appearance picker.',
            )}
            {graph && toggle('graph', 'Include graph')}
          </div>
        </details>
        <details className="ui-disclosure">
          <summary>
            <ChevronRight size={14} aria-hidden />
            Layout and navigation
          </summary>
          <div className="settings-group">
            <SettingRow
              id="export-homePage"
              label="Home page"
              description="Visitors see this page first."
            >
              <Select
                id="export-homePage"
                value={options.homePage}
                onChange={(event) => set('homePage', event.target.value)}
              >
                <option value="">Automatic</option>
                {options.homePage &&
                  !pages.some((page) => page.path === options.homePage) && (
                    <option value={options.homePage}>
                      {options.homePage} (missing)
                    </option>
                  )}
                {pages.map((page) => (
                  <option key={page.path} value={page.path}>
                    {page.path}
                  </option>
                ))}
              </Select>
            </SettingRow>
            <SettingRow id="export-contentWidth" label="Page width">
              <Select
                id="export-contentWidth"
                value={options.contentWidth}
                onChange={(event) =>
                  set(
                    'contentWidth',
                    event.target.value as ExportOptions['contentWidth'],
                  )
                }
              >
                <option value="normal">Standard</option>
                <option value="wide">Wide</option>
              </Select>
            </SettingRow>
            {toggle(
              'outline',
              'Page outline',
              'List the headings on each page.',
            )}
            {toggle(
              'pagination',
              'Previous and next links',
              'Link each page to its neighbors in the navigation.',
            )}
            {text('footer', 'Footer text', '© 2026 Your name')}
          </div>
        </details>
        {contributions.length > 0 && (
          <details className="ui-disclosure">
            <summary>
              <ChevronRight size={14} aria-hidden />
              Site addons
            </summary>
            <div className="settings-group">
              {contributions.map((addon) => (
                <SettingRow
                  key={addon.id}
                  id={`export-addon-${addon.id}`}
                  label={addon.name}
                  description={addon.description}
                >
                  <Toggle
                    id={`export-addon-${addon.id}`}
                    checked={options.addons[addon.id] !== false}
                    onChange={(event) =>
                      set('addons', {
                        ...options.addons,
                        [addon.id]: event.target.checked,
                      })
                    }
                  />
                </SettingRow>
              ))}
            </div>
          </details>
        )}
        <details className="ui-disclosure">
          <summary>
            <ChevronRight size={14} aria-hidden />
            Search and sharing
          </summary>
          <div className="settings-group">
            {text('url', 'Site URL', 'https://example.com/docs/')}
            {text(
              'socialImage',
              'Social image URL',
              'https://example.com/preview.png',
            )}
            {text('author', 'Author')}
            {text('language', 'Language', 'en')}
            {toggle(
              'autoSeo',
              'Automatic SEO',
              'Generate page descriptions and structured data.',
            )}
            {toggle('indexing', 'Allow search indexing')}
          </div>
        </details>
        <details className="ui-disclosure" open={initial.passwordProtected}>
          <summary>
            <ChevronRight size={14} aria-hidden />
            Password protection
          </summary>
          <div className="settings-group">
            <SettingRow id="export-protect" label="Require a password">
              <Toggle
                id="export-protect"
                checked={locked}
                onChange={(event) =>
                  set('passwordProtected', event.target.checked)
                }
              />
            </SettingRow>
            {locked && (
              <SettingRow id="export-password" label="Password">
                <TextInput
                  id="export-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </SettingRow>
            )}
          </div>
          {locked && (
            <DocumentNotice
              variant="warning"
              title="Protected sites cannot be indexed."
              message="The content is encrypted. Protected sites use hash-based links."
            />
          )}
        </details>
        <details className="ui-disclosure">
          <summary>
            <ChevronRight size={14} aria-hidden />
            CSS overrides
          </summary>
          <label htmlFor="export-css">Custom CSS</label>
          <TextArea
            id="export-css"
            rows={8}
            monospace
            value={options.css}
            onChange={(event) => set('css', event.target.value)}
            spellCheck={false}
          />
        </details>
      </fieldset>
      {error && <DocumentNotice title="Could not export" message={error} />}
      {footer &&
        createPortal(
          <Button type="submit" form={formId} disabled={busy}>
            {busy ? 'Exporting…' : 'Export'}
          </Button>,
          footer,
        )}
    </form>
  )
}
