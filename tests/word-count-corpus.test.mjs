import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { getSchema, getText, getTextSerializersFromSchema } from '@tiptap/core'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import { Strike } from '@tiptap/extension-strike'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import { MarkdownManager } from '@tiptap/markdown'
import { markedGithubFootnote } from 'marked-github-footnote'
import { alertMarkdown, alertMarker } from '../src/addons/markdown/alerts.ts'
import { GithubAlert } from '../src/addons/markdown/GithubAlert.ts'
import {
  ObsidianHighlight,
  obsidianMarkdown,
  WikiEmbed,
  WikiLink,
} from '../src/addons/markdown/obsidian.ts'
import { NativeTableKit } from '../src/addons/markdown/table-tokenizer.ts'
import {
  blockMath,
  blockMathStart,
  inlineMath,
  mathFlavor,
  mathTokens,
} from '../src/addons/math/syntax.ts'
import { Subscript, Subtext } from '../src/addons/text-extras/nodes.ts'
import { textExtrasMarkdown } from '../src/addons/text-extras/syntax.ts'
import { countText } from '../src/addons/word-count/count.ts'
import { FormattedCounter } from '../src/addons/word-count/formatted-counter.ts'
import { documentImage } from '../src/renderer/src/DocumentImage.ts'
import { editorExtensions } from '../src/renderer/src/markdown.ts'
import { configureMarkdownEntities } from '../src/renderer/src/markdown-entities.ts'
import { markdownSyntax } from '../src/renderer/src/markdown-syntax.ts'
import { readFrontmatter } from '../src/shared/frontmatter.ts'
import { hasFootnoteDefinitions } from '../src/shared/markdown-footnotes.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

/*
 * The original 1221-state word count fuzz corpus: 60 notes in five syntax
 * settings, each edited up to 25 times, with the same cancelled reads.
 * Counts must match the rich editor's own Markdown parser and schema.
 */
const corpus = JSON.parse(
  readFileSync(new URL('./fixtures/word-count-corpus.json', import.meta.url)),
)

/** The app derives alerts from the GitHub flavor; no corpus state has an alert marker. */
const countSyntax = (config) => ({ ...config, alerts: config.gfm })
const alertSource = /^ {0,3}>[ \t]*\[![a-z][a-z0-9-]*\]/im

function* states(doc) {
  const eol = doc.doc % 2 ? '\r\n' : '\n'
  const inserts = ['word', ' ', eol, eol + eol, '**', '[^a]', '\u{1f600}', '']
  let source = doc.source
  yield { step: 'initial', source }
  for (const entry of doc.edits.split(' ').filter(Boolean)) {
    const [step, from, to, insert, partial] = entry.split(':')
    const change = { from: +from, to: +to, insert: inserts[+insert] }
    source =
      source.slice(0, change.from) + change.insert + source.slice(change.to)
    yield {
      step: +step,
      change,
      partial: partial === '' ? null : +partial,
      source,
    }
  }
}

// Syntax features the markdown, math and text extras addons register.
for (const [owner, id, level, extensions, matches] of [
  [
    'markdown',
    'tables',
    'block',
    ['tableKit'],
    (token) => token.type === 'table',
  ],
  [
    'markdown',
    'tasks',
    'block',
    ['taskList', 'taskItem'],
    (token) =>
      token.type === 'list' && !!token.items?.some((item) => item.task),
  ],
  ['markdown', 'strike', 'inline', ['strike'], (token) => token.type === 'del'],
  [
    'markdown',
    'alerts',
    'block',
    ['githubAlert'],
    (token) =>
      token.type === 'githubAlert' ||
      (token.type === 'blockquote' && !!alertMarker(token.text ?? '')),
  ],
  [
    'math',
    'inline',
    'inline',
    ['inlineMath'],
    (token) => token.type === 'inlineMath',
  ],
  [
    'math',
    'block',
    'block',
    ['blockMath'],
    (token) => token.type === 'blockMath',
  ],
  [
    'text-extras',
    'subscript',
    'inline',
    ['subscript'],
    (token) => token.type === 'subscript',
  ],
  [
    'text-extras',
    'subtext',
    'block',
    ['subtext'],
    (token) => token.type === 'subtext',
  ],
])
  markdownSyntax.register(owner, {
    id,
    label: id,
    group: owner,
    level,
    extensions,
    matches,
  })

