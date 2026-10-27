import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { markdownSourceParser } from '../src/shared/markdown-source-references.ts'
import {
  electron,
  stopElectronTree,
  waitForDocumentEditor,
} from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const cases = [
  { name: 'empty', source: '' },
  { name: 'whitespace', source: '\n\n\n\n' },
  { name: 'crlf whitespace', source: ' \r\n\r\n\t\r\n' },
  { name: 'paragraphs', source: '# first\n\nbody\n\n\n\n## last\n\n' },
  {
    name: 'crlf',
    source: '# heading\r\n\r\n**bold** and *italic*\r\n\r\nlast\r\n',
  },
  {
    name: 'inline',
    source:
      '# **bold** [link](https://example.com)\n\n![photo](photo.png) and `code`',
  },
  {
    name: 'lists',
    source: '- # first\n- second\n\n> ## nested\n> quote\n\n# outer',
  },
  { name: 'lazy quote', source: '> first\n-# small\n> last\n\n# outer' },
  {
    name: 'lazy definition',
    source: '> [ref]: /quote\nplain text\n\n[ref]\n\n# after',
  },
  {
    name: 'gfm',
    source:
      '| a | b |\n|---|---|\n| c | d |\n\n> [!TIP]\n> **careful**\n\n~~strike~~',
  },
  { name: 'extras', source: 'H~2~O\n\n-# small **words**\n\n# after' },
  {
    name: 'references',
    source: '[ref]: /first\n\n# [label][REF]\n\n[ref]: /second\n\n[missing]',
  },
  {
    name: 'forward references',
    source: '-# [ref]\n\n# [ref]\n\n[ref]: /later',
  },
  {
    name: 'reference edits',
    source: '[ref]: /first\n\n# [label][ref]\n\nlast',
    edit: { from: 7, to: 13, insert: '/changed' },
  },
  { name: 'grapheme seams', source: 'carriage&#13;\n\n# after 👩🏽‍💻\n\né 🇵🇭' },
  { name: 'long paragraph', source: `${'text '.repeat(1800)}\n\n# after` },
  {
    name: 'long fence',
    source: `\`\`\`txt\n${'code '.repeat(1800)}\n\`\`\`\n\n# after`,
  },
  {
    name: 'html',
    source: '<div>\n[ref]: /hidden\n</div>\n\n[ref]',
    unavailable: true,
  },
  {
    name: 'inline html',
    source: 'words <em>native</em>\n\n# after',
    unavailable: true,
  },
  {
    name: 'multiline title',
    source: '[ref]: /target "first\n\n# title\nlast"\n\n[ref]',
    unavailable: true,
  },
  {
    name: 'quoted title',
    source: '[ref]: /target "title"\n\n[ref]',
    unavailable: true,
  },
  {
    name: 'long physical heading',
    source: `# ${'a'.repeat(4094)}[other]: /fake\n\n[other]`,
  },
  {
    name: 'task list',
    source: '- [ ] todo\n- [x] done\n\n# after',
    compatibility: true,
  },
]

