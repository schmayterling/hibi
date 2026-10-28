import type { Token } from 'marked'
import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '../../shared/errors'
import { readFrontmatter } from '../../shared/frontmatter'
import { lexMarkdown } from '../../shared/marked-blocks'
import type { AddonWindowProps } from '../api'
import { Button, ShortcutKeys } from '../ui'
import { type QuickNoteSettings, readSettings, settingsKey } from './settings'
import './quick-note.css'

const savedDelay = 700
const draftDelay = 300
/** After this many failed draft writes in a row, the window warns. */
const failureLimit = 3
const legacyDraftKey = 'hibi:quick-note-draft'
const mac = navigator.userAgent.includes('Mac')
const platform = mac ? 'darwin' : 'win32'
type Target = { id: string; path: string; folder: string }
type Destination = Target | { error: string }
type Draft = { markdown: string }
type DraftLoad =
  | { status: 'none' }
  | { status: 'ready'; draft: Draft }
  | { status: 'unreadable'; keptAs: string | null }

/** Drafts from the previous version lived in renderer storage. */
function readLegacyDraft() {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(legacyDraftKey) ?? '{}',
    )
    return value &&
      typeof value === 'object' &&
      'markdown' in value &&
      typeof value.markdown === 'string'
      ? value.markdown
      : ''
  } catch {
    return ''
  }
}

/** A new note starts with the default title as its heading when Hibi asks for a title. */
const template = (settings: QuickNoteSettings) =>
  settings.promptForTitle ? `# ${settings.defaultTitle}\n\n` : ''
const untouched = (markdown: string, settings: QuickNoteSettings) =>
  markdown.trim() === template(settings).trim()

const plain = (tokens: readonly Token[] = []): string =>
  tokens
    .map((token) =>
      'tokens' in token && token.tokens
        ? plain(token.tokens)
        : 'text' in token
          ? token.text
          : '',
    )
    .join('')

