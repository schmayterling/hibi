import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { parser } from '@lezer/markdown'
import { build } from 'esbuild'
import { Lexer, Marked, Tokenizer } from 'marked'
import { outsideCode } from '../src/addons/_shared/import-markdown.ts'
import { exportOptions } from '../src/addons/documentation/options.ts'
import { prepareSite } from '../src/addons/documentation/site.ts'
import { imageSources } from '../src/main/images.ts'
import { parseWorkspaceMetadata } from '../src/main/workspace-index-metadata.ts'
import { WorkspaceMetadataParser } from '../src/main/workspace-metadata-parser.ts'
import { DocumentWorkerService } from '../src/shared/document-worker-service.ts'
import { MarkdownSemanticLexer } from '../src/shared/markdown-semantic-tokens.ts'
import { MarkdownSourceModel } from '../src/shared/markdown-source-model.ts'
import { MarkdownSourceReferences } from '../src/shared/markdown-source-references.ts'
import {
  BlockTokenizer,
  blockMarkdown,
  blockScanCounters,
  lexMarkdown,
  parseMarkdown,
} from '../src/shared/marked-blocks.ts'
import { noteHeadings } from '../src/shared/note-metadata.ts'
import { defaultNoteSyntax, noteLexer } from '../src/shared/note-syntax.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { SourceOwners } from '../src/shared/source-owners.ts'
import { SourceReferences } from '../src/shared/source-references.ts'
import { pageTitle } from '../src/site/title.ts'
import { loadWorker } from './document-worker-transfer.mjs'
import {
  WORKER_HANG_TIMEOUT,
  waitForProgress,
  workerBusyProgress,
} from './worker-progress.mjs'

