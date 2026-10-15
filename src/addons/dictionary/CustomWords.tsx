import { useRef, useState, useSyncExternalStore } from 'react'
import type { HostSelectedIoHostApi } from '../../shared/host-selected-io'
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

/** Shows the saved note until the user types; only a changed note is saved, and the typed one stays if saving fails. */
function NoteInput({
  item,
  save,
}: {
  item: CustomWord
  save: (note: string) => Promise<boolean>
}) {
  const saved = item.note ?? ''
  // One object per keystroke, so a finished save clears only the text it saved.
  const [draft, setDraft] = useState<{ text: string } | null>(null)
  const saving = useRef(0)
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

export function CustomWords() {
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
        {words.length ? (
          <ul>
            {words.map((item) => (
              <li key={item.id} className="setting-row">
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
              </li>
            ))}
          </ul>
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
