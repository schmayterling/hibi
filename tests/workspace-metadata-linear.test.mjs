import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { Lexer, Marked } from 'marked'
import { readFrontmatter } from '../src/shared/frontmatter.ts'
import { noteReferences } from '../src/shared/note-links.ts'
import { noteHeadings } from '../src/shared/note-metadata.ts'
import { defaultNoteSyntax, noteLexer } from '../src/shared/note-syntax.ts'
import { noteTags } from '../src/shared/note-tags.ts'

// Previous tokenizers/hints are a small-input parity oracle, never a large probe.
function oldLexer(source, syntax) {
  const parser = new Marked({ gfm: syntax.gfm, breaks: false })
  if (syntax.wikilinks) {
    function wiki(source, embed) {
      const match = /^(!?)\[\[([^\]\r\n]+)\]\]/.exec(source)
      if (!match || !!match[1] !== embed) return
      const [target, alias] = match[2].split('|', 2)
      if (!target?.trim()) return
      const label = alias?.trim() || target.trim()
      return {
        type: embed ? 'obsidianEmbed' : 'obsidianWikiLink',
        raw: match[0],
        text: label,
        target: target.trim(),
        tokens: [{ type: 'text', raw: label, text: label }],
      }
    }
    parser.use({
      extensions: [
        {
          name: 'obsidianEmbed',
          level: 'inline',
          start: (text) => text.indexOf('![['),
          tokenizer: (text) => wiki(text, true),
        },
        {
          name: 'obsidianWikiLink',
          level: 'inline',
          start: (text) => text.indexOf('[['),
          tokenizer: (text) => wiki(text, false),
        },
        {
          name: 'obsidianHighlight',
          level: 'inline',
          start: (text) => text.indexOf('=='),
          tokenizer(source) {
            const match = /^==(\S(?:[^\r\n]*?\S)?)==/.exec(source)
            if (!match) return
            const text = match[1] ?? ''
            return {
              type: 'obsidianHighlight',
              raw: match[0],
              text,
              tokens: [{ type: 'text', raw: text, text }],
            }
          },
        },
      ],
    })
  }
  return {
    parser,
    tokens: parser.lexer(
      syntax.frontmatter
        ? (readFrontmatter(source)?.content ?? source)
        : source,
    ),
  }
}

function scanWork(t, parse) {
  let work = 0
  const indexOf = String.prototype.indexOf
  const charCodeAt = String.prototype.charCodeAt
  const exec = RegExp.prototype.exec
  const highlightRule = /^==(\S(?:[^\r\n]*?\S)?)==/.source
  const textRules = new Set([
    Lexer.rules.inline.normal.text,
    Lexer.rules.inline.gfm.text,
  ])
  RegExp.prototype.exec = function (source) {
    const result = exec.call(this, source)
    if (textRules.has(this)) work += result?.[0].length ?? 0
    // Failed highlight matches with a valid first character inspect the line.
    if (
      this.source === highlightRule &&
      source.startsWith('==') &&
      /\S/.test(source[2] ?? '')
    )
      work += result ? result[0].length : source.length
    return result
  }
  const hint = t.mock.method(
    String.prototype,
    'indexOf',
    function (needle, from) {
      const result = indexOf.call(this, needle, from)
      if (['![[', '[[', '=='].includes(needle))
        work += result < 0 ? this.length : result + needle.length
      return result
    },
  )
  const scan = t.mock.method(String.prototype, 'charCodeAt', function (index) {
    work++
    return charCodeAt.call(this, index)
  })
  try {
    parse()
    return work
  } finally {
    hint.mock.restore()
    scan.mock.restore()
    RegExp.prototype.exec = exec
  }
}

for (const [name, fragment] of [
  ['markdown links', '[next](next.md) #tag '],
  ['unclosed brackets', '['],
  ['mixed wiki boundaries', '[[bad] [[good]] ![[embed]] [[ **bold** '],
  ['autolinks', 'www.example.com #tag '],
  ['protocol links', 'http://example.com #tag '],
  ['email links', 'a@example.com #tag '],
  ['email protocols', 'mailto:a@example.com #tag '],
]) {
  test(`${name} extension scan work grows linearly and retains metadata`, (t) => {
    let previous = 0
    for (const size of [1024, 2048, 4096]) {
      const source = fragment.repeat(size)
      let lexed
      const work = scanWork(t, () => {
        lexed = noteLexer(source)
      })
      assert.ok(
        work <= source.length * 8,
        `${work} work / ${source.length} chars`,
      )
      if (previous) assert.ok(work <= previous * 2.1 + 16)
      previous = work
      const references = noteReferences(source, defaultNoteSyntax, lexed)
      if (name === 'markdown links') {
        assert.equal(references.links.length, size)
        assert.equal(references.links.at(-1), 'next.md')
        assert.deepEqual(noteTags(source, defaultNoteSyntax, lexed), ['tag'])
      }
      if (name === 'unclosed brackets') {
        assert.deepEqual(references, { links: [], wikilinks: [] })
        assert.equal(lexed.tokens[0].tokens[0].text, source)
      }
    }
  })
}

