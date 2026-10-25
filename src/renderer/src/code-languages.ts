import type { Language, StreamParser } from '@codemirror/language'
import type { Tree } from '@lezer/common'
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight'
import type { CodeLanguage } from '../../shared/syntax'

async function streamLanguage<T>(parser: StreamParser<T>) {
  const { StreamLanguage } = await import('@codemirror/language')
  return StreamLanguage.define(parser)
}

const builtin: CodeLanguage[] = [
  {
    id: 'javascript',
    aliases: ['js', 'mjs', 'cjs'],
    load: () =>
      import('@codemirror/lang-javascript').then(
        (m) => m.javascript().language,
      ),
  },
  {
    id: 'typescript',
    aliases: ['ts', 'mts', 'cts'],
    load: () =>
      import('@codemirror/lang-javascript').then(
        (m) => m.javascript({ typescript: true }).language,
      ),
  },
  {
    id: 'jsx',
    load: () =>
      import('@codemirror/lang-javascript').then(
        (m) => m.javascript({ jsx: true }).language,
      ),
  },
  {
    id: 'tsx',
    load: () =>
      import('@codemirror/lang-javascript').then(
        (m) => m.javascript({ typescript: true, jsx: true }).language,
      ),
  },
  {
    id: 'html',
    aliases: ['htm'],
    load: () => import('@codemirror/lang-html').then((m) => m.html().language),
  },
  {
    id: 'css',
    load: () => import('@codemirror/lang-css').then((m) => m.css().language),
  },
  {
    id: 'json',
    load: () => import('@codemirror/lang-json').then((m) => m.json().language),
  },
  {
    id: 'python',
    aliases: ['py'],
    load: () =>
      import('@codemirror/lang-python').then((m) => m.python().language),
  },
  {
    id: 'yaml',
    aliases: ['yml'],
    load: () => import('@codemirror/lang-yaml').then((m) => m.yaml().language),
  },
  {
    id: 'sql',
    aliases: ['mysql', 'postgresql', 'postgres', 'sqlite'],
    load: () => import('@codemirror/lang-sql').then((m) => m.sql().language),
  },
  {
    id: 'java',
    load: () => import('@codemirror/lang-java').then((m) => m.java().language),
  },
  {
    id: 'cpp',
    aliases: ['c', 'cc', 'c++', 'cxx', 'h', 'hpp'],
    load: () => import('@codemirror/lang-cpp').then((m) => m.cpp().language),
  },
  {
    id: 'rust',
    aliases: ['rs'],
    load: () => import('@codemirror/lang-rust').then((m) => m.rust().language),
  },
  {
    id: 'go',
    aliases: ['golang'],
    load: () => import('@codemirror/lang-go').then((m) => m.go().language),
  },
  {
    id: 'shell',
    aliases: ['sh', 'bash', 'zsh'],
    load: () =>
      import('@codemirror/legacy-modes/mode/shell').then((m) =>
        streamLanguage(m.shell),
      ),
  },
  {
    id: 'powershell',
    aliases: ['ps1'],
    load: () =>
      import('@codemirror/legacy-modes/mode/powershell').then((m) =>
        streamLanguage(m.powerShell),
      ),
  },
  {
    id: 'csharp',
    aliases: ['cs', 'c#'],
    load: () =>
      import('@codemirror/legacy-modes/mode/clike').then((m) =>
        streamLanguage(m.csharp),
      ),
  },
  {
    id: 'ruby',
    aliases: ['rb'],
    load: () =>
      import('@codemirror/legacy-modes/mode/ruby').then((m) =>
        streamLanguage(m.ruby),
      ),
  },
  {
    id: 'swift',
    load: () =>
      import('@codemirror/legacy-modes/mode/swift').then((m) =>
        streamLanguage(m.swift),
      ),
  },
  {
    id: 'toml',
    load: () =>
      import('@codemirror/legacy-modes/mode/toml').then((m) =>
        streamLanguage(m.toml),
      ),
  },
  {
    id: 'dockerfile',
    aliases: ['docker'],
    load: () =>
      import('@codemirror/legacy-modes/mode/dockerfile').then((m) =>
        streamLanguage(m.dockerFile),
      ),
  },
]
const loaded = new WeakMap<CodeLanguage, Language>()
const pending = new Map<CodeLanguage, Promise<Language | null>>()
const failed = new WeakSet<CodeLanguage>()
const registered = new Map<string, CodeLanguage>()
const listeners = new Set<(changed: ReadonlySet<string>) => void>()
let version = 0
let languages = new Map<string, Language>()
/** Each lowercase name's parser, definition still to load, or null while disabled. */
let resolution = new Map<string, unknown>()
let definitions = new Map<string, CodeLanguage>()
let aliases = new Map<string, string>()
let catalog: readonly {
  id: string
  aliases: readonly string[]
  owner: string
  enabled: boolean
}[] = []
const disabled = new Set<string>()
try {
  const saved: unknown = JSON.parse(
    localStorage.getItem('hibi:code-syntax-disabled') ?? '[]',
  )
  if (Array.isArray(saved))
    for (const id of saved) if (typeof id === 'string') disabled.add(id)
} catch {
  /* Keep all languages enabled when preferences are unavailable. */
}
function publish() {
  languages = new Map()
  definitions = new Map()
  aliases = new Map()
  const entries = new Map<string, (typeof catalog)[number]>()
  const entriesWithOwner = [
    ...builtin.map((entry) => ({
      entry,
      owner: 'built-in',
    })),
    ...[...registered].map(([key, entry]) => ({
      entry,
      owner: key.slice(0, key.length - entry.id.length - 1),
    })),
  ]
  for (const { entry, owner } of entriesWithOwner) {
    const language = entry.language ?? loaded.get(entry)
    definitions.set(entry.id.toLowerCase(), entry)
    languages.delete(entry.id.toLowerCase())
    if (language) languages.set(entry.id.toLowerCase(), language)
    entries.set(entry.id.toLowerCase(), {
      id: entry.id.toLowerCase(),
      aliases: [],
      owner,
      enabled: !disabled.has(entry.id.toLowerCase()),
    })
    for (const name of [entry.id, ...(entry.aliases ?? [])])
      aliases.set(name.toLowerCase(), entry.id.toLowerCase())
  }
  catalog = [...entries.values()].map((entry) => ({
    ...entry,
    aliases: [...aliases]
      .filter(([alias, id]) => id === entry.id && alias !== entry.id)
      .map(([alias]) => alias),
  }))
  const next = new Map<string, unknown>()
  for (const [alias, id] of aliases)
    next.set(
      alias,
      disabled.has(id) ? null : (languages.get(id) ?? definitions.get(id)),
    )
  // Highlighters refresh only names whose parser or availability changed, including aliases.
  const changed = new Set<string>()
  for (const name of new Set([...resolution.keys(), ...next.keys()]))
    if (resolution.get(name) !== next.get(name)) changed.add(name)
  resolution = next
  version++
  for (const listener of listeners) listener(changed)
}
publish()
function savePreferences() {
  try {
    localStorage.setItem(
      'hibi:code-syntax-disabled',
      JSON.stringify([...disabled]),
    )
  } catch {
    /* Session preferences still apply. */
  }
  publish()
}
/** Lowercase language name from a fence's info string. */
export const codeLanguageKey = (info: string) =>
  info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
