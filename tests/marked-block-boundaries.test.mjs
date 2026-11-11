import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import { Lexer, Marked } from 'marked'
import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'
import { parseFrontmatter } from '../src/addons/frontmatter/markdown.ts'
import { alertMarkdown } from '../src/addons/markdown/alerts.ts'
import { obsidianMarkdown } from '../src/addons/markdown/obsidian-markdown.ts'
import { blockMath as readMath } from '../src/addons/math/grammar.ts'
import { formulaLimit } from '../src/addons/math/inline-display.ts'
import { mathTokens, mathTokensWith } from '../src/addons/math/syntax.ts'
import { textExtrasMarkdown } from '../src/addons/text-extras/syntax.ts'
import {
  typstBlock,
  typstFlavor,
  typstTokens,
} from '../src/addons/typst/syntax.ts'
import {
  countParser,
  richText,
} from '../src/addons/word-count/formatted-text.ts'
import { markdownSourceParser } from '../src/shared/markdown-source-references.ts'
import { blockMarkdown } from '../src/shared/marked-blocks.ts'
import { markedGithubFootnote } from '../src/shared/marked-footnotes.ts'
import { leafBlockCounters } from '../src/shared/marked-leaf-blocks.ts'
import { defaultNoteSyntax, noteParser } from '../src/shared/note-syntax.ts'

// Native quotes can insert phantom blank lines in raw. Compare grammar and
// nonblank source here; marked-quote-raw checks exact source consumption.
function boundaries(tokens) {
  return tokens
    .filter((token) => token.type !== 'space')
    .map((token) => {
      const type = token.type === 'typstBlock' ? 'code' : token.type
      // Native quotes also splice list text over markers; their raw is unsafe
      // as a source oracle. The separate corpus test below checks physical raw.
      const result = { type }
      if (type !== 'blockquote') result.raw = token.raw.replace(/\n+$/, '')
      // Native padding is not paragraph content (CommonMark §5.2).
      if (type === 'paragraph' || type === 'text')
        result.raw = result.raw.replace(
          /\n {4}(?=(?:=+|-+)[ \t]*(?:\n|$))/g,
          '\n',
        )
      if (type === 'heading')
        Object.assign(result, { depth: token.depth, text: token.text })
      if (type === 'code') result.text = token.text ?? token.source
      if (type === 'list')
        result.items = token.items.map((item) => ({
          raw: item.raw.replace(/\n+$/, ''),
          tokens: boundaries(item.tokens),
        }))
      if (type === 'blockquote') result.tokens = boundaries(token.tokens)
      return result
    })
}

const expandTabs = (source) =>
  source
    .split('\n')
    .map((line) => {
      let text = ''
      for (const char of line)
        text += char === '\t' ? ' '.repeat(4 - (text.length % 4)) : char
      return text
    })
    .join('\n')
function containerBoundaries(tokens) {
  return tokens
    .filter((token) => token.type !== 'space')
    .map((token) => {
      const leaf =
        ['blockMath', 'subtext', 'footnoteDef', 'code'].includes(token.type) ||
        (token.type === 'heading' && token.text === 'small')
      const result = {
        type: leaf
          ? 'leaf'
          : token.type === 'githubAlert'
            ? 'blockquote'
            : token.type,
        lines: ['blockquote', 'githubAlert'].includes(token.type)
          ? token.raw.trimEnd().split('\n').filter(Boolean).length
          : token.raw.trimEnd().split('\n').length,
      }
      if (token.type === 'heading' && !leaf) result.text = token.text
      if (['blockquote', 'githubAlert'].includes(token.type)) {
        const children =
          token.type === 'blockquote' &&
          ['paragraph', 'text'].includes(token.tokens[0]?.type) &&
          token.tokens[0]?.text?.startsWith('[!')
            ? token.tokens.slice(1)
            : token.tokens
        result.tokens = containerBoundaries(children)
      }
      if (token.type === 'list')
        result.items = token.items.map((item) =>
          containerBoundaries(item.tokens),
        )
      return result
    })
}

