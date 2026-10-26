import {
  BookOpen,
  BookPlus,
  Download,
  Globe,
  LocateFixed,
  SearchX,
} from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from 'react'
import type { ViewTarget } from '../../shared/foundation-contracts'
import type { AddonContext } from '../api'
import { Button, IconButton, Panel, PanelMessage, TextInput } from '../ui'
import { addCustomWord } from './custom-words'
import { detectLangs, type LookupTarget, matchCase } from './lookup'
import type {
  DictionaryFailure,
  DictionaryRegistry,
  Gathered,
  Source,
} from './providers'
import { languageNames, readPreferences } from './settings'
import { lookUpSide, meaningGroups, type SideResult } from './side'

type Failure = { icon: ReactNode; title: string; message: string }
/** The caret word; replacing waits briefly for the editor to accept edits. */
type Target = Omit<LookupTarget, 'replace'> & {
  replace: (text: string) => Promise<boolean>
}
type Query = { word: string; online: boolean; found: Target | null }

/** Arrow keys move between the buttons of one word list. */
function rove(event: KeyboardEvent<HTMLElement>) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
    event.key
  ]
  if (!step) return
  const buttons = [...event.currentTarget.querySelectorAll('button')]
  const index = buttons.indexOf(event.target as HTMLButtonElement)
  if (index < 0) return
  event.preventDefault()
  buttons[(index + step + buttons.length) % buttons.length]?.focus()
}

function Chips({
  label,
  words,
  replacing,
  choose,
}: {
  label: string
  words: readonly string[]
  /** Choosing replaces the caret word instead of looking the choice up. */
  replacing: boolean
  choose: (word: string) => unknown
}) {
  const [all, setAll] = useState(false)
  if (!words.length) return null
  const shown = all ? words : words.slice(0, 12)
  return (
    <fieldset className="dictionary-side-chips" onKeyDown={rove}>
      <legend>{label}</legend>
      {shown.map((word) => (
        <Button
          key={word}
          variant="ghost"
          aria-label={
            replacing ? `Replace with “${word}”` : `Look up “${word}”`
          }
          onClick={() => choose(word)}
        >
          {word}
        </Button>
      ))}
      {shown.length < words.length && (
        <Button variant="ghost" onClick={() => setAll(true)}>
          {`Show all ${words.length}`}
        </Button>
      )}
    </fieldset>
  )
}

function Credit({ sources }: { sources: readonly Source[] }) {
  const unique = [
    ...new Map(
      sources.map((source) => [`${source.name}:${source.license}`, source]),
    ).values(),
  ]
  return (
    <p className="dictionary-source">
      {unique
        .map((source) =>
          [source.name, source.license].filter(Boolean).join(' · '),
        )
        .join('; ')}
    </p>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section className="dictionary-side-section" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  )
}

