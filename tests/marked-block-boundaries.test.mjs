import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { getSchema, Node } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import { build } from 'esbuild'
import { Marked } from 'marked'
import { parseFrontmatter } from '../src/addons/frontmatter/markdown.ts'
import { alertMarkdown } from '../src/addons/markdown/alerts.ts'
import { obsidianMarkdown } from '../src/addons/markdown/obsidian.ts'
import { mathTokens } from '../src/addons/math/syntax.ts'
import { mermaidMarkdown } from '../src/addons/mermaid/markdown.ts'
import { textExtrasMarkdown } from '../src/addons/text-extras/syntax.ts'
import { typstMarkdown } from '../src/addons/typst/markdown.ts'
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

// Compare structure and consumed source, excluding inline token spelling.
function boundaries(tokens) {
  return tokens.map((token) => {
    const type = token.type === 'typstBlock' ? 'code' : token.type
    const result = { type, raw: token.raw }
    if (type === 'heading')
      Object.assign(result, { depth: token.depth, text: token.text })
    if (type === 'code') result.text = token.text ?? token.source
    if (type === 'list')
      result.items = token.items.map((item) => ({
        raw: item.raw,
        tokens: boundaries(item.tokens),
      }))
    if (type === 'blockquote') result.tokens = boundaries(token.tokens)
    return result
  })
}

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
        lines: token.raw.trimEnd().split('\n').length,
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
      containerBoundaries(new Marked().lexer(source.replaceAll('$$', '```'))),
      source,
    )
})

test('incomplete math keeps native paragraphs and list continuations', () => {
  for (const source of [
    '- $$unfinished\noutside\n===',
    '> $$unfinished\noutside\n===',
    '- $$\n  missing closer\noutside\n===',
    '> $$\n> missing closer\noutside\n===',
    '-#no space\noutside\n===',
  ])
    assert.deepEqual(
      boundaries(new Marked(mathTokens, textExtrasMarkdown).lexer(source)),
      boundaries(new Marked().lexer(source)),
      source,
    )
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
      new Marked().parse(source).match(/<pre><code>([\s\S]*?)<\/code>/)?.[1],
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

for (const [name, markdown] of [
  ['typstBlock', typstMarkdown],
  ['mermaidBlock', mermaidMarkdown],
])
  test(`${name} rich parsing follows native fence boundaries`, () => {
    const diagram = Node.create({
      name,
      group: 'block',
      atom: true,
      addAttributes: () => ({ source: { default: '' }, raw: { default: '' } }),
      ...markdown,
    })
    const extensions = [StarterKit.configure({ trailingNode: false }), diagram]
    const manager = new MarkdownManager({ marked: new Marked(), extensions })
    const schema = getSchema(extensions)
    for (const eol of ['\n', '\r\n']) {
      const language = name === 'typstBlock' ? 'typst' : 'mermaid'
      const source =
        `> \`\`\`${language}\n> hello\n> \`\`\`\noutside\n===\n\n# real\n`.replaceAll(
          '\n',
          eol,
        )
      const json = manager.parse(source)
      assert.deepEqual(
        json.content.map((node) => node.type),
        ['blockquote', 'heading', 'heading'],
      )
      const found = []
      schema.nodeFromJSON(json).descendants((node) => {
        if (node.type.name === 'heading') found.push(node.textContent)
      })
      assert.deepEqual(found, ['outside', 'real'])
      assert.equal(json.content[0].content[0].type, name)
      assert.equal(json.content[0].content[0].attrs.source, 'hello')
      assert.equal(
        manager.parse(manager.serialize(json)).content[0].content[0].type,
        name,
      )
    }
    if (name === 'typstBlock') {
      assert.equal(
        manager.parse('```typst\nunclosed').content[0].type,
        'codeBlock',
      )
      assert.equal(typstFlavor.detect('```typst\nunclosed'), false)
      assert.equal(
        manager.parse('```js\nhello\n```').content[0].type,
        'codeBlock',
      )
    }
  })

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