const containers = {
  root: (body) => body,
  quote: (body) =>
    body
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
  nestedQuote: (body) =>
    body
      .split('\n')
      .map((line) => `> > ${line}`)
      .join('\n'),
  list: (body) => `- ${body.replaceAll('\n', '\n  ')}`,
  ordered: (body) => `1. ${body.replaceAll('\n', '\n   ')}`,
  quoteList: (body) => `> - ${body.replaceAll('\n', '\n>   ')}`,
  listQuote: (body) => `- > ${body.replaceAll('\n', '\n  > ')}`,
}
// Marked ends a lazy item after a nested leaf only within its begin-rule indent.
const nestedContainers = {
  nestedList: (body) => `1. - ${body.replaceAll('\n', '\n     ')}`,
  deepList: (body) => `- 1. ${body.replaceAll('\n', '\n     ')}`,
  quoteNestedList: (body) => `> 1. * ${body.replaceAll('\n', '\n>      ')}`,
}
const tails = [
  'outside\n===\n\n# real\n',
  'outside\n---\n\n# real\n',
  'lazy continuation\n\n# real\n',
  '\n# real\n',
  '\n- next\n\n# real\n',
  '> resumed\n\n# real\n',
]
const corpus = []
for (const lang of ['typst', 'mermaid', 'js', ''])
  for (const fence of ['```', '~~~~'])
    for (const closed of [true, false])
      for (const [container, wrap] of Object.entries(containers))
        for (const tail of tails)
          for (const eol of ['\n', '\r\n']) {
            const body = `${fence}${lang}\nhello\n# inside${closed ? `\n${fence}` : ''}`
            const source = `${wrap(body)}\n${tail}`.replaceAll('\n', eol)
            corpus.push({
              name: `${lang || 'plain'} ${fence} ${closed ? 'closed' : 'open'} ${container} ${JSON.stringify(tail)} ${JSON.stringify(eol)}`,
              source,
            })
          }

test('quoted typst keeps the following setext heading in tokens and export', () => {
  const source = '> ```typst\n> hello\n> ```\noutside\n===\n\n# real\n'
  const parser = new Marked(typstTokens)
  assert.deepEqual(
    parser.lexer(source).map(({ type }) => type),
    ['blockquote', 'heading', 'space', 'heading'],
  )
  assert.match(parser.parse(source), /<h1>outside<\/h1>/)
  const tabs = '>  ```typst\n> \tcode\n>  ```'
  const native = new Marked(blockMarkdown).lexer(tabs)[0].tokens[0]
  assert.ok(
    new Marked(blockMarkdown, typstTokens)
      .parse(tabs)
      .includes(`data-typst="${encodeURIComponent(native.text)}"`),
  )
})

test('renderMarkdown exports the diagram and following headings', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        export { renderMarkdown } from './src/renderer/src/render-markdown.ts'
        export { flavors } from './src/renderer/src/flavors.ts'
        export { typstFlavor, typstTokens } from './src/addons/typst/syntax.ts'
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
  const { renderMarkdown, flavors, typstFlavor, typstTokens } = module.exports
  const remove = flavors.register('typst', {
    ...typstFlavor,
    export: { extensions: [typstTokens] },
  })
  try {
    const source = '> ```typst\n> hello\n> ```\noutside\n===\n\n# real\n'
    const { html } = renderMarkdown(source)
    assert.match(
      html,
      /<blockquote>\n<pre data-typst="hello"><\/pre><\/blockquote>/,
    )
    assert.match(html, /<h1>outside<\/h1>/)
    assert.match(html, /<h1>real<\/h1>/)
    assert.match(renderMarkdown('```js\nhello\n```').html, /language-js/)
    assert.doesNotMatch(renderMarkdown('```typst\nunclosed').html, /data-typst/)
  } finally {
    remove()
  }
})