const formattedGaps = {
  '0/lazy definition/0':
    'formatted gap corpus-001: lazy reference definitions must render only native paragraph text',
  '0/gfm/0':
    'formatted gap corpus-002: gfm tables and alerts must report native formatted character counts',
  '0/references/0':
    'formatted gap corpus-003: reference definitions must hide while resolved labels remain visible',
  '0/forward references/0':
    'formatted gap corpus-004: forward definitions must resolve formatted labels without showing definitions',
  '0/reference edits/0':
    'formatted gap corpus-005: formatted references must render labels before a destination edit',
  '0/reference edits/1':
    'formatted gap corpus-006: formatted references must retain labels after a destination edit',
  '0/grapheme seams/0':
    'formatted gap corpus-007: formatted grapheme character counts must match native counts',
  '0/multiline title/0':
    'formatted gap corpus-008: multiline reference titles must hide and avoid false headings',
  '0/quoted title/0':
    'formatted gap corpus-009: quoted reference titles must hide definitions and resolve labels',
  '1/lazy definition/0':
    'formatted gap corpus-010: disabled syntax must preserve native lazy reference rendering',
  '1/gfm/0':
    'formatted gap corpus-011: disabled heading syntax must preserve bold formatting inside alerts',
  '1/extras/0':
    'formatted gap corpus-012: disabled heading syntax must preserve bold formatting inside subtext',
  '1/references/0':
    'formatted gap corpus-013: disabled heading syntax must still hide reference definitions',
  '1/forward references/0':
    'formatted gap corpus-014: disabled heading syntax must hide forward reference definitions',
  '1/reference edits/0':
    'formatted gap corpus-015: disabled heading syntax must hide definitions before reference edits',
  '1/reference edits/1':
    'formatted gap corpus-016: disabled heading syntax must hide definitions after reference edits',
  '1/grapheme seams/0':
    'formatted gap corpus-017: disabled heading syntax must preserve native grapheme character counts',
  '1/multiline title/0':
    'formatted gap corpus-018: disabled heading syntax must hide multiline reference titles',
  '1/quoted title/0':
    'formatted gap corpus-019: disabled heading syntax must hide quoted reference titles',
}