/**
 * The rich editor's conversion for one syntax setting: the flavors the
 * addons register, sorted by id as the app selects them, and the user's
 * disabled syntax. Footnote state is per parse, as for a newly opened note.
 */
function richOracle(syntax) {
  markdownSyntax.reset()
  for (const id of syntax.disabledFeatures) {
    markdownSyntax.setEnabled(id, false)
    assert.equal(markdownSyntax.enabled(id), false, id)
  }
  const footnotes = markedGithubFootnote()
  const flavors = [
    syntax.gfm && {
      id: 'markdown.github',
      kind: 'dialect',
      markedOptions: { gfm: true },
      richExtensions: [
        GithubAlert,
        Strike,
        NativeTableKit.configure({ table: { resizable: false } }),
        TaskList,
        TaskItem.configure({ nested: true }),
      ],
      export: { extensions: [alertMarkdown, footnotes] },
    },
    syntax.wikilinks && {
      id: 'markdown.obsidian',
      richExtensions: [WikiEmbed, WikiLink, ObsidianHighlight],
      export: { extensions: [obsidianMarkdown] },
    },
    syntax.math && {
      ...mathFlavor,
      id: 'math.latex',
      richExtensions: [
        InlineMath.extend({
          markdownTokenizer: {
            name: 'inlineMath',
            level: 'inline',
            start: (source) => source.indexOf('$'),
            tokenize: inlineMath,
          },
        }),
        BlockMath.extend({
          markdownTokenizer: {
            name: 'blockMath',
            level: 'block',
            start: blockMathStart,
            tokenize: blockMath,
          },
        }),
      ],
      export: { extensions: [mathTokens] },
    },
    syntax.textExtras && {
      id: 'text-extras.text-extras',
      richExtensions: [Subscript, Subtext],
      export: { extensions: [textExtrasMarkdown] },
    },
  ].filter(Boolean)
  const extensions = [
    ...editorExtensions(flavors),
    ...(markdownSyntax.enabled('core.images') ? [documentImage(0)] : []),
  ]
  const markdown = extensions.find((extension) => extension.name === 'markdown')
  const manager = new MarkdownManager({
    extensions,
    marked: markdown.options.marked,
    markedOptions: markdown.options.markedOptions,
  })
  configureMarkdownEntities(manager)
  const schema = getSchema(extensions)
  const textSerializers = getTextSerializersFromSchema(schema)
  return Object.assign(
    (body) => {
      footnotes.hooks.preprocess(body)
      const json = manager.parse(body)
      return {
        json,
        text: getText(schema.nodeFromJSON(json), {
          blockSeparator: '\n',
          textSerializers,
        }),
      }
    },
    { schema },
  )
}

const read = (counter) => {
  const work = counter.read()
  for (;;) {
    const next = work.next()
    if (next.done) return next.value
  }
}
const bodyOf = (source, syntax) =>
  syntax.frontmatter ? (readFrontmatter(source)?.content ?? source) : source