test('closed typst detection uses CommonMark fence grammar and body indentation', () => {
  for (const [source, closed] of [
    ['  ```typst\n x\n  ```\n', true],
    ['~~~TyPsT\nx\n~~~~\n', true],
    ['```typst\n```', true],
    ['```typst', false],
    ['```typst\nunclosed', false],
    ['```typst\nx\n```\t\nafter', true],
    ['```typst\nx\n```\u2028after', false],
    ['```typst\nx\n```~~~\nafter', false],
    ['~~~typst\nx\n~~~```\nafter', false],
  ]) {
    const native = new Marked(blockMarkdown).lexer(source)[0]
    const block = typstBlock(source)
    if (!closed) assert.equal(block, undefined, source)
    else
      assert.deepEqual(
        block,
        { type: 'typstBlock', source: native.text, raw: native.raw },
        source,
      )
  }
  assert.equal(typstFlavor.detect('```typst\nunclosed'), false)
})

// Each leaf has the same container boundary as a native code or heading block.
for (const [name, extension, body] of [
  ['math', mathTokens, '> $$\n> x\n> $$'],
  ['subtext', textExtrasMarkdown, '> -# small'],
  ['alert', alertMarkdown, '> > [!NOTE]\n> > ```\n> > x\n> > ```'],
  ['footnote', markedGithubFootnote(), '[^1]: ```\n    x\n    ```'],
])
  test(`${name} preserves the following top-level heading`, () => {
    const source = `${body}\noutside\n===\n\n# real\n`
    assert.deepEqual(
      new Marked(extension)
        .lexer(source)
        .filter((token) => token.type === 'heading')
        .map((token) => token.text),
      ['outside', 'real'],
    )
  })

for (const [name, extension, body, nativeBody] of [
  ['math', mathTokens, '$$\nx\n$$', '```math\nx\n```'],
  ['subtext', textExtrasMarkdown, '-# small', '# small'],
]) {
  for (const [container, wrap] of Object.entries({
    ...containers,
    ...nestedContainers,
  }))
    for (const tail of tails)
      for (const eol of ['\n', '\r\n'])
        test(`${name} native boundary: ${container} ${JSON.stringify(tail)} ${JSON.stringify(eol)}`, () => {
          const source = `${wrap(body)}\n${tail}`.replaceAll('\n', eol)
          const oracle = `${wrap(nativeBody)}\n${tail}`.replaceAll('\n', eol)
          const headings = (parser, text) => {
            const result = []
            const visit = (tokens, parents = []) => {
              for (const token of tokens) {
                if (token.type === 'heading' && token.text !== 'small')
                  result.push([...parents, token.text])
                if (token.type === 'blockquote')
                  visit(token.tokens, [...parents, 'quote'])
                if (token.type === 'list')
                  for (const item of token.items)
                    visit(item.tokens, [...parents, 'list'])
              }
            }
            visit(parser.lexer(text))
            return result
          }
          assert.deepEqual(
            headings(new Marked(extension), source),
            headings(new Marked(), oracle),
            source,
          )
          assert.deepEqual(
            containerBoundaries(new Marked(extension).lexer(source)),
            containerBoundaries(new Marked().lexer(oracle)),
            source,
          )
        })
}

test('tab-indented item lines after math stay in the item', () => {
  for (const source of [
    '1. > -\t$$\n   > \tx\n   > \t$$\n   > \tpara\n\n# real\n',
    '- \t$$\n  \tx\n  \t$$\n  \tpara\nlazy\n',
  ])
    assert.deepEqual(
      containerBoundaries(new Marked(mathTokens).lexer(source)),
      // CommonMark §2.2: structural tabs use physical four-column stops.
      containerBoundaries(
        new Marked().lexer(expandTabs(source.replaceAll('$$', '```'))),
      ),
      source,
    )
})

test('unclosed math runs to the end of its quote or list item, as in Obsidian', () => {
  const marked = new Marked(mathTokens, textExtrasMarkdown)
  // Expectations from Obsidian 1.13.7: an item takes the lazy lines after it,
  // a quote ends where its lazy lines no longer continue a paragraph.
  for (const [source, formulas] of [
    ['- $$unfinished\noutside\n===', ['unfinished\noutside\n===']],
    ['> $$unfinished\noutside\n===', []],
    ['- $$\n  missing closer\noutside\n===', ['missing closer\noutside\n===']],
    ['> $$\n> missing closer\noutside\n===', ['missing closer']],
  ]) {
    const found = []
    marked.walkTokens(marked.lexer(source), (token) => {
      if (token.type === 'blockMath') found.push(token.latex)
    })
    assert.deepEqual(found, formulas, source)
  }
  const source = '-#no space\noutside\n==='
  assert.deepEqual(
    boundaries(marked.lexer(source)),
    boundaries(new Marked().lexer(source)),
  )
})