// frozen native outcomes; the tiptap control verifies every fixture.
const formattedOutcomes = {
  '0/empty/0': { text: '', headings: [], counts: { words: 0, characters: 0 } },
  '0/whitespace/0': {
    text: '\n',
    headings: [],
    counts: { words: 0, characters: 1 },
  },
  '0/crlf whitespace/0': {
    text: '',
    headings: [],
    counts: { words: 0, characters: 0 },
  },
  '0/paragraphs/0': {
    text: 'first\nbody\n\nlast\n',
    headings: ['first', 'last'],
    counts: { words: 3, characters: 17 },
  },
  '0/crlf/0': {
    text: 'heading\nbold and italic\nlast',
    headings: ['heading'],
    counts: { words: 5, characters: 28 },
  },
  '0/inline/0': {
    text: 'bold link\n\n and code',
    headings: ['bold link'],
    counts: { words: 4, characters: 20 },
  },
  '0/lists/0': {
    text: '\n\nfirst\n\nsecond\n\nnested\nquote\nouter',
    headings: ['first', 'nested', 'outer'],
    counts: { words: 5, characters: 35 },
  },
  '0/lazy quote/0': {
    text: '\nfirst\nsmall\nlast\nouter',
    headings: ['outer'],
    counts: { words: 4, characters: 23 },
  },
  '0/lazy definition/0': {
    text: '\nplain text\nref\nafter',
    headings: ['after'],
    counts: { words: 4, characters: 21 },
  },
  '0/gfm/0': {
    text: '\n\n\na\n\nb\n\n\nc\n\nd\n\ncareful\nstrike',
    headings: [],
    counts: { words: 6, characters: 30 },
  },
  '0/extras/0': {
    text: 'H2O\nsmall words\nafter',
    headings: ['after'],
    counts: { words: 4, characters: 21 },
  },
  '0/references/0': {
    text: 'label\n[missing]',
    headings: ['label'],
    counts: { words: 2, characters: 15 },
  },
  '0/forward references/0': {
    text: '[ref]\nref',
    headings: ['ref'],
    counts: { words: 2, characters: 9 },
  },
  '0/reference edits/0': {
    text: 'label\nlast',
    headings: ['label'],
    counts: { words: 2, characters: 10 },
  },
  '0/reference edits/1': {
    text: 'label\nlast',
    headings: ['label'],
    counts: { words: 2, characters: 10 },
  },
  '0/grapheme seams/0': {
    text: 'carriage\r\nafter 👩🏽‍💻\né 🇵🇭',
    headings: ['after 👩🏽‍💻'],
    counts: { words: 3, characters: 20 },
  },
  '0/long paragraph/0': {
    text: `${'text '.repeat(1800)}\nafter`,
    headings: ['after'],
    counts: { words: 1801, characters: 9006 },
  },
  '0/long fence/0': {
    text: `${'code '.repeat(1800)}\nafter`,
    headings: ['after'],
    counts: { words: 1801, characters: 9006 },
  },
  '0/html/0': {
    text: '<div>\n[ref]: /hidden\n</div>\n[ref]',
    headings: [],
    counts: { words: 5, characters: 33 },
  },
  '0/inline html/0': {
    text: 'words <em>native</em>\nafter',
    headings: ['after'],
    counts: { words: 5, characters: 27 },
  },
  '0/multiline title/0': {
    text: 'ref',
    headings: [],
    counts: { words: 1, characters: 3 },
  },
  '0/quoted title/0': {
    text: 'ref',
    headings: [],
    counts: { words: 1, characters: 3 },
  },
  '0/long physical heading/0': {
    text: `${'a'.repeat(4094)}[other]: /fake\n[other]`,
    headings: [`${'a'.repeat(4094)}[other]: /fake`],
    counts: { words: 4, characters: 4116 },
  },
  '0/task list/0': {
    text: '\n\ntodo\n\ndone\nafter',
    headings: ['after'],
    counts: { words: 3, characters: 18 },
  },
  '1/empty/0': { text: '', headings: [], counts: { words: 0, characters: 0 } },
  '1/whitespace/0': {
    text: '\n',
    headings: [],
    counts: { words: 0, characters: 1 },
  },
  '1/crlf whitespace/0': {
    text: '',
    headings: [],
    counts: { words: 0, characters: 0 },
  },
  '1/paragraphs/0': {
    text: '# first\nbody\n\nlast\n',
    headings: ['last'],
    counts: { words: 3, characters: 19 },
  },
  '1/crlf/0': {
    text: '# heading\n**bold** and italic\nlast',
    headings: [],
    counts: { words: 5, characters: 34 },
  },
  '1/inline/0': {
    text: '# **bold** [link](https://example.com)\n![photo](photo.png) and code',
    headings: [],
    counts: { words: 10, characters: 67 },
  },
  '1/lists/0': {
    text: '\n\n# first\n\nsecond\n\nnested\nquote\n# outer',
    headings: ['nested'],
    counts: { words: 5, characters: 39 },
  },
  '1/lazy quote/0': {
    text: '\nfirst\nsmall\nlast\n# outer',
    headings: [],
    counts: { words: 4, characters: 25 },
  },
  '1/lazy definition/0': {
    text: '\nplain text\nref\n# after',
    headings: [],
    counts: { words: 4, characters: 23 },
  },
  '1/gfm/0': {
    text: '\n\n\na\n\nb\n\n\nc\n\nd\n\ncareful\nstrike',
    headings: [],
    counts: { words: 6, characters: 30 },
  },
  '1/extras/0': {
    text: 'H2O\nsmall words\n# after',
    headings: [],
    counts: { words: 4, characters: 23 },
  },
  '1/references/0': {
    text: '# [label][REF]\n[missing]',
    headings: [],
    counts: { words: 3, characters: 24 },
  },
  '1/forward references/0': {
    text: '[ref]\n# [ref]',
    headings: [],
    counts: { words: 2, characters: 13 },
  },
  '1/reference edits/0': {
    text: '# [label][ref]\nlast',
    headings: [],
    counts: { words: 3, characters: 19 },
  },
  '1/reference edits/1': {
    text: '# [label][ref]\nlast',
    headings: [],
    counts: { words: 3, characters: 19 },
  },
  '1/grapheme seams/0': {
    text: 'carriage\r\n# after 👩🏽‍💻\né 🇵🇭',
    headings: [],
    counts: { words: 3, characters: 22 },
  },
  '1/long paragraph/0': {
    text: `${'text '.repeat(1800)}\n# after`,
    headings: [],
    counts: { words: 1801, characters: 9008 },
  },
  '1/long fence/0': {
    text: `${'code '.repeat(1800)}\n# after`,
    headings: [],
    counts: { words: 1801, characters: 9008 },
  },
  '1/html/0': {
    text: '<div>\n[ref]: /hidden\n</div>\n[ref]',
    headings: [],
    counts: { words: 5, characters: 33 },
  },
  '1/inline html/0': {
    text: 'words <em>native</em>\n# after',
    headings: [],
    counts: { words: 5, characters: 29 },
  },
  '1/multiline title/0': {
    text: 'ref',
    headings: [],
    counts: { words: 1, characters: 3 },
  },
  '1/quoted title/0': {
    text: 'ref',
    headings: [],
    counts: { words: 1, characters: 3 },
  },
  '1/long physical heading/0': {
    text: `# ${'a'.repeat(4094)}[other]: /fake\n[other]`,
    headings: [],
    counts: { words: 4, characters: 4118 },
  },
  '1/task list/0': {
    text: '\n\ntodo\n\ndone\n# after',
    headings: [],
    counts: { words: 3, characters: 20 },
  },
}