/** Every corpus state with its counts, rich text and product classification. */
function corpusResults() {
  const results = []
  corpus.configs.forEach((config, index) => {
    const syntax = countSyntax(config)
    const rich = richOracle(syntax)
    for (const doc of corpus.docs.filter((entry) => entry.config === index)) {
      const counter = new FormattedCounter(
        new SourceStore(doc.source, {
          tabId: `corpus-${doc.doc}`,
          revision: 0,
        }),
        syntax,
      )
      for (const state of states(doc)) {
        if (state.change) {
          const snapshot = counter.store.snapshot()
          counter.apply({
            document: snapshot.document,
            operationId: `corpus-${doc.doc}-${state.step}`,
            baseVersion: snapshot.version,
            contentVersion: snapshot.version + 1,
            origin: 'source',
            historyGroup: 'corpus',
            changes: [state.change],
          })
        }
        if (state.partial !== null && state.partial !== undefined) {
          const work = counter.read()
          for (let call = 0; call < state.partial; call++)
            if (work.next().done) break
          work.return()
        }
        const formatted = read(counter)
        const fresh = new FormattedCounter(
          new SourceStore(state.source, { tabId: 'fresh', revision: 0 }),
          syntax,
        )
        const body = bodyOf(state.source, syntax)
        const { text, json } = rich(body)
        results.push({
          doc: doc.doc,
          step: state.step,
          config: index,
          source: state.source,
          body,
          // Notes that define footnotes have no editable rich view to compare with.
          oracle: hasFootnoteDefinitions(state.source) ? 'schema' : 'rich',
          formatted,
          fresh: read(fresh),
          rich: countText(text),
          text,
          json,
        })
        fresh.dispose()
      }
      counter.dispose()
    }
  })
  markdownSyntax.reset()
  return results
}

/**
 * Rich parser behavior the formatted count deliberately does not copy, as
 * the exact corpus states it changes and the rich count's difference.
 */
const richQuirks = [
  {
    // The rich ordered list tokenizer folds an empty `2.` item and the next
    // line into the previous item's text. In CommonMark 0.31.2 (example
    // 283) `2.` alone is an empty item, as the formatted view shows it.
    source: '1. one\n2.\n two',
    syntax: { gfm: false, wikilinks: false, frontmatter: false },
    text: '\n\none 2. two',
    difference: { words: 1, characters: 1 },
    states: [22].flatMap((doc) =>
      [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24].map(
        (step) => `${doc}:${step}`,
      ),
    ),
  },
  {
    // The rich task list tokenizer takes one more line ending after the list,
    // so blank lines after it leave one empty paragraph fewer than after any
    // other block.
    source: '- [ ] one\n- [x] t\n\n\n\nafter',
    syntax: {},
    text: '\n\none\n\nt\nafter',
    difference: { words: 0, characters: -1 },
    states: ['29:1', '29:2', '29:3'],
  },
  {
    // CommonMark limits ordered markers to nine digits; the rich tokenizer
    // accepts ten and removes the marker from its text.
    source: '1234567890. a',
    syntax: {},
    text: '\n\na',
    difference: { words: -1, characters: -10 },
    states: [],
  },
  {
    // duplicate definitions stay invisible; rich retains their trailing blank tokens.
    source: 'a\n\n[x]: /y\n\n[x]: /z',
    syntax: {},
    text: 'a\n',
    difference: { words: 0, characters: 1 },
    states: [],
  },
  {
    source: 'a\n\n[x]: /y\n\n[x]: /z\n\n[x]: /w',
    syntax: {},
    text: 'a\n\n',
    difference: { words: 0, characters: 2 },
    states: [],
  },
]