test('list math keeps physical lazy underlines through nested containers', () => {
  const cases = [
    ['- $$x\noutside\n===', '$$x\noutside\n==='],
    ['- para\n  $$x\nfoo\n===', '$$x\nfoo\n==='],
    ['> - $$x\n> outside\n> ===', '$$x\noutside\n==='],
    ...['- 1.', '- -', '> - -', '1. -', '- - -'].map((marker) => [
      `${marker} $$x\n${marker.startsWith('>') ? '> ' : ''}outside\n${marker.startsWith('>') ? '> ' : ''}===`,
      '$$x\noutside\n===',
    ]),
    ...[1, 2, 3].map((spaces) => [
      `- $$x\noutside\n${' '.repeat(spaces)}===`,
      `$$x\noutside\n${' '.repeat(spaces < 2 ? spaces : spaces - 2)}===`,
    ]),
    ['- $$x\n      ===', '$$x\n    ==='],
    ['- - $$x\n      ===', '$$x\n  ==='],
    ['- $$x\noutside\n===\t\nmore', '$$x\noutside\n===\t\nmore'],
  ]
  for (const shared of [false, true]) {
    const parser = new Marked(...(shared ? [blockMarkdown] : []), mathTokens)
    for (const [source, physical] of cases) {
      const tokens = parser.lexer(source),
        found = []
      parser.walkTokens(tokens, (token) => {
        if (token.type === 'blockMath')
          found.push({ raw: token.raw, latex: token.latex })
        if (token.type === 'list')
          for (const item of token.items) {
            let rest = item.text
            for (const child of item.tokens) {
              const at = rest.indexOf(child.raw)
              assert.ok(at >= 0, source)
              rest = rest.slice(at + child.raw.length)
            }
            assert.ok(token.raw.includes(item.raw), source)
          }
      })
      assert.deepEqual(
        found,
        [{ raw: physical.trimEnd(), latex: readMath(physical).latex }],
        source,
      )
      assert.equal(tokens.map((token) => token.raw).join(''), source)
    }
  }
})

test('list source padding cannot change the formula limit or replay extensions', () => {
  for (const shared of [false, true])
    for (const enabled of [false, true])
      for (const slack of [-1, 0, 3, 4]) {
        // body includes the newline before the closing line.
        const physical = `$$${'x'.repeat(formulaLimit - 13 - slack)}\noutside\n===\n$$`
        const expected = readMath(physical)
        let reads = 0
        const extension = mathTokensWith(() => enabled)
        const math = extension.extensions.find(
          (rule) => rule.name === 'blockMath',
        )
        const read = math.tokenizer
        math.tokenizer = function (...args) {
          const token = read.apply(this, args)
          if (token) reads++
          return token
        }
        const parser = new Marked(...(shared ? [blockMarkdown] : []), extension)
        const tokens = parser.lexer(
          `- ${physical.replace(/\n\$\$$/, () => '\n  $$')}`,
        )
        const found = []
        parser.walkTokens(tokens, (token) => {
          if (['blockMath', 'blockMathText'].includes(token.type))
            found.push(token)
        })
        if (enabled || slack >= 0) {
          assert.equal(found.length, 1)
          assert.equal(found[0].type, expected.type)
          assert.equal(found[0].raw, physical)
          assert.equal(found[0].latex, expected.latex)
        }
        assert.equal(
          reads,
          enabled || slack >= 0 ? 1 : 0,
          `no math replay: ${shared}/${enabled}/${slack}`,
        )
      }
})