const harness = `
import { getText, getTextSerializersFromSchema } from '@tiptap/core'
import { Strike } from '@tiptap/extension-strike'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import { GithubAlert } from './src/addons/markdown/GithubAlert.ts'
import { alertMarkdown } from './src/addons/markdown/alerts.ts'
import { Subscript, Subtext } from './src/addons/text-extras/nodes.ts'
import { textExtrasMarkdown } from './src/addons/text-extras/syntax.ts'
import { countText } from './src/addons/word-count/count.ts'
import { createMarkdownSemantics } from './src/renderer/src/markdown-semantics.ts'
import { DocumentWorkerService } from './src/shared/document-worker-service.ts'
import { SourceTransferSender } from './src/shared/source-transfer.ts'

const syntax = {gfm:true,alerts:true,textExtras:true}
const flavors = [
  {id:'markdown.github',markedOptions:{gfm:true},
   richExtensions:[GithubAlert,Strike,TableKit.configure({table:{resizable:false}}),TaskList,TaskItem.configure({nested:true})],
   export:{extensions:[alertMarkdown]}},
  {id:'text-extras.text-extras',richExtensions:[Subscript,Subtext],export:{extensions:[textExtrasMarkdown]}},
]
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b)

export async function run(cases) {
  const editor = document.querySelector('.tiptap').editor
  const original = await window.hibi.getDocument()
  const originalJSON = editor.getJSON()
  const reader = createMarkdownSemantics(flavors, 0)
  const results = [], controls = []
  for (const fixture of cases) {
    let source = fixture.source, id = 0, version = 0
    const pending = new Map()
    let lastReply
    const worker = new DocumentWorkerService(reply => {
      lastReply = reply
      if (reply.type !== 'metadata' && reply.type !== 'error') return
      const request = pending.get(reply.id)
      if (!request) return
      pending.delete(reply.id)
      clearTimeout(request.timer)
      request.resolve(structuredClone(reply))
    })
    const request = from => new Promise((resolve,reject) => {
      const requestId = ++id
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(Error('Semantic metadata did not settle: '+fixture.name))
      },6000)
      pending.set(requestId,{resolve,reject,timer})
      worker.receive({type:'metadata',epoch:'native-semantic',id:requestId,version,
        dialect:'gfm',semantic:syntax,from,to:source.length,limit:1})
    })
    const sender = new SourceTransferSender({tabId:'fixture',revision:0,contentVersion:version,
      streamId:crypto.randomUUID(),length:source.length},[source])
    worker.receive({type:'load-start',epoch:'native-semantic',head:sender.head})
    for (;;) {
      if (lastReply?.type !== 'load-ack') throw Error('Missing source stream acknowledgement')
      const chunk = sender.read(lastReply.request)
      worker.receive({type:'load-chunk',epoch:'native-semantic',chunk})
      if (chunk.done) break
    }
    const finish = lastReply.request
    sender.finish(finish)
    worker.receive({type:'load-finish',epoch:'native-semantic',request:finish})
    if (lastReply?.type !== 'ack') throw Error('Source stream did not publish')
    try {
      for (let pass=0;pass<(fixture.edit?2:1);pass++) {
        if (pass) {
          worker.receive({type:'edit',epoch:'native-semantic',operation:{
            document:{tabId:'fixture',revision:0},operationId:'edit-reference',baseVersion:version,
            contentVersion:++version,origin:'source',historyGroup:'typing',changes:[fixture.edit],
          }})
          source = source.slice(0,fixture.edit.from)+fixture.edit.insert+source.slice(fixture.edit.to)
        }
        const expected = editor.markdown.parse(source)
        const expectedNode = editor.schema.nodeFromJSON(expected)
        const expectedText = getText(expectedNode,{blockSeparator:'\\n',textSerializers:getTextSerializersFromSchema(editor.schema)})
        const expectedHeadings = []
        expectedNode.descendants(node=>{
          if (node.type.name==='heading') expectedHeadings.push({label:node.textContent || 'Untitled heading',level:Number(node.attrs.level)})
        })
        controls.push({name:fixture.name,pass,text:expectedText,
          headings:expectedHeadings.map(({label})=>label),counts:countText(expectedText)})
        const rows = [], pages = []
        let from = 0, unavailable
        for (;;) {
          const reply = await request(from)
          if (reply.type !== 'metadata') throw Error(reply.message || 'Unexpected metadata reply')
          const semantic = reply.semantic
          if (semantic.status !== 'available') { unavailable=semantic; break }
          if (semantic.bytes > 512*1024) throw Error('Semantic page exceeded byte limit')
          rows.push(...semantic.rows)
          pages.push(semantic)
          if (semantic.next === null) break
          if (semantic.next <= from) throw Error('Semantic page cursor did not advance')
          from = semantic.next
        }
        if (unavailable) {
          results.push({name:fixture.name,pass,unavailable})
          continue
        }
        if (new Set(rows.map(row=>row.slot)).size !== rows.length)
          throw Error('Semantic pages repeated a region')
        const first = rows.findIndex(row=>row.nonSpace), last = rows.findLastIndex(row=>row.nonSpace)
        const parts = rows.map((row,index)=>reader.read(row.tokens,{
          before:first>=0 && index>first,after:last>=0 && index<last,
        }))
        if (parts.some(part=>part===null)) {
          results.push({name:fixture.name,pass,compatibility:true})
          continue
        }
        const actual = {type:'doc',content:parts.flatMap(part=>part.json.content ?? [])}
        const actualParts = parts.filter(part=>part.blockCount)
        const actualText = actualParts.map(part=>part.text).join('\\n')
        const headings = parts.flatMap(part=>part.headings.map(({label,level})=>({label,level})))
        const totals = actualParts.reduce((result,part,index)=>{
          const counted = countText(part.text)
          result.words += counted.words
          result.characters += counted.characters+(index?1:0)
          if (index && actualParts[index-1].text.endsWith('\\r')) result.characters--
          return result
        },{words:0,characters:0})
        results.push({name:fixture.name,pass,pages:pages.length,rows:rows.length,
          json:same(actual,expected),text:actualText===expectedText,
          headings:same(headings,expectedHeadings),stats:same(totals,countText(expectedText)),
          crSeam:actualParts.slice(0,-1).some(part=>part.text.endsWith('\\r')),
          ...(fixture.name==='long physical heading'?{regions:rows}:{}),
          ...(same(actual,expected)?{}:{actual,expected}),
        })
      }
    } finally {
      worker.dispose()
      for (const waiter of pending.values()) clearTimeout(waiter.timer)
      pending.clear()
    }
  }
  return {results,controls,preserved:same(original,await window.hibi.getDocument()) && same(originalJSON,editor.getJSON())}
}
`

