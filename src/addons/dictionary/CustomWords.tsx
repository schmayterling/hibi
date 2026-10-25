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
type NoteDraft = { text: string }
type Drafts = ReadonlyMap<string | undefined, NoteDraft>
type ChangeDraft = (
  id: string | undefined,
  change: (current: NoteDraft | undefined) => NoteDraft | undefined,
) => void
// Rows are never shorter than a setting row; this only spaces rows not yet measured.
const rowEstimate = 68

/** Shows the saved note until the user types; only a changed note is saved, and the typed one stays if saving fails. */
function NoteInput({
  item,
  draft,
  changeDraft,
  saving,
  save,
}: {
  item: CustomWord
  draft: NoteDraft | undefined
  changeDraft: ChangeDraft
  saving: Map<string | undefined, number>
  save: (note: string) => Promise<boolean>
}) {
  const saved = item.note ?? ''
  return (
    <TextInput
      aria-label={`Note for “${item.word}”`}
      placeholder="Note or definition"
      maxLength={2000}
      value={draft?.text ?? saved}
      onChange={(event) => {
        // One object per keystroke, so a finished save clears only the text it saved.
        const typed = { text: event.target.value }
        changeDraft(item.id, () => typed)
      }}
      onBlur={() => {
        if (!draft) return
        const note = draft.text.trim()
        const done = () =>
          changeDraft(item.id, (current) =>
            current === draft ? undefined : current,
          )
        const pending = saving.get(item.id) ?? 0
        // Queue it anyway while saves are pending, so the last note typed wins.
        if (note === saved && !pending) return done()
        saving.set(item.id, pending + 1)
        void save(note).then((ok) => {
          const left = (saving.get(item.id) ?? 1) - 1
          if (left > 0) saving.set(item.id, left)
          else saving.delete(item.id)
          if (ok) done()
        })
      }}
    />
  )
}