export const codeLanguages = {
  version: () => version,
  snapshot: () => catalog,
  setEnabled(id: string, enabled: boolean) {
    if (
      !catalog.some((entry) => entry.id === id) ||
      enabled === !disabled.has(id)
    )
      return
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    savePreferences()
  },
  reset() {
    disabled.clear()
    savePreferences()
  },
  resolve(info: string) {
    const id = aliases.get(codeLanguageKey(info)) ?? ''
    if (disabled.has(id)) return null
    const language = languages.get(id)
    if (!language) void codeLanguages.ensure(id)
    return language ?? null
  },
  async ensure(info: string): Promise<Language | null> {
    const id = aliases.get(codeLanguageKey(info)) ?? ''
    const definition = definitions.get(id)
    if (disabled.has(id) || !definition || failed.has(definition)) return null
    if (languages.has(id)) return languages.get(id) ?? null
    if (!definition.load) return null
    let loading = pending.get(definition)
    if (!loading) {
      loading = Promise.resolve()
        .then(() => definition.load!())
        .then((language) => {
          if (!validLanguage(language))
            throw new Error('invalid code language.')
          loaded.set(definition, language)
          if (definitions.get(id) !== definition) return null
          publish()
          return disabled.has(id) ? null : language
        })
        .catch((error: unknown) => {
          failed.add(definition)
          console.error(`Could not load code language: ${id}`, error)
          return null
        })
        .finally(() => pending.delete(definition))
      pending.set(definition, loading)
    }
    return loading
  },
  async settle() {
    await Promise.all(pending.values())
  },
  retry(info: string) {
    const id = aliases.get(codeLanguageKey(info)) ?? ''
    const definition = definitions.get(id)
    if (!definition || disabled.has(id)) return Promise.resolve(null)
    failed.delete(definition)
    const loading = codeLanguages.ensure(id)
    publish()
    return loading
  },
  /** Listeners receive the lowercase names whose parser or availability changed. */
  subscribe(listener: (changed: ReadonlySet<string>) => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  register(owner: string, entry: CodeLanguage) {
    const key = `${owner}.${entry.id}`
    if (
      registered.has(key) ||
      [entry.id, ...(entry.aliases ?? [])].some(
        (name) =>
          typeof name !== 'string' || !/^[a-z][a-z0-9_+#.-]*$/i.test(name),
      ) ||
      !(
        (typeof entry.load === 'function' && entry.language === undefined) ||
        (entry.load === undefined && validLanguage(entry.language))
      )
    )
      throw new Error('invalid or duplicate code language.')
    const contribution = { ...entry }
    registered.set(key, contribution)
    publish()
    return () => {
      if (registered.get(key) !== contribution) return
      registered.delete(key)
      publish()
    }
  },
}

function validLanguage(language: Language | undefined): language is Language {
  return (
    typeof language?.parser?.parse === 'function' &&
    typeof language?.parser?.startParse === 'function'
  )
}

export const codeHighlighter = tagHighlighter([
  {
    tag: [tags.keyword, tags.modifier, tags.null, tags.processingInstruction],
    class: 'hibi-token-keyword',
  },
  { tag: [tags.string, tags.regexp, tags.escape], class: 'hibi-token-string' },
  { tag: [tags.number, tags.bool, tags.atom], class: 'hibi-token-number' },
  { tag: tags.comment, class: 'hibi-token-comment' },
  {
    tag: [tags.typeName, tags.className, tags.namespace, tags.tagName],
    class: 'hibi-token-type',
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    class: 'hibi-token-function',
  },
  {
    tag: [tags.variableName, tags.propertyName, tags.attributeName],
    class: 'hibi-token-variable',
  },
  { tag: [tags.operator, tags.punctuation], class: 'hibi-token-operator' },
])
export type CodeSpan = { from: number; to: number; classes: string }
/** Token classes for a parsed range; `to` may stop inside a partial tree. */
export function codeSpans(tree: Tree, from?: number, to?: number) {
  const spans: CodeSpan[] = []
  highlightTree(
    tree,
    codeHighlighter,
    (from, to, classes) => spans.push({ from, to, classes }),
    from,
    to,
  )
  return spans
}
export function highlightCode(text: string, info: string): CodeSpan[] {
  const language = codeLanguages.resolve(info)
  if (!language) return []
  try {
    return codeSpans(language.parser.parse(text))
  } catch (error) {
    console.error(`code highlighting failed: ${info}`, error)
    return []
  }
}
export function escapeCode(text: string) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
export function codeHtml(text: string, info: string) {
  let offset = 0,
    result = ''
  for (const span of highlightCode(text, info)) {
    result +=
      escapeCode(text.slice(offset, span.from)) +
      `<span class="${span.classes}">${escapeCode(text.slice(span.from, span.to))}</span>`
    offset = span.to
  }
  return result + escapeCode(text.slice(offset))
}
