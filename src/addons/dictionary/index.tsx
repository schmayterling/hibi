import type { EditorView } from '@codemirror/view'
import type { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { TextSelection } from '@tiptap/pm/state'
import {
  Ban,
  BookOpen,
  Download,
  Hourglass,
  SearchX,
  WifiOff,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  CommandExecutionContext,
  ViewId,
  ViewTarget,
} from '../../shared/foundation-contracts'
import { defineAddon } from '../api'
import { Button, PanelMessage } from '../ui'
import { createDictionaryApi, type DictionaryApi } from './api'
import {
  addCustomWord,
  customWordsProvider,
  listCustomWords,
  openCustomWords,
} from './custom-words'
import css from './dictionary.css?inline'
import { detectLangs, type LookupTarget, matchCase, wordAt } from './lookup'
import manifest from './manifest'
import { createOfflineProviders } from './offline'
import { datamuseProvider, wiktionaryProvider } from './online'
import { PackSettings } from './PackSettings'
import {
  createRegistry,
  type Entry,
  type Gathered,
  gather,
  INSTALL_PACK_COMMAND,
  type Related,
  type Source,
} from './providers'
import { SideView } from './SideView'
import { languageNames, readPreferences } from './settings'
import sideCss from './side-view.css?inline'

function richTarget(
  editor: Editor,
  from: number,
  to: number,
): LookupTarget | null {
  const { doc } = editor.state
  const $from = doc.resolve(from)
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null
  if (to > $from.end()) return null
  const base = $from.start()
  const found = wordAt(
    $from.parent.textBetween(0, $from.parent.content.size, undefined, '￼'),
    from - base,
    to - base,
    readPreferences(),
  )
  if (!found) return null
  const range = { from: base + found.from, to: base + found.to }
  if (doc.textBetween(range.from, range.to) !== found.word) return null
  return {
    word: found.word,
    editable: () => !editor.isDestroyed && editor.isEditable,
    replace(text) {
      if (editor.isDestroyed || editor.state.doc !== doc) return false
      const tr = closeHistory(editor.state.tr).insertText(
        text,
        range.from,
        range.to,
      )
      tr.setSelection(TextSelection.create(tr.doc, range.from + text.length))
      editor.view.dispatch(tr)
      // Read-only editors drop document changes without throwing.
      const after = editor.state.doc
      const end = range.from + text.length
      if (
        after === doc ||
        end > after.content.size ||
        after.textBetween(range.from, end) !== text
      )
        return false
      editor.view.dispatch(closeHistory(editor.state.tr))
      return true
    },
    focus: () => {
      if (!editor.isDestroyed) editor.view.focus()
    },
  }
}

const failures = {
  offline: {
    icon: <WifiOff size={28} />,
    title: 'Could not reach the service',
    message: 'Check your internet connection, then try again.',
  },
  'rate-limited': {
    icon: <Hourglass size={28} />,
    title: 'Too many lookups',
    message: 'The service is limiting requests. Wait a minute, then try again.',
  },
  unavailable: {
    icon: <SearchX size={28} />,
    title: 'Service unavailable',
    message: 'The service did not return a usable answer. Try again later.',
  },
  denied: {
    icon: <Ban size={28} />,
    title: 'Lookup not allowed',
    message:
      'The blocked request was not sent. Run the command again and allow it to look up this word.',
  },
  'not-installed': {
    icon: <Download size={28} />,
    title: 'Offline pack not installed',
    message: 'Install the offline pack for this language, then try again.',
  },
}

// `message` fields are collected into the UI copy catalog.
const notices = {
  noWord: { message: 'Place the cursor in a word or select one word.' },
  unsupported: {
    message:
      'Lookups support English, Chinese, Cantonese, Japanese, Filipino, French, and German.',
  },
  noPacks: { message: 'Offline packs are not available yet.' },
  changed: { message: 'The document changed. Look up the word again.' },
}

/** Saves a word with no entry so later lookups and suggestions know it. */
function AddWord({ word, added }: { word: string; added: () => void }) {
  const [error, setError] = useState('')
  return (
    <>
      <Button
        onClick={() =>
          addCustomWord({ word }).then(added, (failure) =>
            setError(
              failure instanceof Error
                ? failure.message
                : 'Could not save custom words.',
            ),
          )
        }
      >
        Add to dictionary
      </Button>
      {error && <p role="alert">{error}</p>}
    </>
  )
}

function Words({
  label,
  words,
  choose,
}: {
  label: string
  words: readonly string[]
  choose: (word: string) => void
}) {
  if (!words.length) return null
  return (
    <section className="dictionary-words" aria-label={label}>
      <h4>{label}</h4>
      <div>
        {words.map((word) => (
          <Button key={word} variant="ghost" onClick={() => choose(word)}>
            {word}
          </Button>
        ))}
      </div>
    </section>
  )
}

const credit = (source: Source) => (
  <p className="dictionary-source">
    {[source.name, source.license].filter(Boolean).join(' · ')}
  </p>
)

type Outcome = Gathered<Entry[]> | Gathered<Related>

function Results({
  word,
  kind,
  load,
  choose,
  install,
  dismissed,
}: {
  word: string
  kind: 'define' | 'synonyms'
  load: (signal: AbortSignal) => Promise<Outcome>
  choose: (word: string) => void
  install: () => void
  dismissed: AbortSignal
}) {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<Outcome | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt reruns the lookup.
  useEffect(() => {
    const controller = new AbortController()
    // Dismissal aborts before the exit animation unmounts the results.
    const signal = AbortSignal.any([controller.signal, dismissed])
    setResult(null)
    void load(signal).then((value) => {
      if (!signal.aborted) setResult(value)
    })
    return () => controller.abort()
  }, [load, attempt, dismissed])
  if (!result)
    return (
      <PanelMessage
        icon={<BookOpen size={28} />}
        title={`Looking up “${word}”…`}
        loading
      />
    )
  if (!result.found.length) {
    if (result.failure) {
      const failure = failures[result.failure]
      return (
        <div className="dictionary-results">
          <PanelMessage icon={failure.icon} title={failure.title} role="alert">
            {failure.message}
          </PanelMessage>
          {result.failure !== 'denied' && (
            <Button onClick={() => setAttempt(attempt + 1)}>Try again</Button>
          )}
        </div>
      )
    }
    const [missing] = result.installable
    if (missing)
      return (
        <div className="dictionary-results">
          <PanelMessage
            icon={<Download size={28} />}
            title={`${languageNames[missing]} needs an offline pack`}
          >
            {kind === 'define'
              ? 'Install an offline pack to look up words in this language.'
              : 'Install an offline pack to find synonyms in this language.'}
          </PanelMessage>
          <Button onClick={install}>Install offline pack</Button>
          {kind === 'define' && (
            <AddWord word={word} added={() => setAttempt(attempt + 1)} />
          )}
        </div>
      )
    return (
      <div className="dictionary-results">
        <PanelMessage
          icon={<SearchX size={28} />}
          title={
            kind === 'define' ? 'No definitions found' : 'No synonyms found'
          }
        >
          {`Nothing was found for “${word}”. Check the spelling or try another form of the word.`}
        </PanelMessage>
        {kind === 'define' && (
          <AddWord word={word} added={() => setAttempt(attempt + 1)} />
        )}
      </div>
    )
  }
  const shown = new Set<string>()
  return (
    <div className="dictionary-results">
      {result.found.map(({ lang, value }) => {
        if (!Array.isArray(value))
          return (
            <section key={lang} aria-label={languageNames[lang]}>
              <h3>{languageNames[lang]}</h3>
              <Words label="Synonyms" words={value.synonyms} choose={choose} />
              <Words label="Antonyms" words={value.antonyms} choose={choose} />
              {credit(value.source)}
            </section>
          )
        // Cantonese can share Wiktionary's Chinese entries; show them once.
        const key = (entry: Entry) => `${entry.source.name}:${entry.lang}`
        const entries = value.filter((entry) => !shown.has(key(entry)))
        for (const entry of entries) shown.add(key(entry))
        const [first] = entries
        if (!first) return null
        return (
          <section key={lang} aria-label={languageNames[first.lang]}>
            <h3>{languageNames[first.lang]}</h3>
            {entries.map((entry, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: entries are static per lookup.
                key={index}
                className="dictionary-meaning"
              >
                {(entry.partOfSpeech || entry.reading) && (
                  <h4>
                    {[entry.partOfSpeech, entry.reading]
                      .filter(Boolean)
                      .join(' · ')}
                  </h4>
                )}
                <ol>
                  {entry.senses.map((sense) => (
                    <li key={sense.gloss}>
                      {sense.gloss}
                      {sense.example && (
                        <p className="dictionary-example">{sense.example}</p>
                      )}
                    </li>
                  ))}
                </ol>
                <Words
                  label="Synonyms"
                  words={entry.synonyms ?? []}
                  choose={choose}
                />
                {credit(entry.source)}
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}

let stopAddon: (() => void) | undefined
export default defineAddon({
  manifest,
  stop: () => stopAddon?.(),
  start(context) {
    context.styles.register('dictionary', css)
    const registry = createRegistry()
    registry.register(wiktionaryProvider(context.host.network.getText))
    registry.register(datamuseProvider(context.host.network.getText))
    for (const provider of createOfflineProviders(context.native))
      registry.register(provider)
    // After the packs, so a pack entry for the same word is shown first.
    registry.register(
      customWordsProvider((term) => detectLangs(term, readPreferences())[0]),
    )
    const closeWords = openCustomWords(context).catch((error) => {
      console.error('could not load custom words:', error)
      return undefined
    })
    context.commands.register({
      id: INSTALL_PACK_COMMAND,
      label: 'Dictionary: install offline pack',
      keywords: 'dictionary language download offline',
      // Resolves when the dialog closes, so callers can look up again.
      run: async () => {
        await context.dialogs.open({
          title: 'Offline language packs',
          size: 'wide',
          content: () => <PackSettings />,
        }).result
      },
    })
    const richEditors = new Map<Editor, ViewId>()
    const sourceViews = new Map<EditorView, ViewId>()
    context.editor.registerRich({
      id: 'lookup',
      attach(editor, editorContext) {
        if (!editorContext) return () => {}
        richEditors.set(editor, editorContext.viewId)
        return () => richEditors.delete(editor)
      },
    })
    context.editor.registerSource({
      id: 'lookup',
      async create(editorContext) {
        if (!editorContext) return []
        return (await import('./source')).trackSourceViews(
          sourceViews,
          editorContext.viewId,
        )
      },
    })
    async function target(invocation: CommandExecutionContext) {
      // Palette and shortcut invocations capture the view but not its selection.
      const view = invocation.view ?? context.editorViews.getActive()
      if (!view) return null
      const active = context.editorViews.getSelection(view)
      const selection =
        invocation.selection ?? (active.ok ? active.value : null)
      if (!selection) return null
      const from = Math.min(selection.anchor, selection.head)
      const to = Math.max(selection.anchor, selection.head)
      const at = (viewId: ViewId, anchor: number, head: number) =>
        viewId === view.viewId &&
        anchor === selection.anchor &&
        head === selection.head
      let found: LookupTarget | null = null
      let inView = () => false
      if (selection.editor === 'rich') {
        const editor = [...richEditors].find(
          ([editor, viewId]) =>
            !editor.isDestroyed &&
            at(
              viewId,
              editor.state.selection.anchor,
              editor.state.selection.head,
            ),
        )?.[0]
        if (editor) {
          found = richTarget(editor, from, to)
          inView = () => richEditors.get(editor) === view.viewId
        }
      } else {
        const { sourceTarget } = await import('./source')
        const editor = [...sourceViews].find(([editor, viewId]) =>
          at(
            viewId,
            editor.state.selection.main.anchor,
            editor.state.selection.main.head,
          ),
        )?.[0]
        if (editor) {
          found = sourceTarget(editor, from, to)
          inView = () => sourceViews.get(editor) === view.viewId
        }
      }
      if (!found) return null
      const { editable, replace } = found
      return {
        ...found,
        // Restoring focus after the dialog can switch split panes, which
        // leaves the captured editor read-only for a moment.
        replace: async (text: string) => {
          for (const deadline = performance.now() + 2000; ; ) {
            if (editable()) {
              // getSelection fails once the view, document, or its generation changes.
              const current = context.editorViews.getSelection(view)
              if (
                !current.ok ||
                current.value.editor !== selection.editor ||
                !inView()
              )
                return false
              if (replace(text)) return true
              if (editable()) return false
            }
            if (!inView() || performance.now() > deadline) return false
            await new Promise((resolve) => setTimeout(resolve, 16))
          }
        },
      }
    }
    async function lookUp(
      invocation: CommandExecutionContext,
      kind: 'define' | 'synonyms',
    ) {
      const found = await target(invocation)
      if (!found) {
        context.notify(notices.noWord.message)
        return
      }
      const { word } = found
      const langs = detectLangs(word, readPreferences())
      if (!langs.length) {
        context.notify(notices.unsupported.message)
        found.focus()
        return
      }
      const load = (signal: AbortSignal): Promise<Outcome> =>
        kind === 'define'
          ? gather(registry, langs, 'lookup', (provider, lang, cachedOnly) =>
              provider.lookup(word, lang, signal, cachedOnly),
            )
          : gather(
              registry,
              langs,
              'related',
              async (provider, lang, cachedOnly) =>
                cachedOnly
                  ? null
                  : (provider.related?.(word, lang, signal) ?? null),
            )
      const choice = await context.dialogs.open<string>({
        title:
          kind === 'define' ? `Define “${word}”` : `Synonyms for “${word}”`,
        content: ({ close, signal }) => (
          <Results
            word={word}
            kind={kind}
            load={load}
            dismissed={signal}
            choose={close}
            install={() => {
              close(null)
              void context.commands
                .execute(INSTALL_PACK_COMMAND)
                .catch(() => context.notify(notices.noPacks.message))
            }}
          />
        ),
      }).result
      if (choice && !(await found.replace(matchCase(word, choice))))
        context.notify(notices.changed.message)
      found.focus()
    }
    context.commands.register({
      id: 'define',
      label: 'Define word',
      keywords: 'dictionary definition meaning look up',
      menu: { location: 'editor', group: 'dictionary', order: 1 },
      run: (invocation) => lookUp(invocation, 'define'),
    })
    context.commands.register({
      id: 'add-word',
      label: 'Add word to dictionary',
      keywords: 'dictionary custom word add own spelling',
      menu: { location: 'editor', group: 'dictionary', order: 3 },
      run: async (invocation) => {
        const found = await target(invocation)
        if (!found) {
          context.notify(notices.noWord.message)
          return
        }
        try {
          await addCustomWord({ word: found.word })
          context.notify(`Added “${found.word}” to your dictionary.`)
        } catch (error) {
          context.notify(
            error instanceof Error
              ? error.message
              : 'Could not save custom words.',
          )
        }
        found.focus()
      },
    })
    context.commands.register({
      id: 'synonyms',
      label: 'Find synonyms',
      keywords: 'thesaurus synonym antonym replace word',
      defaultShortcut: 'shift+f7',
      menu: { location: 'editor', group: 'dictionary', order: 2 },
      run: (invocation) => lookUp(invocation, 'synonyms'),
    })
    context.styles.register('dictionary-side', sideCss)
    const sideTarget = (view: ViewTarget) => target({ source: 'api', view })
    const side = context.sidebar.register({
      id: 'side',
      label: 'Dictionary',
      icon: BookOpen,
      side: 'right',
      Content: () => (
        <SideView
          context={context}
          registry={registry}
          target={sideTarget}
          failures={failures}
          install={() =>
            context.commands
              .execute(INSTALL_PACK_COMMAND)
              .catch(() => context.notify(notices.noPacks.message))
          }
        />
      ),
    })
    context.commands.register({
      id: 'side-view',
      label: 'Open dictionary side view',
      keywords: 'dictionary thesaurus sidebar panel definition synonyms',
      run: () => side.open(),
    })
    context.exports.provide<DictionaryApi>(
      createDictionaryApi(
        context.native,
        () => detectLangs('word', readPreferences()),
        listCustomWords,
      ),
    )
    stopAddon = () => {
      void closeWords.then((close) => close?.())
    }
  },
})