test('tiptap: paginated worker semantics match native schema text, headings and counts', {
  timeout: 60000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-semantic-native-'))
  const bundle = await build({
    stdin: { contents: harness, resolveDir: resolve('.') },
    bundle: true,
    format: 'iife',
    globalName: 'SemanticNativeFixture',
    platform: 'browser',
    write: false,
  })
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  const watchdog = setTimeout(() => stopElectronTree(app.process()), 50000)
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close().catch(() => {})
    clearTimeout(watchdog)
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await selectFormattedEngine(app, page, 'tiptap')
  for (const disabled of [[], ['core.heading-1', 'core.bold', 'core.images']]) {
    await waitForDocumentEditor(app, page)
    if (disabled.length) {
      await page.evaluate(
        (disabled) =>
          localStorage.setItem(
            'hibi:markdown-syntax-disabled',
            JSON.stringify(disabled),
          ),
        disabled,
      )
      await page.reload()
      await waitForDocumentEditor(app, page)
    }
    await page.waitForFunction(
      () =>
        document.querySelector('.tiptap')?.getAttribute('contenteditable') ===
          'true' &&
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
    )
    await page.evaluate(bundle.outputFiles[0].text)
    const report = await page.evaluate(
      (cases) => window.SemanticNativeFixture.run(cases),
      cases,
    )
    await t.test(disabled.length ? 'disabled syntax' : 'default syntax', () => {
      const differences = report.controls.flatMap(
        ({ name, pass, text, headings, counts }) => {
          const key = `${disabled.length ? 1 : 0}/${name}/${pass}`
          const actual = { text, headings, counts }
          const expected = formattedOutcomes[key]
          return JSON.stringify(actual) === JSON.stringify(expected)
            ? []
            : [{ key, actual, expected }]
        },
      )
      if (differences.length)
        t.diagnostic(JSON.stringify({ nativeOracleDifferences: differences }))
      assert.equal(
        differences.length,
        0,
        'frozen outcomes must match the current native control',
      )
      assert.equal(
        report.preserved,
        true,
        'Native parsing must preserve the open document',
      )
      assert.ok(
        report.results.some((row) => row.pages > 2),
        'Fixture must exercise pagination',
      )
      t.diagnostic(
        `${disabled.length ? 'disabled' : 'default'} syntax: ${report.results.filter((row) => row.json).length} matching native conversions, ${report.results.filter((row) => row.unavailable).length} explicit syntax fallbacks, ${report.results.filter((row) => row.compatibility).length} consumer fallbacks`,
      )
      for (const result of report.results) {
        const fixture = cases.find((item) => item.name === result.name)
        const name = `${result.name}, pass ${result.pass}, disabled ${disabled.join(',')}`
        if (fixture.unavailable) {
          assert.deepEqual(
            result.unavailable,
            { status: 'unavailable', reason: 'syntax-context' },
            name,
          )
        } else if (fixture.compatibility) {
          assert.equal(result.compatibility, true, name)
        } else {
          assert.equal(result.unavailable, undefined, name)
          assert.equal(result.compatibility, undefined, name)
          assert.equal(
            result.json,
            true,
            `${name}: ${JSON.stringify({ actual: result.actual, expected: result.expected })}`,
          )
          assert.equal(result.text, true, name)
          assert.equal(result.headings, true, name)
          assert.equal(result.stats, true, name)
          if (fixture.name === 'long physical heading') {
            const source = fixture.source,
              paragraphFrom = source.lastIndexOf('[other]')
            assert.equal(result.pages, 2, name)
            assert.deepEqual(
              result.regions.map(({ from, contentFrom, to, nonSpace }) => [
                from,
                contentFrom,
                to,
                nonSpace,
              ]),
              [
                [0, 0, paragraphFrom, true],
                [paragraphFrom, paragraphFrom, source.length, true],
              ],
              name,
            )
            assert.deepEqual(
              result.regions.flatMap((row) => row.tokens),
              [
                ...markdownSourceParser({
                  gfm: true,
                  alerts: true,
                  textExtras: true,
                }).lexer(source),
              ],
              name,
            )
            assert.equal(
              result.regions[0].tokens[0].text,
              source.slice(2, source.indexOf('\n')),
              name,
            )
            assert.equal(
              result.regions[1].tokens[0].tokens[0].type,
              'text',
              name,
            )
          }
        }
      }
    })
  }
})