test('lazy list underlines stay paragraph text while indented underlines stay headings', () => {
  // CommonMark §5.2: laziness extends paragraph text, never a setext heading.
  // Marked #4126's padding misses short and nested lazy lines.
  for (const source of [
    '1. e\n=',
    '- e\nf\n===',
    '- - para\noutside\n===',
    '- 1. e\nf\n===',
    '- - [ ] x\noutside\n===',
    '- e\n=\t',
    '- e\n  =',
    '- - e\n    ===',
    '- [a]: /b\n===',
    '- a\n===\n  para\n===',
  ])
    for (const tables of [false, true]) {
      for (const extension of [blockMarkdown, mathTokens]) {
        const parser = new Marked(extension, { gfm: tables })
        const html = micromark(
          source,
          tables ? { extensions: [gfm()], htmlExtensions: [gfmHtml()] } : {},
        )
        const compact = (html) =>
          html
            .trim()
            .replace(/>\n(?=<)/g, '>')
            .replace(/<input\b[^>]*>/g, '<input type="checkbox" disabled="">')
        assert.equal(compact(parser.parse(source)), compact(html), source)
      }
    }
  const parser = new Marked(blockMarkdown)
  assert.equal(parser.lexer('real\n===')[0].type, 'heading')
  // Genuine four-space continuation is content, not synthetic padding.
  assert.equal(parser.lexer('- e\n      ===')[0].items[0].text, 'e\n    ===')
  assert.equal(
    new Marked(blockMarkdown, { pedantic: true }).parse('- e\n='),
    new Marked({ pedantic: true }).parse('- e\n='),
  )
})

test('lazy list merges leave original tokens visible to addons', () => {
  const seen = []
  const inspect = {
    extensions: [
      {
        name: 'inspectListMerge',
        level: 'block',
        tokenizer(source, tokens) {
          if (source.startsWith('b\n') || source === '===') {
            const last = tokens.at(-1)
            seen.push([source, last?.raw, last?.text])
          }
        },
      },
    ],
  }
  const [list] = new Marked(blockMarkdown, inspect).lexer('- a\nb\n===\n')
  assert.deepEqual(seen, [
    ['b\n===', 'a\n', 'a'],
    ['===', 'a\nb\n', 'a\nb'],
  ])
  assert.equal(list.items[0].tokens[0].raw, list.items[0].text)
})

test('nested addon probes do not arm outer list text merges', () => {
  const [list] = new Marked(blockMarkdown, {
    extensions: [
      {
        name: 'nestedListProbe',
        level: 'block',
        tokenizer(source) {
          if (!source.startsWith('[ref]:')) return
          const top = this.lexer.state.top
          try {
            this.lexer.blockTokens('probe')
          } finally {
            this.lexer.state.top = top
          }
        },
      },
    ],
  }).lexer('- a\n[ref]: /x\n===\n')
  assert.equal(list.items[0].tokens[0].raw, list.items[0].text)
  assert.equal(list.items[0].tokens[0].text, list.items[0].text)
})

test('rewritten text raw keeps native list merge behavior', () => {
  const [list] = new Marked(blockMarkdown, {
    tokenizer: {
      text(source) {
        if (!source.startsWith('a\n')) return false
        return {
          type: 'text',
          raw: '@a',
          text: 'a',
          tokens: this.lexer.inline('a'),
        }
      },
    },
  }).lexer('- a\nb\n===\n')
  assert.equal(list.items[0].tokens[0].raw, '@a\nb\n===')
  assert.equal(list.items[0].tokens[0].text, 'a\nb\n===')
})

test('plain addons leave headings outside list context to the native reader', () => {
  const source = 'para\n$$x\nfoo\n===\n'
  const tokens = new Marked(mathTokens).lexer(source)
  assert.equal(tokens[0].type, 'heading')
  assert.equal(tokens[0].text, 'para\n$$x\nfoo')
  assert.equal(tokens[0].raw, source)
  // The full Markdown grammar deliberately stops setext text at addon starts.
  const full = new Marked(blockMarkdown, mathTokens).lexer(source)
  assert.deepEqual(
    full.map((token) => token.type),
    ['paragraph', 'blockMath'],
  )
})