test('failed highlight delimiters scan linearly at 16 and 64 KiB', (t) => {
  let previous = 0
  for (const bytes of [16 * 1024, 64 * 1024]) {
    const source = '==a '.repeat(bytes / 4)
    let lexed
    const work = scanWork(t, () => {
      lexed = noteLexer(source)
    })
    t.diagnostic(`${bytes} bytes: ${work} scan work`)
    assert.ok(work <= bytes * 8, `${work} work / ${bytes} chars`)
    if (previous) assert.ok(work <= previous * 4.1 + 16)
    previous = work
    assert.equal(lexed.tokens[0].tokens[0].text, source)
    assert.deepEqual(noteReferences(source, defaultNoteSyntax, lexed), {
      links: [],
      wikilinks: [],
    })
    assert.deepEqual(noteTags(source, defaultNoteSyntax, lexed), [])
  }
})

test('linear counter rejects the previous lexer on small dense and unclosed inputs', (t) => {
  for (const fragment of ['[next](next.md) #tag ', '[', '==a ']) {
    const source = fragment.repeat(1024)
    const work = scanWork(t, () => oldLexer(source, defaultNoteSyntax))
    assert.ok(work > source.length * 8, `${work} work / ${source.length} chars`)
  }
})

test('small generated fixtures match previous tokens, links, tags, and headings', () => {
  const fragments = [
    'plain #tag ',
    '[label #hidden](file.md "title") ',
    '[ref][id] ',
    '![[target|alias]] ',
    '[[ target[part | alias ]] ',
    '[[bad] [[good]] ',
    '[[ ]] [[|alias]] ',
    '[[unterminated ',
    '[',
    ']',
    '![',
    '==#highlight [hidden](file.md)== ',
    '== not highlight == ',
    '==a ',
    '==b== ',
    '===',
    '=====',
    '==a==b== ',
    '==a\t==b== ',
    '==\u00a0x== ',
    '==x\u2028y== ',
    '==x\u2029== ',
    '[==a ==b ](next.md) ',
    '**==nested ==failed** ',
    '==a\r\n==b== ',
    '==a\n==b== ',
    '==a\r==b== ',
    '**#bold** ',
    '*_nested_* ',
    '~~#strike~~ ',
    '`[[code]] #code` ',
    '\\[[escaped]] \\#escape ',
    '<span>#html</span> ',
    'www.example.com ',
    'a@example.com ',
    'mailto:a@example.com ',
    '\n',
    '  \n',
  ]
  let seed = 393
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % max
  }
  const fixtures = [
    'text ![[embed]] and ==highlight==',
    '[[**nested**[[unterminated\n[[valid]]',
    '# [[a[part|Alias]] ==heading== #tag',
    '> [[bad **bold** [text](a.md) [[good]]\n> # Heading',
    '| [[a]] | #table |\n| --- | --- |\n| ![[b]] | [c](c.md) |',
  ]
  // Exhaust short equals runs and whitespace edges against the native regex.
  const edges = ['=', 'a', ' ', '\t', '\n', '\r', '\u00a0', '\u2028', '\u2029']
  for (const first of edges)
    for (const middle of edges)
      for (const last of edges) fixtures.push(`==${first}${middle}${last}==a==`)
  for (let i = 0; i < 300; i++) {
    let body = ''
    for (let j = 0; j < 12; j++) body += fragments[random(fragments.length)]
    fixtures.push(
      `---\ntitle: Example\n---\n# ${body}\n\n${body}\n\n[id]: ref.md`,
    )
  }
  for (const gfm of [false, true])
    for (const wikilinks of [false, true])
      for (const frontmatter of [false, true]) {
        const syntax = { ...defaultNoteSyntax, gfm, wikilinks, frontmatter }
        for (const source of fixtures) {
          const old = oldLexer(source, syntax)
          const current = noteLexer(source, syntax)
          assert.deepEqual(
            current.tokens,
            old.tokens,
            JSON.stringify({ source, syntax }),
          )
          assert.deepEqual(
            noteReferences(source, syntax, current),
            noteReferences(source, syntax, old),
          )
          assert.deepEqual(
            noteTags(source, syntax, current),
            noteTags(source, syntax, old),
          )
          assert.deepEqual(
            noteHeadings(source, syntax, current),
            noteHeadings(source, syntax, old),
          )
        }
      }
})

test('large raw probes retain dense links and literal brackets in bounded children', (t) => {
  for (const [kind, fragment, repeats] of [
    ['dense', '[next](next.md) #tag ', Math.ceil((512 * 1024) / 21)],
    ['brackets', '[', 1024 * 1024],
  ]) {
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { noteLexer, defaultNoteSyntax } from './src/shared/note-syntax.ts'
      import { noteReferences } from './src/shared/note-links.ts'
      import { noteTags } from './src/shared/note-tags.ts'
      const source = ${JSON.stringify(fragment)}.repeat(${repeats})
      const start = performance.now()
      const lexed = noteLexer(source)
      const refs = noteReferences(source, defaultNoteSyntax, lexed)
      assert.equal(refs.links.length, ${kind === 'dense' ? repeats : 0})
      assert.deepEqual(noteTags(source, defaultNoteSyntax, lexed), ${kind === 'dense' ? "['tag']" : '[]'})
      if (${JSON.stringify(kind)} === 'brackets') assert.equal(lexed.tokens[0].tokens[0].text, source)
      console.log(JSON.stringify({kind: ${JSON.stringify(kind)}, bytes: source.length, links: refs.links.length, ms: performance.now() - start}))
    `,
      ],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 9000 },
    )
    assert.ifError(probe.error)
    assert.equal(probe.status, 0, probe.stderr)
    t.diagnostic(probe.stdout.trim())
  }
})