// Schema JSON, PM positions and compatibility-reader fallbacks above are
// implementation-exclusive Tiptap proofs. This CM counterpart checks the same
// notes through canonical source, visible outline and rendered-text counts.
test('codemirror: semantic fixtures preserve source, headings and formatted counts', {
  timeout: 240000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-semantic-formatted-'))
  const profile = join(root, 'profile')
  await mkdir(profile)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'word-count': true }),
  )
  assert.equal(Object.keys(formattedOutcomes).length, 48)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const configurations = [[], ['core.heading-1', 'core.bold', 'core.images']]
  await page.addInitScript(() => {
    window.semanticCountSequence = 0
    window.semanticCountReplies = []
    window.Worker = new Proxy(window.Worker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args)
        if (String(args[0]).includes('/counter.worker-')) {
          const pending = []
          const streams = new Map()
          const post = worker.postMessage.bind(worker)
          worker.postMessage = (message, ...rest) => {
            if (message.kind === 'open')
              streams.set(message.head.streamId, message.head)
            if (typeof message === 'string')
              pending.push({
                sequence: ++window.semanticCountSequence,
                source: message,
              })
            else if (message.kind === 'count') {
              const head = streams.get(message.streamId)
              pending.push({
                sequence: ++window.semanticCountSequence,
                document: {
                  tabId: head.tabId,
                  revision: head.revision,
                  contentVersion: message.version,
                },
              })
            }
            return post(message, ...rest)
          }
          worker.addEventListener('message', ({ data }) => {
            if (data.kind && data.kind !== 'count') return
            window.semanticCountReplies.push({
              ...pending.shift(),
              counts: data.kind === 'count' ? data.result : data,
            })
          })
        }
        return worker
      },
    })
  })
  await selectFormattedEngine(app, page, 'codemirror')
  const statusLabel = ({ words, characters }) =>
    `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} · ${characters.toLocaleString()} ${characters === 1 ? 'character' : 'characters'}`
  for (const [configuration, disabled] of configurations.entries()) {
    await page.evaluate(
      (disabled) =>
        localStorage.setItem(
          'hibi:markdown-syntax-disabled',
          JSON.stringify(disabled),
        ),
      disabled,
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
    await page.getByRole('button', { name: /^toggle right sidebar$/i }).click()
    await page.getByRole('button', { name: /^right sidebar views$/i }).click()
    await page
      .getByRole('menuitem', { name: 'On this page', exact: true })
      .click()
    for (const [index, fixture] of cases.entries()) {
      let afterCount = await page.evaluate(() => window.semanticCountSequence)
      const file = join(root, `${configuration}-${index}.md`)
      await writeFile(file, fixture.source)
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        })
      }, file)
      await clickMenu(app, 'Open…')
      await waitForAsync(
        page,
        async (name) => (await window.hibi.getDocument()).name === name,
        `${configuration}-${index}.md`,
      )
      const rich = page.getByRole('textbox', {
        name: 'Document editor',
        exact: true,
      })
      const sources = [fixture.source]
      if (fixture.edit)
        sources.push(
          fixture.source.slice(0, fixture.edit.from) +
            fixture.edit.insert +
            fixture.source.slice(fixture.edit.to),
        )
      for (const [pass, source] of sources.entries()) {
        const expected =
          formattedOutcomes[`${configuration}/${fixture.name}/${pass}`]
        assert.ok(
          expected,
          `Missing semantic outcome for ${fixture.name}, pass ${pass}`,
        )
        if (pass) {
          afterCount = await page.evaluate(() => window.semanticCountSequence)
          await rich.evaluate((element, edit) => {
            const view = element.cmTile.root.view
            view.dispatch({
              selection: { anchor: edit.from, head: edit.to },
              scrollIntoView: true,
            })
            view.focus()
          }, fixture.edit)
          await page.keyboard.insertText(fixture.edit.insert)
        }
        await waitForAsync(
          page,
          async (source) =>
            (await window.hibi.getDocument()).markdown === source,
          source,
        )
        const expectedHeadings = expected.headings
        const formattedText = expected.text
        const formattedCount = statusLabel(expected.counts)
        // Await a reply sent after this note/edit, so a previous note with
        // identical counts cannot satisfy readiness.
        const current = await page.evaluate(() => window.hibi.getDocument())
        const request = {
          afterCount,
          source,
          text: formattedText,
          document: {
            tabId: current.tabId,
            revision: current.revision,
            contentVersion: current.contentVersion,
          },
        }
        await page.waitForFunction(
          ({ afterCount, source, text, document }) =>
            window.semanticCountReplies.some(
              (reply) =>
                reply.sequence > afterCount &&
                reply.counts &&
                (reply.source === source ||
                  reply.source === text ||
                  (reply.document?.tabId === document.tabId &&
                    reply.document.revision === document.revision &&
                    reply.document.contentVersion === document.contentVersion)),
            ),
          request,
        )
        const reply = await page.evaluate(
          ({ afterCount, source, text, document }) =>
            window.semanticCountReplies.findLast(
              (reply) =>
                reply.sequence > afterCount &&
                reply.counts &&
                (reply.source === source ||
                  reply.source === text ||
                  (reply.document?.tabId === document.tabId &&
                    reply.document.revision === document.revision &&
                    reply.document.contentVersion === document.contentVersion)),
            ),
          request,
        )
        await page.waitForFunction(
          (label) =>
            document.querySelector('[data-status-id="word-count.total"]')
              ?.textContent === label,
          statusLabel(reply.counts),
        )
        await waitForAsync(
          page,
          () =>
            new Promise((resolve) =>
              requestIdleCallback(() => resolve(true), { timeout: 16 }),
            ),
        )
        await t.test(
          `${fixture.name}, pass ${pass}, ${disabled.length ? 'disabled' : 'default'} syntax`,
          { todo: formattedGaps[`${configuration}/${fixture.name}/${pass}`] },
          async (t) => {
            // Outline labels settle independently from word-count replies.
            await page.waitForFunction(
              (labels) =>
                JSON.stringify(
                  [
                    ...document.querySelectorAll(
                      '.outline-sidebar[data-side="right"] .sidebar-label',
                    ),
                  ].map((node) => node.textContent),
                ) === JSON.stringify(labels),
              expectedHeadings,
            )
            const actual = await page.evaluate(() => ({
              counts: document.querySelector(
                '[data-status-id="word-count.total"]',
              )?.textContent,
              headings: [
                ...document.querySelectorAll(
                  '.outline-sidebar[data-side="right"] .sidebar-label',
                ),
              ].map((node) => node.textContent),
            }))
            t.diagnostic(
              JSON.stringify({
                fixture: fixture.name,
                pass,
                disabled,
                expected: {
                  counts: formattedCount,
                  headings: expectedHeadings,
                },
                actual,
              }),
            )
            assert.equal(
              (await page.evaluate(() => window.hibi.getDocument())).markdown,
              source,
            )
            assert.equal(
              await rich.evaluate((element) =>
                element.cmTile.root.view.state.doc.toString(),
              ),
              source.replace(/\r\n?/g, '\n'),
            )
            if (
              fixture.name === 'long paragraph' ||
              fixture.name === 'long fence'
            ) {
              await rich.press('ControlOrMeta+End')
              await rich.evaluate((element) => element.blur())
              if (!disabled.includes('core.heading-1'))
                await rich
                  .getByRole('heading', { name: 'after', exact: true })
                  .waitFor()
            }
            await rich.evaluate((element) => element.blur())
            await page.evaluate(() => new Promise(requestAnimationFrame))
            const visibleText = await rich.evaluate((element) => {
              let text = element.innerText
              for (const label of element.querySelectorAll(
                '.cm-placeholder, .hibi-lp-alert-title',
              ))
                text = text.replace(label.innerText, '')
              return text
            })
            assert.equal(
              visibleText.replace(/\s+/g, ' ').trim(),
              formattedText.replace(/\s+/g, ' ').trim(),
              'visible formatted text matches the native text oracle',
            )
            assert.deepEqual(actual.headings, expectedHeadings)
            assert.equal(
              actual.counts,
              formattedCount,
              'formatted counts exclude Markdown syntax, as in the native Tiptap oracle',
            )
          },
        )
      }
    }
    // Sidebar visibility is persisted across reloads.
    await page.getByRole('button', { name: /^toggle right sidebar$/i }).click()
  }
})