test('schema corpus: paragraph boundary edits retain markdown ownership', () => {
  const midDuplicate = 'a\n\n[x]: /y\n\n[x]: /z\n\nb'
  const syntax = countSyntax(corpus.configs[0])
  const rich = richOracle(syntax)
  const cases = [
    [
      'foo',
      [
        [3, 3, ' '],
        [4, 4, 'x'],
        [4, 5, ''],
      ],
    ],
    [midDuplicate, [[midDuplicate.length - 1, midDuplicate.length, 'c']]],
    ['x word', [[0, 1, '']]],
    ['x\u00a0word', [[0, 1, '']]],
    ['words more', [[0, 0, '    ']]],
    ['x1. a', [[0, 1, '']]],
    ['1234567890. a', [[0, 1, '']]],
    ['. a', [[0, 0, '1']]],
    ['1', [[1, 1, ')']]],
    ...[
      ['"', '"'],
      ["'", "'"],
      ['(', ')'],
    ].flatMap(([open, close]) => [
      [`[a]: /url\nfoo${close}`, [[10, 10, open]]],
      [`[a]: /url\n${open}foo`, [[14, 14, close]]],
    ]),
  ]
  for (const [initial, changes] of cases) {
    let source = initial
    const counter = new FormattedCounter(
      new SourceStore(source, { tabId: 'boundary-oracle', revision: 0 }),
      syntax,
    )
    try {
      const initialRich = countText(rich(source).text)
      const quirk = richQuirks.find((quirk) => quirk.source === source)
      assert.deepEqual(
        read(counter),
        quirk
          ? {
              words: initialRich.words - quirk.difference.words,
              characters: initialRich.characters - quirk.difference.characters,
            }
          : initialRich,
      )
      for (const [from, to, insert] of changes) {
        const snapshot = counter.store.snapshot()
        counter.apply({
          document: snapshot.document,
          operationId: crypto.randomUUID(),
          baseVersion: snapshot.version,
          contentVersion: snapshot.version + 1,
          origin: 'source',
          historyGroup: 'boundary-oracle',
          changes: [{ from, to, insert }],
        })
        source = `${source.slice(0, from)}${insert}${source.slice(to)}`
        assert.deepEqual(read(counter), countText(rich(source).text), source)
      }
    } finally {
      counter.dispose()
    }
  }
  markdownSyntax.reset()
})

test('schema corpus: escaped blank-line titles stay visible as CommonMark text', () => {
  const syntax = countSyntax(corpus.configs[0])
  const rich = richOracle(syntax)
  for (const [source, visible] of [
    [
      '[a]: /url "one\n\ntwo\\\\" three\n\nfour"\n\nafter',
      '[a]: /url "one\ntwo\\" three\nfour"\nafter',
    ],
    ['[a]: /url "one\n\ntwo\\"\n\nafter', '[a]: /url "one\ntwo"\nafter'],
    [
      '[a\n\nb]: /url "one\n\ntwo\\"\n\nafter',
      '[a\nb]: /url "one\ntwo"\nafter',
    ],
    ['[a]:\n/url "one\n\ntwo\\"\n\nafter', '[a]: /url "one\ntwo"\nafter'],
  ])
    for (const eol of ['\n', '\r\n']) {
      const text = source.replaceAll('\n', eol)
      assert.equal(rich(text).text, visible, JSON.stringify(text))
      const want = countText(visible)
      const counter = new FormattedCounter(
        new SourceStore(text, { tabId: 'escaped-titles', revision: 0 }),
        syntax,
      )
      try {
        assert.deepEqual(read(counter), want, JSON.stringify(text))
        const from = text.indexOf('two') + 1
        const snapshot = counter.store.snapshot()
        counter.apply({
          document: snapshot.document,
          operationId: crypto.randomUUID(),
          baseVersion: snapshot.version,
          contentVersion: snapshot.version + 1,
          origin: 'source',
          historyGroup: 'escaped-titles',
          changes: [{ from, to: from, insert: 'x' }],
        })
        const changed = text.slice(0, from) + 'x' + text.slice(from)
        assert.deepEqual(
          read(counter),
          countText(rich(changed).text),
          JSON.stringify(changed),
        )
      } finally {
        counter.dispose()
      }
    }
  markdownSyntax.reset()
})

test('schema corpus: styled unicode edits keep the rich text boundary context', () => {
  const syntax = countSyntax(corpus.configs[0])
  const rich = richOracle(syntax)
  for (const [source, marker, offset] of [
    ['**word**\u0301x', '\u0301', 1],
    ['x\u0301**word**', '\u0301', 0],
    ['`word`\u0301x', '\u0301', 1],
    ['**👩**\u200d💻x', '\u200d', 1],
    ['ordinary words', 'ordinary', 0],
    ['ordinary words', 'words', 5],
    ['**bold** ordinary words', 'words', 5],
  ]) {
    const counter = new FormattedCounter(
      new SourceStore(source, { tabId: 'styled-unicode', revision: 0 }),
      syntax,
    )
    try {
      assert.deepEqual(read(counter), countText(rich(source).text))
      const from = source.indexOf(marker) + offset
      const snapshot = counter.store.snapshot()
      counter.apply({
        document: snapshot.document,
        operationId: crypto.randomUUID(),
        baseVersion: snapshot.version,
        contentVersion: snapshot.version + 1,
        origin: 'source',
        historyGroup: 'styled-unicode',
        changes: [{ from, to: from, insert: ' ' }],
      })
      const changed = `${source.slice(0, from)} ${source.slice(from)}`
      assert.deepEqual(read(counter), countText(rich(changed).text), changed)
    } finally {
      counter.dispose()
    }
  }
  markdownSyntax.reset()
})

