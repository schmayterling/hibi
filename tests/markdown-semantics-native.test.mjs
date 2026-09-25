import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import {
  electron,
  stopElectronTree,
  waitForDocumentEditor,
} from './electron.mjs'

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
    name: 'long heading split',
    source: `# ${'a'.repeat(4094)}[other]: /fake\n\n[other]`,
    unavailable: true,
  },
  {
    name: 'task list',
    source: '- [ ] todo\n- [x] done\n\n# after',
    compatibility: true,
  },
]

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

const syntax = {gfm:true,alerts:true,textExtras:true}
const flavors = [
  {id:'github-markdown.github',markedOptions:{gfm:true},
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
  const results = []
  for (const fixture of cases) {
    let source = fixture.source, id = 0, version = 0
    const pending = new Map()
    const worker = new DocumentWorkerService(reply => {
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
    worker.receive({type:'load',epoch:'native-semantic',document:{tabId:'fixture',revision:0},version,
      chunks:source.match(/[\\s\\S]{1,65536}/g) ?? []})
    try {
      for (let pass=0;pass<(fixture.edit?2:1);pass++) {
        if (pass) {
          worker.receive({type:'edit',epoch:'native-semantic',operation:{
            document:{tabId:'fixture',revision:0},operationId:'edit-reference',baseVersion:version,
            contentVersion:++version,origin:'source',historyGroup:'typing',changes:[fixture.edit],
          }})
          source = source.slice(0,fixture.edit.from)+fixture.edit.insert+source.slice(fixture.edit.to)
        }
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
        const expected = editor.markdown.parse(source)
        const expectedNode = editor.schema.nodeFromJSON(expected)
        const expectedText = getText(expectedNode,{blockSeparator:'\\n',textSerializers:getTextSerializersFromSchema(editor.schema)})
        const actualParts = parts.filter(part=>part.blockCount)
        const actualText = actualParts.map(part=>part.text).join('\\n')
        const expectedHeadings = []
        expectedNode.descendants(node=>{
          if (node.type.name==='heading') expectedHeadings.push({label:node.textContent || 'Untitled heading',level:Number(node.attrs.level)})
        })
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
          ...(same(actual,expected)?{}:{actual,expected}),
        })
      }
    } finally {
      worker.dispose()
      for (const waiter of pending.values()) clearTimeout(waiter.timer)
      pending.clear()
    }
  }
  return {results,preserved:same(original,await window.hibi.getDocument()) && same(originalJSON,editor.getJSON())}
}
`

test('paginated worker semantics match native schema text, headings and counts', {
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
      (cases) => SemanticNativeFixture.run(cases),
      cases,
    )
    await t.test(disabled.length ? 'disabled syntax' : 'default syntax', () => {
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
        }
      }
    })
  }
})