const bundle = await build({
  stdin: {
    contents: `
      export { renderMarkdown } from './src/renderer/src/render-markdown.ts'
      export { flavors } from './src/renderer/src/flavors.ts'
      export { textProjection } from './src/renderer/src/text-projection.ts'
      export { BlockTokenizer } from './src/shared/marked-blocks.ts'
      export { Tokenizer } from 'marked'
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  plugins: [
    {
      name: 'style-stub',
      setup(bundle) {
        bundle.onResolve({ filter: /\.css\?(raw|inline)$/ }, ({ path }) => ({
          path,
          namespace: 'style-stub',
        }))
        bundle.onLoad({ filter: /.*/, namespace: 'style-stub' }, () => ({
          contents: "export default ''",
          loader: 'js',
        }))
      },
    },
  ],
})
const module = { exports: {} }
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(
  module,
  module.exports,
  createRequire(import.meta.url),
)
const {
  renderMarkdown,
  flavors,
  textProjection,
  BlockTokenizer: ExportBlockTokenizer,
  Tokenizer: ExportTokenizer,
} = module.exports
const size = 50 * 1024 * 1024
const paragraph = 'ordinary words '.repeat(Math.ceil(size / 15)).slice(0, size)
const syntax = {
  key: 'default',
  settings: defaultNoteSyntax,
  complete: true,
  unsupported: false,
}

function references(source, gfm = false) {
  const store = new SourceStore(source, {
    tabId: 'giant-paragraph',
    revision: 0,
  })
  const model = new MarkdownSourceModel(store.snapshot(), parser, 'commonmark')
  const references = new MarkdownSourceReferences({ gfm })
  try {
    while (!model.advance().complete) {}
    for (const _ of references.update(store.snapshot(), model.state().owners)) {
      /* Complete the cooperative read. */
    }
    return references.lookup('ref')
  } finally {
    references.dispose()
    model.dispose()
  }
}

test('html interruptions keep newline searches linear across paragraph starts', (t) => {
  for (const gfm of [false, true]) {
    for (const count of [32, 64, 128]) {
      const source = 'text\n<!-- note --> y\n'.repeat(count)
      const expected = new Marked({ gfm }).lexer(source)
      const indexOf = String.prototype.indexOf
      blockScanCounters.calls = blockScanCounters.units = 0
      let searches = 0
      const probe = t.mock.method(
        String.prototype,
        'indexOf',
        function (needle, ...args) {
          if (needle === '\n') searches++
          return indexOf.call(this, needle, ...args)
        },
      )
      let actual
      try {
        actual = new Marked({ gfm }, blockMarkdown).lexer(source)
      } finally {
        probe.mock.restore()
      }
      assert.deepEqual(actual, expected)
      t.diagnostic(
        JSON.stringify({ gfm, count, searches, ...blockScanCounters }),
      )
      assert.ok(
        searches <= count * 12,
        `${searches} newline searches / ${count} blocks`,
      )
    }
  }
})

test('setext candidate work stops at blank paragraph boundaries', (t) => {
  for (const count of [32, 64, 128, 256]) {
    const source = 'ordinary words\n\n'.repeat(count)
    blockScanCounters.calls = blockScanCounters.units = 0
    const tokens = new Marked({}, blockMarkdown).lexer(source)
    assert.equal(
      tokens.filter((token) => token.type === 'paragraph').length,
      count,
    )
    t.diagnostic(
      JSON.stringify({ count, length: source.length, ...blockScanCounters }),
    )
    assert.equal(blockScanCounters.calls, count)
    assert.ok(blockScanCounters.units <= source.length * 2)
  }
})

test('import translation retains an entire 50 mib ordinary paragraph', () => {
  assert.equal(
    outsideCode(paragraph, (text) => text),
    paragraph,
  )
})

test('semantic tokens retain an entire 50 mib ordinary paragraph', () => {
  const store = new SourceStore(paragraph, { tabId: 'semantics', revision: 0 })
  const owners = new SourceOwners([
    { kind: 'markdown:Paragraph', length: paragraph.length },
  ])
  const references = new SourceReferences(owners, () => ({}))
  const lexer = new MarkdownSemanticLexer({ gfm: false })
  const result = lexer.read(
    store.snapshot(),
    owners,
    owners.get(0).owner.slot,
    references,
  )
  assert.equal(result.tokens[0].type, 'paragraph')
  assert.equal(result.tokens[0].raw, paragraph)
})

test('source references lex an entire 50 mib ordinary paragraph', () => {
  assert.equal(references(paragraph), null)
})

test('workspace metadata lexes an entire 50 mib ordinary paragraph', () => {
  const result = parseWorkspaceMetadata(
    { path: 'note.md', markdown: paragraph },
    syntax,
  )
  assert.equal(result.referenceComplete, true)
  assert.deepEqual(result.references, { links: [], wikilinks: [] })
  assert.deepEqual(result.headings, { items: [], complete: true })
  assert.deepEqual(result.tags, [])
})

test('note headings lex an entire 50 mib ordinary paragraph', () => {
  assert.deepEqual(noteHeadings(paragraph), { items: [], complete: true })
  const { tokens } = noteLexer(paragraph)
  assert.equal(tokens.length, 1)
  assert.equal(tokens[0].type, 'paragraph')
  assert.equal(tokens[0].raw, paragraph)
  assert.equal(tokens[0].tokens[0].raw, paragraph)
})

test('default full-flavor export preserves an entire 50 mib ordinary paragraph', () => {
  assert.equal(renderMarkdown(paragraph).html, `<p>${paragraph}</p>\n`)
})

test('native export collects images from an entire 50 mib ordinary paragraph', () => {
  assert.deepEqual([...imageSources(paragraph)], [])
})

test('native site generation preserves an entire 50 mib ordinary paragraph', () => {
  const site = prepareSite(
    { name: 'notes', pages: [{ path: 'note.md', markdown: paragraph }] },
    exportOptions(),
  )
  assert.equal(site.pages[0].markdown, paragraph)
  assert.equal(site.pages[0].html, `<p>${paragraph}</p>\n`)
})

test('source projection and legacy page titles lex an entire 50 mib ordinary paragraph', () => {
  const result = textProjection(paragraph, true)
  assert.equal(result.text, paragraph)
  assert.deepEqual(result.spans, [
    { from: 0, to: size, sourceFrom: 0, sourceTo: size },
  ])
  assert.equal(pageTitle({ path: 'note.md', markdown: paragraph }), 'note')
})

const corpus = [
  '',
  'ordinary words without a newline',
  '# **title**\n\ntext [link](other.md) #tag\n',
  'title\n===\n\nsecond\n---\n',
  'first line\nsecond line\n---\n\n[ref]: other.md "title"\n\n[ref]\n',
  'title\n  ===  \n\ntrailing\n',
  'title\n\n---\n',
  'title\n    ---\n',
  'title\n\t---\n',
  'title\n2. list\n---\n',
  'title\n- \n---\n',
  '- item\n  continuation\n\n  nested\n  ---\n\n- next\n',
  '1. item\n   - nested\n\n2. next\n',
  '> first\n> second\n> ---\n>\n> [ref]: quote.md\n>\n> [ref]\n',
  '> quote\nlazy\n===\n',
  'before\n<div>\nhtml\n</div>\n\n[ref]: visible.md\n',
  '<script>\n[ref]: hidden.md\n</script>\n\n[ref]: visible.md\n',
  'text <span>inline &amp; html</span>\n---\n',
  '| one | two |\n| --- | :---: |\n| a | b |\n\n[ref]: table.md\n',
  'before\n| one | two |\n| --- | --- |\n| a | b |\n',
  '~~~md\nnot a heading\n---\n~~~\n\n    indented code\n',
  'title\r\nsecond\r\n===\r\n\r\n[ref]: crlf.md\r\n\r\n[ref]\r\n',
  'title\rsecond\r---\r\r[ref]: cr.md\r',
  'caf\u00e9 \u4e16\u754c \ud83c\udf3f\n\u00e9lan\n===\n',
  'before\u2028after\n---\n\nnext\u2029part\n===\n',
  'line\n\u00a0\n---\n',
  'line\n\\---\n\n[ref]: unicode.md\n\n[ref]\n',
  '---\ntitle: property\n---\n\n# heading\n',
]

test('tokens, references, headings, metadata and full export match unpatched marked', (t) => {
  for (const gfm of [false, true]) {
    const remove = flavors.register('corpus', {
      id: 'grammar',
      name: 'grammar',
      kind: 'dialect',
      detect: () => true,
      markedOptions: { gfm },
    })
    try {
      for (const source of corpus) {
        const original = new Marked({ gfm, breaks: false })
        const expected = original.lexer(source)
        if (gfm) {
          const convert = (text) => text.toUpperCase()
          const imported = outsideCode(source, convert)
          const heading = t.mock.method(
            BlockTokenizer.prototype,
            'lheading',
            Tokenizer.prototype.lheading,
          )
          const paragraph = t.mock.method(
            BlockTokenizer.prototype,
            'paragraph',
            Tokenizer.prototype.paragraph,
          )
          try {
            assert.equal(imported, outsideCode(source, convert))
          } finally {
            heading.mock.restore()
            paragraph.mock.restore()
          }
        }
        const settings = {
          ...defaultNoteSyntax,
          gfm,
          wikilinks: false,
          frontmatter: false,
        }
        const lexed = noteLexer(source, settings)
        assert.deepEqual(lexed.tokens, expected, `tokens: ${gfm}: ${source}`)
        assert.deepEqual(
          noteHeadings(source, settings),
          noteHeadings(source, settings, {
            parser: original,
            tokens: expected,
          }),
        )
        const reference = references(source, gfm)
        assert.equal(reference?.href, expected.links.ref?.href)
        assert.equal(
          reference?.title ?? null,
          expected.links.ref?.title ?? null,
        )
        const projection = JSON.stringify(textProjection(source, true))
        const html = renderMarkdown(source).html
        const exportFallback = t.mock.method(
          ExportBlockTokenizer.prototype,
          'lheading',
          ExportTokenizer.prototype.lheading,
        )
        const exportParagraphFallback = t.mock.method(
          ExportBlockTokenizer.prototype,
          'paragraph',
          ExportTokenizer.prototype.paragraph,
        )
        try {
          assert.equal(html, renderMarkdown(source).html)
          assert.equal(projection, JSON.stringify(textProjection(source, true)))
        } finally {
          exportParagraphFallback.mock.restore()
          exportFallback.mock.restore()
        }
        const page = { path: 'note.md', markdown: source }
        const profile = { ...syntax, settings }
        const actual = JSON.stringify(parseWorkspaceMetadata(page, profile))
        const site = JSON.stringify(
          prepareSite({ name: 'notes', pages: [page] }, exportOptions()),
        )
        const images = JSON.stringify([...imageSources(source)])
        const title = pageTitle(page)
        const defaults = new Marked({ gfm: true, breaks: false })
        assert.deepEqual(lexMarkdown(source), defaults.lexer(source))
        assert.equal(parseMarkdown(source), defaults.parse(source))
        const fallback = t.mock.method(
          BlockTokenizer.prototype,
          'lheading',
          Tokenizer.prototype.lheading,
        )
        const paragraphFallback = t.mock.method(
          BlockTokenizer.prototype,
          'paragraph',
          Tokenizer.prototype.paragraph,
        )
        try {
          assert.equal(
            actual,
            JSON.stringify(parseWorkspaceMetadata(page, profile)),
            `metadata: ${gfm}: ${source}`,
          )
          assert.equal(
            site,
            JSON.stringify(
              prepareSite({ name: 'notes', pages: [page] }, exportOptions()),
            ),
          )
          assert.equal(images, JSON.stringify([...imageSources(source)]))
          assert.equal(title, pageTitle(page))
          assert.equal(
            JSON.stringify(reference),
            JSON.stringify(references(source, gfm)),
          )
        } finally {
          paragraphFallback.mock.restore()
          fallback.mock.restore()
        }
      }
    } finally {
      remove()
    }
  }
})

test('setext text and interruption grammar matches unpatched marked across line combinations', () => {
  const lines = [
    'text',
    '',
    ' ',
    '  x',
    '    x',
    '\tx',
    '---',
    '===',
    ' - - - ',
    '- item',
    '- ',
    '2. item',
    '# title',
    '>',
    '<div>',
    '<x>',
    '| - | - |',
    '~~~',
    'x\u2028y',
    '\u00a0',
    '\t',
    '== ',
    '--\t',
  ]
  for (const gfm of [false, true]) {
    const original = new Marked({ gfm })
    const patched = new Marked({ gfm }, blockMarkdown)
    for (const first of lines)
      for (const second of lines)
        for (const last of ['---', '===', 'text']) {
          const source = `${first}\n${second}\n${last}\n`
          assert.deepEqual(
            patched.lexer(source),
            original.lexer(source),
            source,
          )
        }
  }
})

test('giant multiline setext and paragraphs retain full raw text without running the recursive rule', (t) => {
  for (const gfm of [false, true]) {
    const recursive = t.mock.method(
      Lexer.rules.block[gfm ? 'gfm' : 'normal'].lheading,
      'exec',
    )
    const parser = new Marked({ gfm }, blockMarkdown)
    const body = `${paragraph}\ncontinuation`
    const tokens = parser.lexer(`${body}\n\n`)
    assert.equal(tokens[0].type, 'paragraph')
    assert.equal(tokens.map((token) => token.raw).join(''), `${body}\n\n`)
    const headings = parser.lexer(`${body}\n===\n\nending`)
    assert.equal(headings[0].type, 'heading')
    assert.equal(headings[0].depth, 1)
    assert.equal(headings[0].text, body)
    assert.equal(
      headings.map((token) => token.raw).join(''),
      `${body}\n===\n\nending`,
    )
    assert.equal(recursive.mock.callCount(), 0)
    recursive.mock.restore()
  }
})

test('setext scanner preserves independent rules and the nested parser grammar', async () => {
  const require = createRequire(import.meta.url)
  const nestedPath = createRequire(require.resolve('@tiptap/markdown')).resolve(
    'marked',
  )
  const nested = await import(pathToFileURL(nestedPath).href)
  for (const gfm of [false, true]) {
    const tokenizer = new BlockTokenizer()
    new Lexer({ gfm, tokenizer })
    tokenizer.rules = {
      ...tokenizer.rules,
      block: {
        ...tokenizer.rules.block,
        lheading: new RegExp(tokenizer.rules.block.lheading.source),
      },
    }
    assert.equal(tokenizer.lheading(paragraph), undefined)
    const nestedTokenizer = new BlockTokenizer()
    new nested.Lexer({ gfm, tokenizer: nestedTokenizer })
    assert.equal(nestedTokenizer.lheading(paragraph), undefined)
    const original = new nested.Marked({ gfm })
    const patched = new nested.Marked({ gfm }, blockMarkdown)
    for (const source of corpus) {
      assert.deepEqual(patched.lexer(source), original.lexer(source), source)
      const tokenizer = Object.assign(
        new original.Tokenizer(),
        blockMarkdown.tokenizer,
      )
      assert.deepEqual(
        new original.Lexer({ ...original.defaults, tokenizer }).lex(source),
        original.lexer(source),
        source,
      )
    }
  }
})

test('wrapped 50 mib paragraphs avoid the recursive paragraph rule', (t) => {
  const wrapped = 'ordinary words\n'.repeat(Math.ceil(size / 15)).slice(0, size)
  for (const gfm of [false, true]) {
    const tokenizer = new BlockTokenizer()
    const lexer = new Lexer({ gfm, tokenizer })
    const recursive = t.mock.method(tokenizer.rules.block.paragraph, 'exec')
    const token = tokenizer.paragraph(wrapped)
    assert.equal(token.type, 'paragraph')
    assert.equal(token.raw, wrapped)
    assert.equal(token.text, wrapped)
    assert.equal(lexer.inlineQueue[0].src, wrapped)
    assert.equal(recursive.mock.callCount(), 0)
    recursive.mock.restore()
  }
  assert.deepEqual(noteHeadings(wrapped), { items: [], complete: true })
  const metadata = parseWorkspaceMetadata(
    { path: 'note.md', markdown: wrapped },
    syntax,
  )
  assert.equal(metadata.referenceComplete, true)
  assert.deepEqual(metadata.headings, { items: [], complete: true })
  assert.deepEqual([...imageSources(wrapped)], [])
  assert.equal(lexMarkdown(wrapped)[0].raw, wrapped)
  assert.equal(renderMarkdown(wrapped).html, `<p>${wrapped}</p>\n`)
})

test('metadata worker keeps 50 mib note metadata complete and stays alive for the next note', {
  timeout: WORKER_HANG_TIMEOUT,
}, async (t) => {
  const timers = { setTimeout, clearTimeout },
    advances = new Int32Array(new SharedArrayBuffer(4)),
    parser = new WorkspaceMetadataParser(() => ({
      entry: new URL(
        '../src/main/workspace-metadata-worker.ts',
        import.meta.url,
      ),
    }))
  let replies = 0
  const start = parser.start
  t.mock.method(parser, 'start', function (options, ...args) {
    const worker = start.call(
      this,
      {
        ...options,
        entry: new URL(
          './workspace-metadata-progress-worker.mjs',
          import.meta.url,
        ),
      },
      ...args,
    )
    worker.on('message', () => {
      replies++
    })
    worker.postMessage({ progress: advances.buffer })
    return worker
  })
  // Keep the production watchdog on a controlled clock. Worker busy time covers
  // synchronous parser stretches; the real silence guard rejects an idle worker.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(async () => {
    parser.close()
    await parser.stopping
  })
  const parse = async (markdown, version) => {
    let settled = false
    const pending = parser
      .request(
        {
          kind: 'parse',
          page: { id: 'a'.repeat(64), path: 'note.md', markdown },
          syntax,
          version,
          fingerprint: 'giant-paragraph',
        },
        () => true,
      )
      .finally(() => {
        settled = true
      })
    void pending.catch(() => {})
    await waitForProgress(
      () => settled,
      () =>
        replies + Atomics.load(advances, 0) + workerBusyProgress(parser.worker),
      30000,
      () =>
        `Metadata worker remained idle: ${JSON.stringify({ replies, advances: Atomics.load(advances, 0), active: workerBusyProgress(parser.worker) })}`,
      { timers },
    )
    return pending
  }
  const page = await parse(paragraph, 'draft:1')
  const worker = parser.worker
  assert.equal(page.syntax.complete, true)
  assert.equal(page.metadata.referenceComplete, true)
  assert.equal(page.metadata.properties.complete, true)
  assert.equal(page.metadata.headings.complete, true)
  assert.equal(page.metadata.headings.count, 0)
  const next = await parse('# next [link](target.md)', 'draft:2')
  assert.equal(parser.worker, worker)
  assert.equal(next.metadata.headings.count, 1)
  assert.deepEqual(next.metadata.references.links, ['target.md'])
  assert.ok(
    Atomics.load(advances, 0) > 0,
    'the worker must advance the real tokenizer',
  )
  t.diagnostic(
    JSON.stringify({
      replies,
      advances: Atomics.load(advances, 0),
      active: workerBusyProgress(parser.worker),
    }),
  )
})

test('renderer worker resolves references across a giant paragraph and keeps find available', async (t) => {
  const replies = []
  let receive
  const worker = new DocumentWorkerService((reply) => {
    replies.push(reply)
    receive?.(reply)
  })
  t.after(() => worker.dispose())
  const source = `${paragraph}\n\n[ref]: target.md\n`
  loadWorker(worker, replies, source, 'giant')
  const next = (request) =>
    new Promise((resolve) => {
      receive = (reply) => {
        if (
          reply.type === 'error' ||
          (reply.type === request.type && reply.id === request.id)
        ) {
          receive = undefined
          resolve(reply)
        }
      }
      worker.receive({ epoch: 'giant', version: 0, ...request })
    })
  const metadata = await next({
    type: 'metadata',
    id: 1,
    dialect: 'commonmark',
    from: 0,
    to: 0,
    limit: 1,
    reference: { label: 'ref', gfm: false, alerts: false, textExtras: false },
  })
  assert.equal(metadata.type, 'metadata', metadata.message)
  assert.equal(metadata.reference.href, 'target.md')
  loadWorker(worker, replies, 'next target.md', 'next')
  const find = await next({
    epoch: 'next',
    type: 'find',
    id: 2,
    query: 'target.md',
    from: 0,
    to: 0,
  })
  assert.equal(find.type, 'find', find.message)
  assert.equal(find.location.total, 1)
  assert.equal(
    replies.some((reply) => reply.type === 'error'),
    false,
  )
})

test('export keeps a quoted title with a blank line as text, as CommonMark does', {
  todo: 'formatted gap export-001: export must keep a blank-line title definition and its heading as visible text',
}, () => {
  // A quoted title cannot hold a blank line (CommonMark example 197): there
  // is no definition, so its text and heading show and the reference stays
  // literal, as the formatted view shows them.
  const { html } = renderMarkdown(
    '[ref]: /target "first\n\n# title\nlast"\n\n[ref]',
  )
  assert.match(html, /<h1[^>]*>title<\/h1>/)
  assert.doesNotMatch(html, /<a /)
  assert.ok(html.includes('[ref]: /target'), html)
})
