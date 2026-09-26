import { useEffect, useState, useSyncExternalStore } from 'react'
import { defineAddon } from '../api'
import { Button, ControlRow, Select, TextArea, TextInput, Toggle } from '../ui'
import manifest from './manifest'
import previewCss from './style.css?inline'

const maxCssBytes = 64 * 1024
const encoder = new TextEncoder()
type Theme = { css: string; enabled: boolean }
type State = {
  saved: Theme
  draft: Theme
  busy: boolean
  error: string
  notice: string
}

function cssBytes(css: string) {
  return encoder.encode(css).length
}

function isTheme(value: unknown): value is Theme {
  return (
    typeof value === 'object' &&
    value !== null &&
    'css' in value &&
    typeof value.css === 'string' &&
    'enabled' in value &&
    typeof value.enabled === 'boolean' &&
    cssBytes(value.css) <= maxCssBytes
  )
}

function saveError(status: string) {
  return status === 'conflict'
    ? 'Custom CSS changed elsewhere. Disable and re-enable UI preview to reload it.'
    : 'Could not save custom CSS. The current change may not survive restart.'
}

export default defineAddon({
  manifest,
  async start(context) {
    const storage = await context.storage.global<unknown>('custom-css', 1)
    const snapshot = storage.snapshot()
    const initial: Theme =
      snapshot.status === 'ready' && isTheme(snapshot.value)
        ? snapshot.value
        : { css: '', enabled: false }
    let state: State = {
      saved: initial,
      draft: initial,
      busy: false,
      error:
        snapshot.status === 'ready' && !isTheme(snapshot.value)
          ? 'Saved custom CSS was invalid and was not applied.'
          : snapshot.status === 'version-mismatch' ||
              snapshot.status === 'unavailable'
            ? 'Saved custom CSS could not be loaded.'
            : '',
      notice: '',
    }
    const listeners = new Set<() => void>()
    const subscribe = (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
    const publish = (changes: Partial<State>) => {
      state = { ...state, ...changes }
      for (const listener of listeners) listener()
    }
    const getSnapshot = () => state
    context.styles.register('preview', previewCss)
    const themeStyle = context.styles.register(
      'custom-css',
      initial.enabled ? initial.css : '',
    )
    let forceOff = false
    let draftRevision = 0
    const apply = ({ css, enabled }: Theme) =>
      themeStyle.update(
        !forceOff && enabled && cssBytes(css) <= maxCssBytes ? css : '',
      )
    const updateDraft = (draft: Theme) => {
      draftRevision++
      if (draft.enabled) forceOff = false
      apply(draft)
      publish({
        draft,
        error:
          cssBytes(draft.css) > maxCssBytes
            ? 'Custom CSS must be 64 KiB or smaller.'
            : '',
        notice: '',
      })
    }
    const revert = () => {
      draftRevision++
      forceOff = false
      apply(state.saved)
      publish({ draft: state.saved, error: '', notice: '' })
    }
    const discardDraft = () => {
      const draft = forceOff ? { ...state.saved, enabled: false } : state.saved
      apply(draft)
      publish({ draft, error: '', notice: '' })
    }
    let previewOpen = false
    let writes: Promise<unknown> = Promise.resolve()
    const queueWrite = (write: () => Promise<void>) => {
      const pending = writes.then(write)
      writes = pending.catch(() => {})
      return pending
    }
    const save = async () => {
      if (state.busy) return
      const next = state.draft
      const revision = draftRevision
      if (cssBytes(next.css) > maxCssBytes) {
        publish({ error: 'Custom CSS must be 64 KiB or smaller.' })
        return
      }
      publish({ busy: true, error: '', notice: '' })
      await queueWrite(async () => {
        try {
          const result = await storage.set(next)
          if (result.status !== 'saved') {
            publish({ error: saveError(result.status) })
            return
          }
          const useSaved = !previewOpen || draftRevision === revision
          const draft = useSaved
            ? forceOff
              ? { ...next, enabled: false }
              : next
            : state.draft
          if (useSaved) apply(draft)
          publish({
            saved: next,
            draft,
            notice: 'Custom CSS saved.',
          })
        } catch {
          publish({ error: saveError('unavailable') })
        } finally {
          publish({ busy: false })
        }
      })
    }
    const disable = () => {
      forceOff = true
      updateDraft({ ...state.draft, enabled: false })
      void queueWrite(async () => {
        const next = { css: state.saved.css, enabled: false }
        try {
          const result = await storage.set(next)
          if (result.status !== 'saved') {
            const message = saveError(result.status)
            publish({ error: message })
            context.notify(message)
            return
          }
          forceOff = false
          apply(previewOpen ? state.draft : next)
          publish({
            saved: next,
            draft: previewOpen ? state.draft : next,
            notice: 'Custom CSS disabled.',
          })
          context.notify('Custom CSS disabled.')
        } catch {
          const message = saveError('unavailable')
          publish({ error: message })
          context.notify(message)
        }
      })
    }
    function Content() {
      const current = useSyncExternalStore(subscribe, getSnapshot)
      const [outlines, setOutlines] = useState(false)
      const [title, setTitle] = useState('A note worth keeping')
      const [body, setBody] = useState(
        'Use this space to test longer text, field spacing, and the active colorscheme.',
      )
      const [sampleOn, setSampleOn] = useState(true)
      useEffect(() => {
        previewOpen = true
        return () => {
          previewOpen = false
          discardDraft()
        }
      }, [])
      const dirty =
        current.draft.css !== current.saved.css ||
        current.draft.enabled !== current.saved.enabled
      const size = cssBytes(current.draft.css)
      return (
        <div className="ui-preview">
          <header className="ui-preview-header">
            <div>
              <h1>UI preview</h1>
              <p>
                Inspect shared controls and try CSS changes in the running app.
              </p>
            </div>
            <label className="ui-preview-toggle" htmlFor="ui-preview-outlines">
              <span>Show red outlines</span>
              <Toggle
                id="ui-preview-outlines"
                aria-label="Show red outlines"
                checked={outlines}
                onChange={(event) => setOutlines(event.target.checked)}
              />
            </label>
          </header>
          <div className="ui-preview-layout">
            <section
              className="ui-preview-stage"
              aria-label="Component preview"
              data-outlines={outlines}
            >
              <div className="ui-preview-stage-header">
                <h2>Controls</h2>
                <p>Edit the examples to check their layout and states.</p>
              </div>
              <div className="ui-preview-samples">
                <div className="ui-preview-sample">
                  <h3>Actions</h3>
                  <ControlRow>
                    <Button variant="primary">Primary action</Button>
                    <Button>Secondary action</Button>
                    <Button variant="ghost">Quiet action</Button>
                    <Button disabled>Unavailable</Button>
                  </ControlRow>
                </div>
                <div className="ui-preview-sample">
                  <h3>Fields</h3>
                  <div className="ui-preview-fields">
                    <label htmlFor="ui-preview-sample-title">
                      Sample title
                      <TextInput
                        id="ui-preview-sample-title"
                        aria-label="Sample title"
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                      />
                    </label>
                    <label htmlFor="ui-preview-sample-body">
                      Sample body
                      <TextArea
                        id="ui-preview-sample-body"
                        aria-label="Sample body"
                        value={body}
                        rows={3}
                        onChange={(event) => setBody(event.target.value)}
                      />
                    </label>
                  </div>
                </div>
                <div className="ui-preview-sample">
                  <h3>Choices</h3>
                  <div className="ui-preview-choices">
                    <label htmlFor="ui-preview-example-menu">
                      Example menu
                      <Select
                        id="ui-preview-example-menu"
                        defaultValue="first"
                        aria-label="Example menu"
                      >
                        <option value="first">First choice</option>
                        <option value="second">Second choice</option>
                      </Select>
                    </label>
                    <label
                      className="ui-preview-toggle"
                      htmlFor="ui-preview-example-switch"
                    >
                      <span>Example switch</span>
                      <Toggle
                        id="ui-preview-example-switch"
                        aria-label="Example switch"
                        checked={sampleOn}
                        onChange={(event) => setSampleOn(event.target.checked)}
                      />
                    </label>
                  </div>
                </div>
                <div className="ui-preview-sample">
                  <h3>Status colors</h3>
                  <div className="ui-preview-statuses">
                    <span data-tone="success">Success</span>
                    <span data-tone="warning">Warning</span>
                    <span data-tone="danger">Error</span>
                  </div>
                </div>
              </div>
            </section>
            <section className="ui-preview-css" aria-label="Custom CSS editor">
              <div className="ui-preview-css-header">
                <div>
                  <h2>Custom CSS</h2>
                  <p>
                    Preview changes across Hibi. Save to keep them after
                    restart.
                  </p>
                </div>
                <label
                  className="ui-preview-toggle"
                  htmlFor="ui-preview-enable"
                >
                  <span>Enable custom CSS</span>
                  <Toggle
                    id="ui-preview-enable"
                    aria-label="Enable custom CSS"
                    checked={current.draft.enabled}
                    onChange={(event) =>
                      updateDraft({
                        ...current.draft,
                        enabled: event.target.checked,
                      })
                    }
                  />
                </label>
              </div>
              <label className="ui-preview-css-label" htmlFor="ui-preview-css">
                CSS
              </label>
              <TextArea
                id="ui-preview-css"
                aria-label="Custom CSS"
                className="ui-preview-css-input"
                monospace
                spellCheck={false}
                value={current.draft.css}
                placeholder={':root { --accent: rebeccapurple; }'}
                onChange={(event) =>
                  updateDraft({
                    ...current.draft,
                    css: event.target.value,
                  })
                }
              />
              <div className="ui-preview-css-footer">
                <span aria-live="polite">
                  {(size / 1024).toFixed(1)} / 64 KiB
                </span>
                <ControlRow>
                  <Button onClick={revert} disabled={!dirty || current.busy}>
                    Revert
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void save()}
                    disabled={!dirty || current.busy || size > maxCssBytes}
                  >
                    Save CSS
                  </Button>
                </ControlRow>
              </div>
              {current.error && <p role="alert">{current.error}</p>}
              {current.notice && <p role="status">{current.notice}</p>}
            </section>
          </div>
        </div>
      )
    }
    const view = context.views.register({
      id: 'preview',
      label: 'UI preview',
      location: 'tab',
      lifetime: 'session',
      Content,
    })
    context.commands.register({
      id: 'open',
      label: 'Open UI preview',
      keywords: 'components controls inspect theme css',
      run: () => {
        view.open({ id: 'preview' })
      },
    })
    context.commands.register({
      id: 'disable-css',
      label: 'Disable custom CSS',
      keywords: 'theme reset recover stylesheet',
      menu: { location: 'app' },
      run: disable,
    })
  },
})