test('schema corpus: rich parser quirks keep their minimal reproductions', () => {
  for (const quirk of richQuirks) {
    const syntax = countSyntax({ ...corpus.configs[0], ...quirk.syntax })
    const { text } = richOracle(syntax)(quirk.source)
    assert.equal(text, quirk.text)
    const counter = new FormattedCounter(
      new SourceStore(quirk.source, { tabId: 'quirk', revision: 0 }),
      syntax,
    )
    const formatted = read(counter)
    counter.dispose()
    assert.deepEqual(
      {
        words: countText(text).words - formatted.words,
        characters: countText(text).characters - formatted.characters,
      },
      quirk.difference,
    )
  }
  markdownSyntax.reset()
})

test('schema corpus: formatted counts match the rich parser and schema in every state', () => {
  const results = corpusResults()
  assert.equal(results.length, corpus.origin.checks)
  assert.deepEqual(
    results
      .filter((result) => alertSource.test(result.body))
      .map(({ doc, step }) => ({ doc, step })),
    [],
  )
  const differs = (a, b) => a.words !== b.words || a.characters !== b.characters
  const summary = (result) => ({
    doc: result.doc,
    step: result.step,
    oracle: result.oracle,
    formatted: result.formatted,
    rich: result.rich,
    source: result.source,
    text: result.text,
  })
  assert.deepEqual(
    results
      .filter((result) => differs(result.formatted, result.fresh))
      .map(summary),
    [],
    'warm counts must match a fresh count of the same source',
  )
  const quirks = new Map(
    richQuirks.flatMap((quirk) => quirk.states.map((state) => [state, quirk])),
  )
  assert.deepEqual(
    results
      .filter((result) => {
        const quirk = quirks.get(`${result.doc}:${result.step}`)
        return quirk
          ? result.rich.words - result.formatted.words !==
              quirk.difference.words ||
              result.rich.characters - result.formatted.characters !==
                quirk.difference.characters
          : differs(result.formatted, result.rich)
      })
      .map(summary),
    [],
  )
})

/*
 * The same states in freshly loaded notes, with the same addons, flavors
 * and disabled syntax. Text is read only from an active, editable rich view
 * outside source panes whose document is what its own parser makes of the
 * canonical source at one unchanged version.
 */
const probe = async ({ source, body, footnotes }) => {
  const shell = await window.hibi.getDocument()
  if (shell?.markdown !== source) return null
  const view = document.querySelector('#document-editor-panel .tiptap')
  const editor = view?.editor
  if (!editor || editor.isDestroyed) return null
  const sourceMode = !!document.querySelector(
    '.editor-panes.mode-markdown, .editor-panes.mode-side-by-side',
  )
  // A note that defines footnotes keeps source editing and no editable rich view.
  if (footnotes)
    return !editor.isEditable && sourceMode ? { fallback: true } : null
  if (
    !editor.isEditable ||
    sourceMode ||
    view.getAttribute('aria-readonly') !== 'false' ||
    view.getAttribute('contenteditable') !== 'true'
  )
    return null
  const json = editor.getJSON()
  const parsed = editor.schema.nodeFromJSON(editor.markdown.parse(body))
  if (!editor.state.doc.eq(parsed)) return null
  const text = editor.getText({ blockSeparator: '\n' })
  const after = await window.hibi.getDocument()
  if (
    after.markdown !== source ||
    after.tabId !== shell.tabId ||
    after.revision !== shell.revision ||
    after.contentVersion !== shell.contentVersion
  )
    return null
  return {
    text,
    json,
    nodes: Object.keys(editor.schema.nodes),
    marks: Object.keys(editor.schema.marks),
  }
}

