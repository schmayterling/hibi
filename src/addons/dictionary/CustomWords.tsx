import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { HostSelectedIoHostApi } from '../../shared/host-selected-io'
import { SettingsPageVisible } from '../../ui/settings-index'
import { Button, Select, SettingRow, TextArea, TextInput } from '../ui'
import {
  addCustomWord,
  type CustomWord,
  customWordsFileIo,
  editCustomWord,
  exportSavedCustomWords,
  importCustomWords,
  listCustomWords,
  mergeCustomWords,
  onCustomWordsChanged,
  updateCustomWords,
} from './custom-words'
import { LANGS, type Lang } from './providers'
import { languageNames } from './settings'

const failed = (error: unknown) =>
  error instanceof Error ? error.message : 'Could not save custom words.'
const utf8 = new TextDecoder('utf-8', { fatal: true })
type Retain = (id: string | undefined) => () => void

/** Shows the saved note until the user types; only a changed note is saved, and the typed one stays if saving fails. */
function NoteInput({
  item,
  save,
  retain,
}: {
  item: CustomWord
  save: (note: string) => Promise<boolean>
  retain: Retain
}) {
  const saved = item.note ?? ''
  // One object per keystroke, so a finished save clears only the text it saved.
  const [draft, setDraft] = useState<{ text: string } | null>(null)
  const saving = useRef(0)
  const drafting = draft !== null
  // A typed or failed note keeps its row mounted while the list scrolls.
  useEffect(
    () => (drafting ? retain(item.id) : undefined),
    [drafting, item.id, retain],
  )
  return (
    <TextInput
      aria-label={`Note for “${item.word}”`}
      placeholder="Note or definition"
      maxLength={2000}
      value={draft?.text ?? saved}
      onChange={(event) => setDraft({ text: event.target.value })}
      onBlur={() => {
        if (!draft) return
        const note = draft.text.trim()
        const done = () =>
          setDraft((current) => (current === draft ? null : current))
        // Queue it anyway while saves are pending, so the last note typed wins.
        if (note === saved && !saving.current) return done()
        saving.current++
        void save(note).then((ok) => {
          saving.current--
          if (ok) done()
        })
      }}
    />
  )
}