test('failed list reads restore lazy heading context and parser hooks', () => {
  const sentinel = new Error('list probe')
  let itemTokens
  const parser = new Marked(blockMarkdown, {
    extensions: [
      {
        name: 'explode',
        level: 'block',
        tokenizer(source, tokens) {
          if (source.startsWith('explode')) {
            itemTokens = tokens
            throw sentinel
          }
        },
      },
    ],
  })
  const lexer = new Lexer(parser.defaults)
  const rules = lexer.tokenizer.rules,
    read = lexer.blockTokens,
    text = lexer.tokenizer.text
  assert.throws(
    () => lexer.lex('- explode\n==='),
    (error) => error === sentinel,
  )
  assert.equal(lexer.tokenizer.rules, rules)
  assert.equal(lexer.blockTokens, read)
  assert.equal(lexer.tokenizer.text, text)
  assert.equal(Object.hasOwn(itemTokens, 'at'), false)
  assert.equal(lexer.tokenizer.lheading('explode\n===').type, 'heading')
})

for (const [name, extension, body] of [
  ['alert', alertMarkdown, '> [!NOTE]\n> ```\n> x\n> ```'],
  ['footnote', markedGithubFootnote(), '[^1]: ```\n    x\n    ```'],
]) {
  for (const [container, wrap] of Object.entries(containers))
    for (const eol of ['\n', '\r\n'])
      test(`${name} closed code boundaries in ${container} ${JSON.stringify(eol)}`, () => {
        const source = `${wrap(body)}\noutside\n===\n\n# real\n`.replaceAll(
          '\n',
          eol,
        )
        const tokens = new Marked(extension).lexer(source)
        const nativeBody = name === 'footnote' ? '```\nx\n```' : body
        const oracleSource =
          `${wrap(nativeBody)}\noutside\n===\n\n# real\n`.replaceAll('\n', eol)
        const oracle = new Marked().lexer(oracleSource)
        const headings = (tokens) =>
          tokens
            .filter((token) => token.type === 'heading')
            .map((token) => token.text)
        assert.deepEqual(headings(tokens), headings(oracle))
        assert.deepEqual(
          containerBoundaries(tokens),
          containerBoundaries(oracle),
        )
        if (
          oracle.map((token) => token.raw).join('') ===
          oracleSource.replaceAll('\r\n', '\n')
        )
          assert.equal(
            tokens.map((token) => token.raw).join(''),
            source.replaceAll('\r\n', '\n'),
          )
      })
}

test('container re-reads keep one footnote back-link per reference', () => {
  for (const alerts of [false, true])
    for (const body of [
      '> > [!NOTE]\n> > body[^a]\nlazy',
      '> > [!NOTE]\n> > body[^a]\n> > ```\n> > x\n> > ```\noutside\n===',
      '| cell |\n| --- |\n| ref[^a] |',
      '> > [!NOTE]\n> > | cell |\n> > | --- |\n> > | ref[^a] |',
    ]) {
      const html = new Marked(
        ...(alerts ? [alertMarkdown] : []),
        markedGithubFootnote(),
      ).parse(`${body}\n\n[^a]: note`)
      assert.equal((html.match(/data-footnote-ref\b/g) ?? []).length, 1)
      assert.equal((html.match(/data-footnote-backref\b/g) ?? []).length, 1)
    }
})

test('lazy quote continuations visit each block once', () => {
  // Marked re-reads a quote per lazy line into the same token list.
  const units = 2000
  const source = '> # h\n> p\nlazy\n'.repeat(units)
  const parser = new Marked(mathTokens, textExtrasMarkdown, alertMarkdown)
  leafBlockCounters.visits = 0
  const [quote] = parser.lexer(source)
  assert.equal(quote.type, 'blockquote')
  assert.equal(
    quote.tokens.filter((token) => token.type === 'heading').length,
    units,
  )
  assert.ok(
    leafBlockCounters.visits < units * 4,
    String(leafBlockCounters.visits),
  )
})