async function openCorpus(config, formatted = false) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-word-count-corpus-'))
  await writeFile(
    join(folder, 'addons.json'),
    JSON.stringify({
      'word-count': true,
      math: !!config.math,
      'text-extras': !!config.textExtras,
      frontmatter: config.frontmatter,
      tags: config.hashtags,
      // Its diagram node is outside these syntax settings.
      mermaid: false,
    }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${folder}`],
  })
  const close = async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  }
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await waitForDocumentEditor(app, page)
    await page.evaluate(
      ({ disabled, formatted }) => {
        localStorage.setItem(
          'hibi:markdown-syntax-disabled',
          JSON.stringify(disabled),
        )
        if (formatted)
          localStorage.setItem('hibi:formatted-engine', 'codemirror')
        else localStorage.removeItem('hibi:formatted-engine')
      },
      { disabled: config.disabledFeatures, formatted },
    )
    // A worker answers count requests in order, each once: a result, or null
    // when a newer request cancels it. Pair them per worker, without payloads.
    await page.addInitScript(() => {
      window.countOpens = []
      window.countReplies = []
      let workers = 0
      const NativeWorker = window.Worker
      window.Worker = class extends NativeWorker {
        constructor(url, options) {
          super(url, options)
          if (!String(url).includes('counter.worker')) return
          const worker = ++workers
          const pending = []
          this.addEventListener('message', ({ data }) => {
            if (data?.kind === 'count')
              window.countReplies.push({
                ...pending.shift(),
                worker,
                result: data.result,
              })
          })
          const post = this.postMessage.bind(this)
          this.postMessage = (data, ...rest) => {
            if (data?.kind === 'count')
              pending.push({
                streamId: data.streamId,
                version: data.version,
                syntax: data.syntax,
              })
            if (data?.kind === 'open')
              window.countOpens.push({
                worker,
                streamId: data.head.streamId,
                tabId: data.head.tabId,
              })
            return post(data, ...rest)
          }
        }
      }
    })
    await page.reload()
    await waitForDocumentEditor(app, page)
    // Each state opens as its own note, as a fresh rich editor parses it.
    const open = async (name, source) => {
      const file = join(folder, name)
      await writeFile(file, source)
      const choice =
        config.gfm && config.wikilinks
          ? null
          : {
              dialect: config.gfm ? 'auto' : 'none',
              syntax: config.wikilinks ? ['markdown.obsidian'] : [],
            }
      // Use Electron's canonical path for DocumentState.id, including the
      // Windows drive spelling, rather than guessing it in the test process.
      const canonical = choice
        ? await app.evaluate((_electron, file) => {
            return process.getBuiltinModule('node:fs/promises').realpath(file)
          }, file)
        : null
      await page.evaluate(
        ({ keys, choice }) => {
          for (const key of keys)
            localStorage.setItem(key, JSON.stringify(choice))
        },
        {
          keys: choice
            ? [canonical].map(
                (path) =>
                  `hibi:flavor:${createHash('sha256').update(path).digest('hex')}`,
              )
            : [],
          choice,
        },
      )
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        })
      }, file)
      // Through the menus, as a person opens notes, so the window applies them.
      if (opened) {
        const { tabId } = await page.evaluate(() => window.hibi.getDocument())
        await clickMenu(app, 'Close tab')
        await waitForAsync(
          page,
          async (tabId) => (await window.hibi.getDocument()).tabId !== tabId,
          tabId,
        )
      }
      opened = true
      await clickMenu(app, 'Open…')
      await waitForAsync(
        page,
        async (name) => (await window.hibi.getDocument()).name === name,
        name,
      )
    }
    let opened = false
    return { page, errors, open, close }
  } catch (error) {
    await close()
    throw error
  }
}

test('native corpus: a freshly loaded active rich editor holds the schema text of every supported state', {
  timeout: 3600000,
}, async (t) => {
  const expected = new Map(
    corpusResults().map((result) => [`${result.doc}:${result.step}`, result]),
  )
  const mismatches = []
  let fallbacks = 0
  for (const [index, config] of corpus.configs.entries()) {
    const docs = corpus.docs.filter((doc) => doc.config === index)
    const { schema } = richOracle(countSyntax(config))
    const { page, errors, open, close } = await openCorpus(config)
    try {
      let schemaChecked = false
      for (const doc of docs)
        for (const state of states(doc)) {
          const result = expected.get(`${doc.doc}:${state.step}`)
          await open(`${doc.doc}-${state.step}.md`, state.source)
          // the native footnote tokenizer retains definitions between parses.
          // reload gives each note the same isolated state as the schema oracle.
          await page.reload()
          const arg = {
            source: state.source,
            body: result.body,
            footnotes: result.oracle === 'schema',
          }
          await waitForAsync(page, probe, arg, { timeout: 15000 }).catch(
            async (error) => {
              const seen = await page.evaluate(async ({ source, body }) => {
                const shell = await window.hibi.getDocument()
                const view = document.querySelector(
                  '#document-editor-panel .tiptap',
                )
                const editor = view?.editor
                const live = JSON.stringify(editor?.getJSON()) ?? ''
                const parsed =
                  JSON.stringify(
                    editor?.schema.nodeFromJSON(editor.markdown.parse(body)),
                  ) ?? ''
                let at = 0
                while (at < live.length && live[at] === parsed[at]) at++
                return {
                  source: shell?.markdown === source,
                  editable: editor?.isEditable,
                  readOnly: view?.getAttribute('aria-readonly'),
                  panes: document.querySelector('.editor-panes')?.className,
                  live: live.slice(Math.max(0, at - 60), at + 140),
                  parsed: parsed.slice(Math.max(0, at - 60), at + 140),
                }
              }, arg)
              throw new Error(
                `${doc.doc}:${state.step} not ready: ${JSON.stringify(seen)}`,
                { cause: error },
              )
            },
          )
          const native = await page.evaluate(probe, arg)
          assert.ok(
            native,
            `${doc.doc}:${state.step} changed while it was read`,
          )
          if (native.fallback) {
            fallbacks++
            continue
          }
          if (!schemaChecked) {
            // The rich schema of this syntax setting is the oracle's.
            assert.deepEqual(
              {
                nodes: native.nodes.toSorted(),
                marks: native.marks.toSorted(),
              },
              {
                nodes: Object.keys(schema.nodes).toSorted(),
                marks: Object.keys(schema.marks).toSorted(),
              },
            )
            schemaChecked = true
          }
          if (native.text !== result.text)
            mismatches.push({
              doc: doc.doc,
              step: state.step,
              source: state.source,
              native: native.text,
              schema: result.text,
              json: JSON.stringify(native.json),
            })
        }
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  }
  t.diagnostic(
    JSON.stringify({
      states: expected.size,
      fallbacks,
      mismatches: mismatches.length,
    }),
  )
  assert.deepEqual(mismatches, [])
})

/**
 * The formatted view's count of this note at its unchanged version: the
 * result its worker returned for the latest request on the note's stream,
 * once the status bar shows it.
 */
const formattedCount = async ({ source, text }) => {
  const shell = await window.hibi.getDocument()
  if (shell?.markdown !== source) return null
  const open = window.countOpens.findLast(
    (entry) => entry.tabId === shell.tabId,
  )
  const reply = window.countReplies.findLast(
    (entry) =>
      entry.worker === open?.worker &&
      entry.streamId === open?.streamId &&
      entry.version === shell.contentVersion,
  )
  if (!reply?.result) return null
  const { words: total, characters } = reply.result
  const label = `${total.toLocaleString()} ${total === 1 ? 'word' : 'words'} · ${characters.toLocaleString()} ${characters === 1 ? 'character' : 'characters'}`
  if (
    document.querySelector('[data-status-id="word-count.total"]')
      ?.textContent !== label
  )
    return null
  const after = await window.hibi.getDocument()
  if (
    after.markdown !== source ||
    after.tabId !== shell.tabId ||
    after.revision !== shell.revision ||
    after.contentVersion !== shell.contentVersion
  )
    return null
  const words = new Intl.Segmenter(undefined, { granularity: 'word' })
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return {
    result: reply.result,
    syntax: reply.syntax,
    want: {
      words: [...words.segment(text)].filter((part) => part.isWordLike).length,
      characters: [...graphemes.segment(text)].length,
    },
  }
}

test('canonical path keeps native word-count syntax choices', {
  timeout: 120000,
}, async (t) => {
  for (const [index, config] of corpus.configs.entries())
    await t.test(`syntax ${index}`, async (t) => {
      const { page, open, close } = await openCorpus(config, true)
      t.after(close)
      const source = 'plain words'
      await open('syntax.md', source)
      const arg = { source, text: source }
      await waitForAsync(page, formattedCount, arg)
      const native = await page.evaluate(formattedCount, arg)
      assert.deepEqual(
        {
          ...native.syntax,
          disabledFeatures: native.syntax.disabledFeatures.toSorted(),
        },
        {
          ...countSyntax(config),
          textExtras: !!config.textExtras,
          math: !!config.math,
          mermaid: false,
          typst: false,
          disabledFeatures: config.disabledFeatures.toSorted(),
        },
      )
    })
})

test('native corpus: formatted counts equal the rich text counts in the app', {
  timeout: 1800000,
}, async (t) => {
  const results = corpusResults()
  const quirks = new Map(
    richQuirks.flatMap((quirk) => quirk.states.map((state) => [state, quirk])),
  )
  const mismatches = []
  for (const [index, config] of corpus.configs.entries()) {
    const syntax = {
      ...countSyntax(config),
      textExtras: !!config.textExtras,
      math: !!config.math,
      mermaid: false,
      typst: false,
    }
    const { page, errors, open, close } = await openCorpus(config, true)
    try {
      for (const result of results.filter((entry) => entry.config === index)) {
        // Each opened note gets its own tab and count stream.
        await open(`${result.doc}-${result.step}.md`, result.source)
        const arg = { source: result.source, text: result.text }
        await waitForAsync(page, formattedCount, arg, { timeout: 15000 }).catch(
          async (error) => {
            const seen = await page.evaluate(async () => ({
              shell: await window.hibi
                .getDocument()
                .then(({ tabId, revision, contentVersion }) => ({
                  tabId,
                  revision,
                  contentVersion,
                })),
              label: document.querySelector(
                '[data-status-id="word-count.total"]',
              )?.textContent,
              opens: window.countOpens.slice(-2),
              replies: window.countReplies
                .slice(-3)
                .map(({ syntax, ...reply }) => reply),
            }))
            throw new Error(
              `${result.doc}:${result.step} not counted: ${JSON.stringify(seen)}`,
              { cause: error },
            )
          },
        )
        const native = await page.evaluate(formattedCount, arg)
        assert.ok(
          native,
          `${result.doc}:${result.step} changed while it was read`,
        )
        assert.deepEqual(
          {
            ...native.syntax,
            disabledFeatures: native.syntax.disabledFeatures.toSorted(),
          },
          { ...syntax, disabledFeatures: syntax.disabledFeatures.toSorted() },
        )
        const quirk = quirks.get(`${result.doc}:${result.step}`)
        const want = quirk
          ? {
              words: native.want.words - quirk.difference.words,
              characters: native.want.characters - quirk.difference.characters,
            }
          : native.want
        if (
          native.result.words !== want.words ||
          native.result.characters !== want.characters
        )
          mismatches.push({
            doc: result.doc,
            step: result.step,
            oracle: result.oracle,
            formatted: native.result,
            want,
            source: result.source,
          })
      }
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  }
  t.diagnostic(
    JSON.stringify({ states: results.length, mismatches: mismatches.length }),
  )
  assert.deepEqual(mismatches, [])
})