/** First row whose bottom edge is below `offset`. */
function rowAt(offsets: Float64Array, offset: number) {
  let low = 0,
    high = offsets.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if ((offsets[middle + 1] ?? 0) <= offset) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * Mounts rows within one viewport of the visible area, plus the focused row and
 * its neighbors so Tab order stays intact. Spacers hold the measured height of
 * the rest; they sit outside the list so native scroll anchoring keeps visible
 * rows still while new rows are measured.
 */
function WordList({
  words,
  row,
}: {
  words: readonly CustomWord[]
  row: (item: CustomWord) => ReactNode
}) {
  const frame = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const scroller = useRef<HTMLElement | null>(null)
  const heights = useRef(new Map<string | undefined, number>())
  const [measured, setMeasured] = useState(0)
  const [range, setRange] = useState({ from: 0, to: 0 })
  const [focused, setFocused] = useState<string>()
  const count = words.length
  // biome-ignore lint/correctness/useExhaustiveDependencies: `measured` counts changes to the height map.
  const offsets = useMemo(() => {
    const result = new Float64Array(count + 1)
    for (let index = 0; index < count; index++)
      result[index + 1] =
        (result[index] ?? 0) +
        (heights.current.get(words[index]?.id) ?? rowEstimate)
    return result
  }, [words, count, measured])
  const layout = useRef(offsets)
  layout.current = offsets
  const update = useCallback(() => {
    const element = list.current
    const origin = frame.current?.getBoundingClientRect().top
    if (!element || origin === undefined) return
    let changed = false
    for (const item of element.children) {
      if (!(item instanceof HTMLElement)) continue
      const height = item.getBoundingClientRect().height
      const known = heights.current.get(item.dataset.word)
      // Ignore subpixel rounding so measurements settle.
      if (!height || (known !== undefined && Math.abs(known - height) < 0.5))
        continue
      heights.current.set(item.dataset.word, height)
      changed = true
    }
    // New heights move later rows; the next render recomputes the window from them.
    if (changed) return setMeasured((value) => value + 1)
    const view = scroller.current?.getBoundingClientRect() ?? {
      top: 0,
      bottom: innerHeight,
    }
    const margin = view.bottom - view.top
    const latest = layout.current
    const from = rowAt(latest, view.top - origin - margin)
    const to = Math.min(
      latest.length - 1,
      rowAt(latest, view.bottom - origin + margin) + 1,
    )
    setRange((current) =>
      current.from === from && current.to === to ? current : { from, to },
    )
  }, [])
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    let node = element.parentElement
    while (node && !/auto|scroll/.test(getComputedStyle(node).overflowY))
      node = node.parentElement
    scroller.current = node
    const target = node ?? window
    // Zoom and width changes rewrap words: mounted rows are measured again, and
    // earlier heights stay as estimates for the rest.
    const resized = new ResizeObserver(update)
    resized.observe(element)
    target.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      resized.disconnect()
      target.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [update])
  // Every render can mount rows; equal heights and ranges stop here.
  useLayoutEffect(update)
  const indices = useMemo(
    () => new Map(words.map((item, index) => [item.id, index])),
    [words],
  )
  useLayoutEffect(() => {
    for (const id of heights.current.keys())
      if (!indices.has(id)) heights.current.delete(id)
  }, [indices])
  // The last committed list locates a focused word that was just removed. The
  // word that takes its place keeps the position, so Tab and Shift+Tab
  // continue from there.
  const committed = useRef(words)
  let at = indices.get(focused)
  if (at === undefined && focused !== undefined && count) {
    const before = committed.current
    const index = before.findIndex((item) => item.id === focused)
    if (index >= 0)
      at = Math.min(
        before.slice(0, index).filter((item) => indices.has(item.id)).length,
        count - 1,
      )
  }
  const anchor = at === undefined ? undefined : words[at]?.id
  useLayoutEffect(() => {
    committed.current = words
    if (anchor !== focused) setFocused(anchor)
  })
  useEffect(() => {
    // Leaving the window or deleting the focused row keeps the anchor; focus
    // moving to another control releases it.
    const moved = (event: FocusEvent) => {
      if (!list.current?.contains(event.target as Node)) setFocused(undefined)
    }
    document.addEventListener('focusin', moved)
    return () => document.removeEventListener('focusin', moved)
  }, [])
  const shown = new Set<number>()
  for (let index = range.from; index < Math.min(range.to, count); index++)
    shown.add(index)
  if (at !== undefined)
    for (
      let index = Math.max(0, at - 1);
      index <= Math.min(count - 1, at + 1);
      index++
    )
      shown.add(index)
  const rows = [...shown].sort((a, b) => a - b)
  const first = rows[0] ?? count
  const last = rows.at(-1) ?? count - 1
  return (
    <div ref={frame}>
      <div aria-hidden="true" style={{ height: offsets[first] }} />
      <ul
        ref={list}
        onFocus={(event) =>
          setFocused((event.target as HTMLElement).closest('li')?.dataset.word)
        }
      >
        {rows.map((index, position) => {
          const item = words[index]
          if (!item) return null
          const previous = rows[position - 1]
          const gap =
            previous === undefined
              ? 0
              : (offsets[index] ?? 0) - (offsets[previous + 1] ?? 0)
          return (
            <li
              key={item.id}
              className="setting-row"
              data-word={item.id}
              aria-posinset={index + 1}
              aria-setsize={count}
              style={gap ? { marginTop: gap } : undefined}
            >
              {row(item)}
            </li>
          )
        })}
      </ul>
      <div
        aria-hidden="true"
        style={{ height: (offsets[count] ?? 0) - (offsets[last + 1] ?? 0) }}
      />
    </div>
  )
}

export function CustomWords() {
  // Hidden discovery and search still register this section's setting rows.
  const visible = useContext(SettingsPageVisible)
  const words = useSyncExternalStore(onCustomWordsChanged, listCustomWords)
  // Typed notes outlive hidden pages and offscreen rows; only a save clears them.
  const [drafts, setDrafts] = useState<Drafts>(() => new Map())
  const saving = useRef(new Map<string | undefined, number>())
  const changeDraft = useCallback<ChangeDraft>(
    (id, change) =>
      setDrafts((current) => {
        const before = current.get(id)
        const after = change(before)
        if (after === before) return current
        const next = new Map(current)
        if (after) next.set(id, after)
        else next.delete(id)
        return next
      }),
    [],
  )
  // Confirmed removals take their unsaved notes and save counts with them.
  useEffect(() => {
    const live = new Set(words.map((item) => item.id))
    for (const id of saving.current.keys())
      if (!live.has(id)) saving.current.delete(id)
    setDrafts((current) =>
      [...current.keys()].every((id) => live.has(id))
        ? current
        : new Map([...current].filter(([id]) => live.has(id))),
    )
  }, [words])
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
            row={(item) => (
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
                  draft={drafts.get(item.id)}
                  changeDraft={changeDraft}
                  saving={saving.current}
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