/** File name from the note's first Markdown heading, or the default title. */
function noteTitle(markdown: string, fallback: string) {
  // Frontmatter is metadata; its closing `---` would otherwise read as a setext underline.
  const body = readFrontmatter(markdown)?.content ?? markdown
  const heading = lexMarkdown(body).find((token) => token.type === 'heading')
  const title = plain(heading && 'tokens' in heading ? heading.tokens : [])
    .replace(/[\\/:*?"<>|#\p{Cc}]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 100)
  return title || fallback
}

/** Editor popups (slash commands, completions, menus, dialogs) handle Escape themselves. */
const popupOpen = () =>
  [
    ...document.querySelectorAll(
      'dialog[open], [role="menu"], [role="listbox"]',
    ),
  ].some((element) => element.getClientRects().length > 0)

export function CaptureWindow({ Editor, native, close }: AddonWindowProps) {
  const [settings, setSettings] = useState(readSettings)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const [initial, setInitial] = useState<string | null>(null)
  const [session, setSession] = useState(0)
  const sessionRef = useRef(0)
  sessionRef.current = session
  const markdown = useRef('')
  // Notes save to the destination currently set; the footer follows it live.
  const [destination, setDestination] = useState<Destination | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState('')
  const [error, setError] = useState('')
  const [unreadable, setUnreadable] = useState<{
    keptAs: string | null
  } | null>(null)
  const [draftWarning, setDraftWarning] = useState(false)
  const failures = useRef(0)
  // A previous version's draft stays until a native write is acknowledged.
  const legacyPending = useRef(false)
  const busy = saving || !!saved

  const resolve = useCallback(async (): Promise<Destination> => {
    // Read storage directly: a settings change may not have reached the listener yet.
    const current = readSettings()
    try {
      const target = await native.query<{ id: string; path: string }>(
        'destination',
        current.workspaceId,
      )
      return { ...target, folder: current.folder }
    } catch (failure) {
      return { error: errorMessage(failure) }
    }
  }, [native])
  // A slow lookup must not replace the footer from a newer one.
  const refreshes = useRef(0)
  const refresh = useCallback(() => {
    const id = ++refreshes.current
    void resolve().then((next) => {
      if (id === refreshes.current) setDestination(next)
    })
  }, [resolve])

  // Drafts go to the main process, which acknowledges each write.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const writing = useRef<Promise<unknown>>(Promise.resolve())
  const writeDraft = useCallback((): Promise<boolean> => {
    clearTimeout(timer.current)
    const value = untouched(markdown.current, settingsRef.current)
      ? ''
      : markdown.current
    const draft: Draft = { markdown: value }
    const write = writing.current
      .catch(() => {})
      .then(() => native.invoke<{ keptAs: string | null }>('saveDraft', draft))
      .then(
        ({ keptAs }) => {
          failures.current = 0
          setDraftWarning(false)
          // Writes succeed again, so the unreadable draft is no longer in place.
          setUnreadable((notice) =>
            notice?.keptAs === null ? (keptAs ? { keptAs } : null) : notice,
          )
          if (legacyPending.current) {
            localStorage.removeItem(legacyDraftKey)
            legacyPending.current = false
          }
          return true
        },
        () => {
          // Usually another file operation was running; keep retrying, and warn
          // once failures persist.
          if (++failures.current >= failureLimit) setDraftWarning(true)
          timer.current = setTimeout(writeDraft, draftDelay)
          return false
        },
      )
    writing.current = write
    return write
  }, [native])
  const scheduleDraft = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(writeDraft, draftDelay)
  }, [writeDraft])
  const hide = useCallback(() => {
    void writeDraft()
    close()
  }, [close, writeDraft])

  useEffect(() => {
    let active = true
    const open = async (): Promise<DraftLoad | null> => {
      for (;;) {
        try {
          return await native.invoke<DraftLoad>('openDraft')
        } catch {
          // Another file operation was running.
          if (!active) return null
          await new Promise((resolve) => setTimeout(resolve, draftDelay))
        }
      }
    }
    void open().then((result) => {
      if (!active || !result) return
      let text = template(settingsRef.current)
      const legacy = result.status === 'unreadable' ? '' : readLegacyDraft()
      if (result.status === 'ready' && result.draft.markdown)
        text = result.draft.markdown
      else if (result.status === 'unreadable') setUnreadable(result)
      else if (legacy) text = legacy
      markdown.current = text
      setInitial(text)
      // A native draft outranks the previous version's; either way the old one is retired.
      if (legacy) {
        legacyPending.current = true
        void writeDraft()
      }
    })
    return () => {
      active = false
    }
  }, [native, writeDraft])
  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== settingsKey) return
      const next = readSettings()
      // An untouched note follows the new settings; a started one is kept.
      if (untouched(markdown.current, settingsRef.current)) {
        markdown.current = template(next)
        setInitial(markdown.current)
        setSession((value) => value + 1)
      }
      settingsRef.current = next
      setSettings(next)
      refresh()
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [refresh])

  async function submit() {
    if (busy || initial === null) return
    // Only this text is saved; anything typed while saving stays for the next note.
    const snapshot = markdown.current
    setSaving(true)
    setError('')
    try {
      const target = await resolve()
      if ('error' in target) throw new Error(target.error)
      await writing.current.catch(() => {})
      const result = await native.invoke<{ name: string }>('save', {
        workspaceId: target.id,
        folder: target.folder,
        title: noteTitle(snapshot, settingsRef.current.defaultTitle),
        markdown: snapshot,
      })
      setSaved(result.name)
      // Text typed while the note was saving stays as the next note.
      const current = markdown.current
      const rest =
        current === snapshot
          ? ''
          : current.startsWith(snapshot)
            ? current.slice(snapshot.length).replace(/^\s+/, '')
            : current
      setUnreadable(null)
      if (rest) {
        markdown.current = rest
        setInitial(rest)
        setSession((value) => value + 1)
        await writeDraft()
        setTimeout(() => setSaved(''), savedDelay)
        return
      }
      // The window stays alive hidden; the next note starts empty.
      markdown.current = template(settingsRef.current)
      setInitial(markdown.current)
      setSession((value) => value + 1)
      await writeDraft()
      setTimeout(() => {
        setSaved('')
        refresh()
        close()
      }, savedDelay)
    } catch (failure) {
      setError(errorMessage(failure) || 'Could not save this note.')
    } finally {
      setSaving(false)
    }
  }
  const submitRef = useRef(submit)
  submitRef.current = submit
  useEffect(() => {
    // Capture runs before popups close themselves, so an open popup keeps the window.
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || popupOpen()) return
      event.preventDefault()
      event.stopPropagation()
      hide()
    }
    // Capture so the editor never turns these into a line break first.
    const command = (event: KeyboardEvent) => {
      if (event.isComposing || !(mac ? event.metaKey : event.ctrlKey)) return
      if (event.key.toLowerCase() === 'w') {
        event.preventDefault()
        event.stopPropagation()
        hide()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        void submitRef.current()
      }
    }
    window.addEventListener('keydown', dismiss, true)
    window.addEventListener('keydown', command, true)
    return () => {
      window.removeEventListener('keydown', dismiss, true)
      window.removeEventListener('keydown', command, true)
    }
  }, [hide])
  const where =
    destination && 'path' in destination
      ? [
          destination.path.split(/[\\/]/).filter(Boolean).at(-1) ?? '',
          ...destination.folder.split('/').filter(Boolean),
        ].join(' › ')
      : ''
  return (
    <div className="quick-note-window">
      {initial !== null && (
        <Editor
          key={session}
          label="Note"
          defaultValue={initial}
          onChange={(value) => {
            // An editor from a previous note may report once more while it unmounts.
            if (session !== sessionRef.current) return
            markdown.current = value
            scheduleDraft()
          }}
        />
      )}
      <footer className="dialog-footer quick-note-bar">
        {error || (destination && 'error' in destination) ? (
          <p role="alert" className="quick-note-meta">
            {error ||
              (destination && 'error' in destination && destination.error)}
          </p>
        ) : draftWarning ? (
          <p role="status" className="quick-note-meta quick-note-warning">
            Hibi cannot keep this note right now. Save it or copy the text
            somewhere safe.
          </p>
        ) : unreadable ? (
          <p role="alert" className="quick-note-meta">
            {unreadable.keptAs
              ? `Hibi could not read your previous unsaved note, so it kept the file as ${unreadable.keptAs} in its app data folder.`
              : 'Hibi could not read your previous unsaved note. It left the file unchanged and will not keep new notes until the file is moved.'}
          </p>
        ) : (
          <p role="status" className="quick-note-meta">
            {saved ? (
              `Saved ${saved}.`
            ) : (
              <span
                data-tooltip={
                  destination && 'path' in destination
                    ? `${destination.path}${destination.folder ? `/${destination.folder}` : ''}`
                    : undefined
                }
                data-verbatim="true"
              >
                {where}
              </span>
            )}
          </p>
        )}
        <Button onClick={hide} disabled={busy} aria-keyshortcuts="Escape">
          Cancel
          <span aria-hidden="true">
            <ShortcutKeys shortcut="escape" platform={platform} />
          </span>
        </Button>
        <Button
          variant="primary"
          onClick={() => void submit()}
          disabled={busy || initial === null || !destination}
          aria-keyshortcuts={mac ? 'Meta+Enter' : 'Control+Enter'}
        >
          {saving ? 'Saving…' : 'Save'}
          <span aria-hidden="true">
            <ShortcutKeys
              shortcut={mac ? 'meta+enter' : 'ctrl+enter'}
              platform={platform}
            />
          </span>
        </Button>
      </footer>
    </div>
  )
}
