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
import type { IndexedCustomWords } from './custom-word-storage'
import {
  addCustomWord,
  type CustomWord,
  customWordsFailure,
  customWordsFileIo,
  customWordsView,
  editCustomWord,
  exportSavedCustomWords,
  importSavedCustomWords,
  onCustomWordsChanged,
  removeCustomWord,
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
function rowAt(count: number, edge: (index: number) => number, offset: number) {
  let low = 0,
    high = count
  while (low < high) {
    const middle = (low + high) >> 1
    if (edge(middle + 1) <= offset) low = middle + 1
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
  paged,
  revision,
  version,
  row,
}: {
  paged: IndexedCustomWords
  revision: number
  version: number
  row: (item: CustomWord) => ReactNode
}) {
  const frame = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const scroller = useRef<HTMLElement | null>(null)
  const heights = useRef(new Map<string | undefined, number>())
  const [measured, setMeasured] = useState(0)
  const [range, setRange] = useState({ from: 0, to: 0 })
  const [focused, setFocused] = useState<string>()
  // Browser scroll heights are finite; every window remains reachable by page.
  const [selectedPage, setPage] = useState(0)
  const total = paged.snapshot().count
  const pages = Math.max(1, Math.ceil(total / 10000))
  const page = Math.min(selectedPage, pages - 1)
  const base = page * 10000
  const count = Math.min(10000, total - base)
  const previousPage = useRef(page)
  useLayoutEffect(() => {
    if (previousPage.current === page) return
    previousPage.current = page
    setFocused(undefined)
    setRange({ from: 0, to: 0 })
    frame.current?.scrollIntoView({ block: 'start' })
  }, [page])
  const get = (index: number) => paged.at(base + index)
  // A native cache version changes only when its loaded rows change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version invalidates the bounded native index.
  const position = useMemo(
    () => (id: string | undefined) => paged.indexOf(id),
    [paged, version],
  )
  // Prefix sums contain measured rows only, never one entry for every saved word.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured invalidates the height map.
  const edge = useMemo(() => {
    const changes = [...heights.current]
      .flatMap(([id, height]) => {
        const index = position(id)
        return index !== undefined && index >= base && index < base + count
          ? [{ index: index - base, extra: height - rowEstimate }]
          : []
      })
      .sort((a, b) => a.index - b.index)
    const sums = [0]
    for (const change of changes) sums.push((sums.at(-1) ?? 0) + change.extra)
    return (index: number) => {
      let low = 0,
        high = changes.length
      while (low < high) {
        const middle = (low + high) >> 1
        if ((changes[middle]?.index ?? Infinity) < index) low = middle + 1
        else high = middle
      }
      return index * rowEstimate + (sums[low] ?? 0)
    }
  }, [position, base, count, measured])
  const layout = useRef({ edge, count })
  layout.current = { edge, count }
  const update = useCallback(() => {
    const element = list.current
    const origin = frame.current?.getBoundingClientRect().top
    if (!element || origin === undefined) return
    let changed = false
    for (const item of element.children) {
      if (!(item instanceof HTMLElement) || !item.dataset.word) continue
      const height = item.getBoundingClientRect().height
      const known = heights.current.get(item.dataset.word)
      if (!height || (known !== undefined && Math.abs(known - height) < 0.5))
        continue
      heights.current.set(item.dataset.word, height)
      changed = true
    }
    if (changed) return setMeasured((value) => value + 1)
    const view = scroller.current?.getBoundingClientRect() ?? {
      top: 0,
      bottom: innerHeight,
    }
    const margin = view.bottom - view.top
    const latest = layout.current
    const from = rowAt(latest.count, latest.edge, view.top - origin - margin)
    const to = Math.min(
      latest.count,
      rowAt(latest.count, latest.edge, view.bottom - origin + margin) + 1,
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
  useLayoutEffect(update)
  useLayoutEffect(() => {
    for (const id of heights.current.keys())
      if (position(id) === undefined) heights.current.delete(id)
  }, [position])
  const previousFocus = useRef<{ id: string; index: number } | undefined>(
    undefined,
  )
  const found = position(focused)
  let at =
    found === undefined || found < base || found >= base + count
      ? undefined
      : found - base
  if (
    at === undefined &&
    focused !== undefined &&
    count &&
    previousFocus.current?.id === focused
  )
    at = Math.max(0, Math.min(previousFocus.current.index - base, count - 1))
  const anchor = at === undefined ? undefined : (get(at)?.id ?? focused)
  useLayoutEffect(() => {
    if (anchor && at !== undefined)
      previousFocus.current = { id: anchor, index: base + at }
    if (anchor !== focused) setFocused(anchor)
  })
  useEffect(() => {
    if (paged.snapshot().revision !== revision) return
    const ranges = [{ from: base + range.from, to: base + range.to }]
    if (at !== undefined)
      ranges.push({
        from: base + Math.max(0, at - 1),
        to: base + Math.min(count, at + 2),
      })
    void paged.ensure(ranges)
  }, [paged, revision, base, range.from, range.to, at, count])
  useEffect(() => {
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
    <>
      {pages > 1 && (
        <nav className="dictionary-word-pages" aria-label="Custom word pages">
          <Button
            aria-label="Previous words"
            disabled={!page}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </Button>
          <TextInput
            type="number"
            aria-label="Word list page"
            min={1}
            max={pages}
            value={page + 1}
            onChange={(event) =>
              setPage(
                Math.max(
                  0,
                  Math.min(
                    pages - 1,
                    Math.trunc(Number(event.target.value) || 1) - 1,
                  ),
                ),
              )
            }
          />
          <span className="setting-description">{`Page ${page + 1} of ${pages}`}</span>
          <Button
            aria-label="Next words"
            disabled={page + 1 === pages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </nav>
      )}
      <div ref={frame}>
        <div aria-hidden="true" style={{ height: edge(first) }} />
        <ul
          ref={list}
          onFocus={(event) =>
            setFocused(
              (event.target as HTMLElement).closest('li')?.dataset.word,
            )
          }
        >
          {rows.map((index, position) => {
            const item = get(index)
            const previous = rows[position - 1]
            const gap =
              previous === undefined ? 0 : edge(index) - edge(previous + 1)
            if (!item)
              return (
                <li
                  key={`loading-${index}`}
                  aria-hidden="true"
                  style={{ height: rowEstimate, marginTop: gap }}
                />
              )
            return (
              <li
                key={item.id}
                className="setting-row"
                data-word={item.id}
                aria-posinset={base + index + 1}
                aria-setsize={total}
                style={gap ? { marginTop: gap } : undefined}
              >
                {row(item)}
              </li>
            )
          })}
        </ul>
        <div
          aria-hidden="true"
          style={{ height: edge(count) - edge(last + 1) }}
        />
      </div>
    </>
  )
}

export function CustomWords() {
  // Hidden discovery and search still register this section's setting rows.
  const visible = useContext(SettingsPageVisible)
  const view = useSyncExternalStore(onCustomWordsChanged, customWordsView)
  const { indexed, count } = view
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: check drafts on saved revisions, never on every keystroke.
  useEffect(() => {
    if (indexed) {
      let active = true
      const ids = new Set([...saving.current.keys(), ...drafts.keys()])
      void Promise.all(
        [...ids].map(async (id) => {
          if (!id || (await indexed.get(id)).word) return
          if (!active) return
          saving.current.delete(id)
          changeDraft(id, () => undefined)
        }),
      ).catch(() => {})
      return () => {
        active = false
      }
    }
  }, [indexed, view.revision, changeDraft])
  const [draft, setDraft] = useState('')
  const [text, setText] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const merge = (source: string) =>
    importSavedCustomWords(source).then((count) => {
      if (count)
        setMessage(
          count === 1 ? 'Imported 1 word.' : `Imported ${count} words.`,
        )
      return count
    })
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
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button type="submit" disabled={!draft.trim()}>
              Add
            </Button>
          </form>
        </SettingRow>
        {!visible ? null : count && indexed ? (
          <WordList
            paged={indexed}
            revision={view.revision}
            version={view.version}
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
                    removeCustomWord(item)
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
            const source = text
            merge(source)
              .then((count) => {
                if (count)
                  setText((current) => (current === source ? '' : current))
                else setMessage('No words were found in the text.')
              })
              .catch((error) => setMessage(failed(error)))
          }}
        >
          Import text
        </Button>
        <Button
          disabled={busy || !count}
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
              let source: string
              try {
                source = utf8.decode(read.value)
              } catch {
                throw new Error('Choose a text file saved as UTF-8.')
              }
              if (!(await merge(source)))
                setMessage('No words were found in the file.')
            })
          }
        >
          Import from file…
        </Button>
      </div>
      {indexed?.snapshot().notice && (
        <div className="dictionary-word-notice">
          <p role="status" className="setting-description">
            {indexed.snapshot().notice}
          </p>
          <Button
            variant="ghost"
            onClick={() =>
              void indexed
                .dismissNotice()
                .catch((error) => setMessage(failed(error)))
            }
          >
            Dismiss
          </Button>
        </div>
      )}
      {(message || customWordsFailure()) && (
        <p role="status" className="setting-description">
          {message || customWordsFailure()}
        </p>
      )}
    </section>
  )
}