export function SideView({
  context,
  registry,
  target,
  failures,
  install,
}: {
  context: AddonContext
  registry: DictionaryRegistry
  target: (view: ViewTarget) => Promise<Target | null>
  failures: Record<DictionaryFailure, Failure>
  /** Resolves once the pack dialog closes. */
  install: () => Promise<unknown>
}) {
  const [follow, setFollow] = useState(true)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState<Query | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{
    word: string
    online: boolean
    value: SideResult | null
  } | null>(null)

  // The caret is read after it settles, and only offline answers are used.
  useEffect(() => {
    if (!follow) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let seq = 0
    const settle = () => {
      clearTimeout(timer)
      timer = setTimeout(async () => {
        const id = ++seq
        const view = context.editorViews.getActive()
        const found = view ? await target(view) : null
        // Leaving a word keeps the last one, as a thesaurus pane does.
        if (id !== seq || !found) return
        setQuery((previous) =>
          previous?.word === found.word
            ? { ...previous, found }
            : { word: found.word, online: false, found },
        )
      }, 250)
    }
    settle()
    const stop = context.editorViews.onDidChangeSelection(settle)
    return () => {
      stop()
      clearTimeout(timer)
      seq++
    }
  }, [follow, context, target])

  const word = query?.word
  const online = query?.online ?? false
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt reruns the lookup.
  useEffect(() => {
    if (!word) return
    const controller = new AbortController()
    const langs = detectLangs(word, readPreferences())
    setResult(null)
    if (!langs.length) {
      setResult({ word, online, value: null })
      return
    }
    void lookUpSide(registry, word, langs, online, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setResult({ word, online, value })
      },
      () => {},
    )
    return () => controller.abort()
  }, [registry, word, online, attempt])

  const lookUp = (next: string, nextOnline: boolean) => {
    setFollow(false)
    setQuery({ word: next, online: nextOnline, found: null })
  }
  const found = follow ? query?.found : null
  const choose = async (choice: string) => {
    if (!found || !word) {
      lookUp(choice, online)
      return
    }
    if (!(await found.replace(matchCase(word, choice))))
      context.notify('The document changed. Look up the word again.')
    found.focus()
  }
  const missing = (
    gathered: Gathered<unknown>,
    { emptyText: none, add = false }: { emptyText: string; add?: boolean },
  ) => {
    if (gathered.found.length) return null
    const failure = gathered.failure && failures[gathered.failure]
    const [installable] = gathered.installable
    return (
      <div className="dictionary-side-missing">
        {failure ? (
          <p role="alert">{`${failure.title}. ${failure.message}`}</p>
        ) : (
          <p>{online ? none : `${none} Online sources were not asked.`}</p>
        )}
        <div>
          {installable && (
            <Button
              onClick={async () => {
                await install()
                setAttempt((count) => count + 1)
              }}
            >
              <Download size={14} aria-hidden="true" />
              {`Install ${languageNames[installable]} pack`}
            </Button>
          )}
          {!online && (
            <Button onClick={() => word && lookUp(word, true)}>
              <Globe size={14} aria-hidden="true" />
              Look up online
            </Button>
          )}
          {failure && gathered.failure !== 'denied' && (
            <Button onClick={() => setAttempt(attempt + 1)}>Try again</Button>
          )}
          {add && word && (
            <Button
              onClick={() =>
                addCustomWord({ word })
                  .then(() => setAttempt((count) => count + 1))
                  .catch((error) =>
                    context.notify(
                      error instanceof Error
                        ? error.message
                        : 'Could not save custom words.',
                    ),
                  )
              }
            >
              <BookPlus size={14} aria-hidden="true" />
              Add to dictionary
            </Button>
          )}
        </div>
      </div>
    )
  }

  const current = result?.word === word && result?.online === online
  const value = current ? result?.value : null
  const entries = value?.definitions.found.flatMap((item) => item.value) ?? []
  const groups = word ? meaningGroups(entries, word) : []
  return (
    <Panel className="dictionary-side">
      <form
        className="dictionary-side-search"
        onSubmit={(event) => {
          event.preventDefault()
          const next = search.trim()
          if (next) lookUp(next, true)
        }}
      >
        <TextInput
          type="search"
          aria-label="Look up a word"
          placeholder="Look up a word…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || follow) return
            event.preventDefault()
            setSearch('')
            setFollow(true)
          }}
        />
        <IconButton
          aria-label="Follow the cursor"
          aria-pressed={follow}
          title="Follow the cursor"
          onClick={() => setFollow(!follow)}
        >
          <LocateFixed size={16} aria-hidden="true" />
        </IconButton>
      </form>
      {!word ? (
        <PanelMessage icon={<BookOpen size={24} />} title="No word selected">
          Place the cursor in a word to see its definition and synonyms, or
          search for any word.
        </PanelMessage>
      ) : !current ? (
        <PanelMessage
          icon={<BookOpen size={24} />}
          title={`Looking up “${word}”…`}
          loading
        />
      ) : !value ? (
        <PanelMessage icon={<SearchX size={24} />} title={word}>
          Lookups support English, Chinese, Cantonese, Japanese, Filipino, and
          French.
        </PanelMessage>
      ) : (
        <div className="dictionary-side-results">
          <header>
            <h2 lang={value.definitions.found[0]?.lang}>{word}</h2>
            <p>{follow ? 'At the cursor' : 'Search result'}</p>
          </header>
          <Section title="Definition">
            {missing(value.definitions, {
              emptyText: 'No definition found.',
              add: true,
            }) ??
              value.definitions.found.map(({ lang, value: items }) => (
                <div key={lang} className="dictionary-side-language">
                  {value.definitions.found.length > 1 && (
                    <h4>{languageNames[lang]}</h4>
                  )}
                  {items.map((entry, index) => (
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
                              <p className="dictionary-example">
                                {sense.example}
                              </p>
                            )}
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))}
                  <Credit sources={items.map((entry) => entry.source)} />
                </div>
              ))}
          </Section>
          <Section title="Thesaurus">
            {missing(value.thesaurus, { emptyText: 'No synonyms found.' }) ??
              value.thesaurus.found.map(({ lang, value: related }) => (
                <div key={lang} className="dictionary-side-language">
                  {value.thesaurus.found.length > 1 && (
                    <h4>{languageNames[lang]}</h4>
                  )}
                  <Chips
                    label="Synonyms"
                    words={related.synonyms}
                    replacing={!!found}
                    choose={choose}
                  />
                  <Chips
                    label="Antonyms"
                    words={related.antonyms}
                    replacing={!!found}
                    choose={choose}
                  />
                  <Credit sources={[related.source]} />
                </div>
              ))}
          </Section>
          {groups.length > 1 && (
            <Section title="By meaning">
              {groups.map((group) => (
                <Chips
                  key={group.label}
                  label={group.label}
                  words={group.words}
                  replacing={!!found}
                  choose={choose}
                />
              ))}
              <Credit sources={entries.map((entry) => entry.source)} />
            </Section>
          )}
        </div>
      )}
    </Panel>
  )
}