test('footnote boundary probes do not register inline references', () => {
  const source = '[^a]: a\n\n[^b]: -# inner[^a]\n\nUse[^b].'
  const html = new Marked(textExtrasMarkdown, markedGithubFootnote()).parse(
    source,
  )
  assert.equal((html.match(/data-footnote-ref\b/g) ?? []).length, 2)
  assert.equal((html.match(/data-footnote-backref\b/g) ?? []).length, 2)
})

test('tabbed nested alerts retain their renderer after native continuation', () => {
  for (const eol of ['\n', '\r\n']) {
    const source =
      '> > [!NOTE]\n> > ```\n> > \tx\n> > ```\noutside\n===\n'.replaceAll(
        '\n',
        eol,
      )
    const html = new Marked(alertMarkdown).parse(source)
    assert.match(html, /data-alert="note"/)
    assert.match(html, /<h1>outside<\/h1>/)
    assert.equal(
      html.match(/<pre><code>([\s\S]*?)<\/code>/)?.[1],
      // CommonMark §4.5 preserves literal code tabs; Marked #4110 expands them.
      micromark(source)
        .replaceAll('\r\n', '\n')
        .match(/<pre><code>([\s\S]*?)<\/code>/)?.[1],
    )
  }
})

const flavors = {
  typst: () => new Marked(typstTokens),
  frontmatter: () => ({
    lexer: (source) =>
      new Marked().lexer(
        parseFrontmatter(`---\ntitle: example\n---\n${source}`).content,
      ),
  }),
  mermaid: () => new Marked(), // Mermaid consumes native code tokens; no block tokenizer.
  math: () => new Marked(mathTokens),
  alerts: () => new Marked(alertMarkdown),
  textExtras: () => new Marked(textExtrasMarkdown),
  footnotes: () => new Marked(markedGithubFootnote()),
  obsidian: () => new Marked(obsidianMarkdown),
  shared: () => new Marked(blockMarkdown),
  note: () => noteParser({ ...defaultNoteSyntax, gfm: true, wikilinks: true }),
  references: () =>
    markdownSourceParser({
      gfm: true,
      math: true,
      alerts: true,
      textExtras: true,
    }),
  counts: () =>
    countParser({
      ...defaultNoteSyntax,
      gfm: true,
      wikilinks: true,
      typst: true,
      mermaid: true,
      math: true,
      alerts: true,
      textExtras: true,
    }),
  combined: () =>
    new Marked(
      typstTokens,
      mathTokens,
      alertMarkdown,
      textExtrasMarkdown,
      obsidianMarkdown,
      markedGithubFootnote(),
      blockMarkdown,
    ),
}

test('typst word counts exclude diagrams and keep following headings', () => {
  const source = '> ```typst\n> diagram body\n> ```\noutside\n===\n\n# real\n'
  const syntax = { ...defaultNoteSyntax, typst: true }
  const text = richText(source, syntax)
  assert.match(text, /outside/)
  assert.match(text, /real/)
  assert.doesNotMatch(text, /diagram body/)
  assert.match(richText(source, { ...syntax, typst: false }), /diagram body/)
  assert.match(
    richText(source, { ...syntax, disabledFeatures: ['typst.blocks'] }),
    /diagram body/,
  )
  assert.match(richText('```typst\nunclosed', syntax), /unclosed/)
})

test('quote corpus raw consumes exactly the physical source', () => {
  const parser = new Marked(blockMarkdown)
  for (const { name, source } of corpus) {
    let rest = source.replaceAll('\r\n', '\n')
    for (const token of parser.lexer(source)) {
      assert.ok(
        rest.startsWith(token.raw),
        `${name}: ${JSON.stringify(token.raw)}`,
      )
      rest = rest.slice(token.raw.length)
    }
    assert.equal(rest, '', name)
  }
})

for (const [flavor, makeParser] of Object.entries(flavors))
  test(`${flavor} keeps native headings and container boundaries (${corpus.length} cases)`, () => {
    const native = new Marked(),
      parser = makeParser()
    for (const { name, source } of corpus)
      assert.deepEqual(
        boundaries(parser.lexer(source)),
        boundaries(native.lexer(source)),
        `${name}\n${JSON.stringify(source)}`,
      )
  })