/** Mounts rows within one viewport of the visible area, plus focused rows and unsaved notes; padding keeps the full height. */
function WordList({
  words,
  row,
}: {
  words: readonly CustomWord[]
  row: (item: CustomWord, retain: Retain) => ReactNode
}) {
  const list = useRef<HTMLUListElement>(null)
  const scroller = useRef<HTMLElement | null>(null)
  const [range, setRange] = useState({ from: 0, to: 0, size: 68 })
  const [focused, setFocused] = useState<string>()
  const [drafts, setDrafts] = useState<ReadonlySet<string | undefined>>(
    () => new Set(),
  )
  const count = words.length
  const update = useCallback(() => {
    const element = list.current
    if (!element) return
    let size = Number.POSITIVE_INFINITY
    for (const item of element.children)
      if (item instanceof HTMLElement && item.offsetHeight)
        size = Math.min(size, item.offsetHeight)
    const box = element.getBoundingClientRect()
    const view = scroller.current?.getBoundingClientRect() ?? {
      top: 0,
      bottom: innerHeight,
    }
    const margin = view.bottom - view.top
    setRange((current) => {
      const height = Number.isFinite(size) ? size : current.size
      const from = Math.min(
        count,
        Math.max(0, Math.floor((view.top - margin - box.top) / height)),
      )
      const to = Math.min(
        count,
        Math.max(from, Math.ceil((view.bottom + margin - box.top) / height)),
      )
      return from === current.from &&
        to === current.to &&
        height === current.size
        ? current
        : { from, to, size: height }
    })
  }, [count])
  useLayoutEffect(() => {
    let node = list.current?.parentElement ?? null
    while (node && !/auto|scroll/.test(getComputedStyle(node).overflowY))
      node = node.parentElement
    scroller.current = node
    const target = node ?? window
    target.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      target.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [update])
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows mounted for a new range are measured again; an equal range stops here.
  useLayoutEffect(update, [update, range.from, range.to])
  const retain = useCallback<Retain>((id) => {
    setDrafts((current) => new Set(current).add(id))
    return () =>
      setDrafts((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
  }, [])
  const indices = useMemo(
    () => new Map(words.map((item, index) => [item.id, index])),
    [words],
  )
  const shown = new Set<number>()
  for (let index = range.from; index < Math.min(range.to, count); index++)
    shown.add(index)
  for (const id of [focused, ...drafts]) {
    const index = indices.get(id)
    if (index !== undefined) shown.add(index)
  }
  const rows = [...shown].sort((a, b) => a - b)
  const first = rows[0] ?? count
  const last = rows.at(-1) ?? count - 1
  return (
    <ul
      ref={list}
      style={{
        paddingTop: first * range.size,
        paddingBottom: (count - last - 1) * range.size,
      }}
      onFocus={(event) =>
        setFocused((event.target as HTMLElement).closest('li')?.dataset.word)
      }
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocused(undefined)
      }}
    >
      {rows.map((index, position) => {
        const item = words[index]
        if (!item) return null
        const gap = index - (rows[position - 1] ?? index - 1) - 1
        return (
          <li
            key={item.id}
            className="setting-row"
            data-word={item.id}
            aria-posinset={index + 1}
            aria-setsize={count}
            style={gap ? { marginTop: gap * range.size } : undefined}
          >
            {row(item, retain)}
          </li>
        )
      })}
    </ul>
  )
}

export function CustomWords() {
  // Hidden discovery and search still register this section's setting rows.
  const visible = useContext(SettingsPageVisible)
  const words = useSyncExternalStore(onCustomWordsChanged, listCustomWords)
  const [draft, setDraft] = useState('')
  const [text, setText] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const merge = (imported: CustomWord[]) =>
    updateCustomWords((current) => mergeCustomWords(current, imported)).then(
      () =>
        setMessage(
          imported.length === 1
            ? 'Imported 1 word.'
            : `Imported ${imported.length} words.`,
        ),
    )
  const withFile = (run: (io: HostSelectedIoHostApi) => Promise<void>) => {
    const io = customWordsFileIo()
    if (!io) {
      setMessage('Turn on Dictionary and thesaurus to keep custom words.')
      return
    }
    setBusy(true)
    run(io)
      .catch((error) => setMessage(failed(error)))
      .finally(() => setBusy(false))
  }
  const edit = (
    original: CustomWord,
    change: (current: CustomWord) => CustomWord,
  ) =>
    editCustomWord(original, change).then(
      () => {
        setMessage('')
        return true
      },
      (error) => {
        setMessage(failed(error))
        return false
      },
    )
  return (
    <section
      className="dictionary-custom-words"
      aria-labelledby="dictionary-custom-words"
    >
      <h2 id="dictionary-custom-words">Custom words</h2>
      <div className="settings-group">
        <SettingRow
          id="dictionary-new-word"
          label="New custom word"
          description="Words you add are shown as your word in lookups and come first in suggestions. They stay on this computer and are never sent online."
        >
          <form
            className="ui-control-row"
            onSubmit={(event) => {
              event.preventDefault()
              addCustomWord({ word: draft })
                .then(() => {
                  setDraft('')
                  setMessage('')
                })
                .catch((error) => setMessage(failed(error)))
            }}
          >
            <TextInput
              id="dictionary-new-word"
              placeholder="Add a word…"
              maxLength={64}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button type="submit" disabled={!draft.trim()}>
              Add
            </Button>
          </form>
        </SettingRow>
        {!visible ? null : words.length ? (
          <WordList
            words={words}
            row={(item, retain) => (
              <>
                <span className="dictionary-custom-word" lang={item.lang}>
                  {item.word}
                </span>
                <Select
                  aria-label={`Language of “${item.word}”`}
                  value={item.lang ?? ''}
                  onChange={(event) => {
                    const lang = event.target.value as Lang | ''
                    void edit(item, ({ lang: _old, ...rest }) =>
                      lang ? { ...rest, lang } : rest,
                    )
                  }}
                >
                  <option value="">Any language</option>
                  {LANGS.map((lang) => (
                    <option key={lang} value={lang}>
                      {languageNames[lang]}
                    </option>
                  ))}
                </Select>
                <NoteInput
                  item={item}
                  retain={retain}
                  save={(note) =>
                    edit(item, ({ note: _old, ...rest }) =>
                      note ? { ...rest, note } : rest,
                    )
                  }
                />
                <Button
                  variant="ghost"
                  aria-label={`Remove “${item.word}”`}
                  onClick={() =>
                    updateCustomWords((current) =>
                      current.filter((other) => other.id !== item.id),
                    )
                      .then(() => setMessage(''))
                      .catch((error) => setMessage(failed(error)))
                  }
                >
                  Remove
                </Button>
              </>
            )}
          />
        ) : (
          <div className="setting-row">
            <p>No custom words yet.</p>
          </div>
        )}
        <SettingRow
          id="dictionary-words-text"
          label="Custom words as text"
          description="One word per line. Add a tab, a language code such as en, and a note to keep them."
        >
          <TextArea
            id="dictionary-words-text"
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </SettingRow>
      </div>
      <div className="workspace-setting-actions">
        <Button
          onClick={() =>
            exportSavedCustomWords()
              .then((exported) => {
                setText(exported)
                return window.hibi
                  .invokeAddon('dictionary', 'copyCustomWords', exported)
                  .then(() => setMessage('Copied your words as text.'))
                  .catch(() => setMessage('Select the text to copy it.'))
              })
              .catch((error) => setMessage(failed(error)))
          }
        >
          Export as text
        </Button>
        <Button
          disabled={!text.trim()}
          onClick={() => {
            const imported = importCustomWords(text)
            if (!imported.length) {
              setMessage('No words were found in the text.')
              return
            }
            merge(imported)
              .then(() => setText(''))
              .catch((error) => setMessage(failed(error)))
          }}
        >
          Import text
        </Button>
        <Button
          disabled={busy || !words.length}
          onClick={() =>
            withFile(async (io) => {
              const selecting = io.selectExport({
                suggestedName: 'custom-words.txt',
                extension: 'txt',
              })
              const exported = exportSavedCustomWords(
                selecting.then((selected) => selected.ok && !!selected.value),
              )
              void exported.catch(() => {})
              const selected = await selecting
              if (!selected.ok) throw new Error(selected.message)
              if (!selected.value) return
              let bytes: Uint8Array
              try {
                bytes = new TextEncoder().encode(`${await exported}\n`)
              } catch (error) {
                await io.cancel(selected.value.handle).catch(() => {})
                throw error
              }
              const written = await io.writeExport(selected.value.handle, bytes)
              if (!written.ok) throw new Error(written.message)
              setMessage(`Saved your words to ${selected.value.name}.`)
            })
          }
        >
          Export to file…
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            withFile(async (io) => {
              const selected = await io.selectImport({ extensions: ['txt'] })
              if (!selected.ok) throw new Error(selected.message)
              if (!selected.value) return
              const read = await io.readImport(selected.value.handle)
              if (!read.ok) throw new Error(read.message)
              let imported: CustomWord[]
              try {
                imported = importCustomWords(utf8.decode(read.value))
              } catch {
                throw new Error('Choose a text file saved as UTF-8.')
              }
              if (!imported.length)
                setMessage('No words were found in the file.')
              else await merge(imported)
            })
          }
        >
          Import from file…
        </Button>
      </div>
      {message && (
        <p role="status" className="setting-description">
          {message}
        </p>
      )}
    </section>
  )
}
