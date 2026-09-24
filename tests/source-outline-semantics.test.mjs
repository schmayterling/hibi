import assert from 'node:assert/strict'
import test from 'node:test'
import { getSchema } from '@tiptap/core'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import { Strike } from '@tiptap/extension-strike'
import { MarkdownManager } from '@tiptap/markdown'
import { Marked } from 'marked'
import { alertMarkdown } from '../src/addons/markdown/alerts.ts'
import { GithubAlert } from '../src/addons/markdown/GithubAlert.ts'
import { blockMath, inlineMath, mathTokens } from '../src/addons/math/syntax.ts'
import { Subscript, Subtext } from '../src/addons/text-extras/nodes.ts'
import { textExtrasMarkdown } from '../src/addons/text-extras/syntax.ts'
import { documentImage } from '../src/renderer/src/DocumentImage.ts'
import { editorExtensions } from '../src/renderer/src/markdown.ts'
import { createMarkdownSemantics } from '../src/renderer/src/markdown-semantics.ts'
import { markdownSyntax } from '../src/renderer/src/markdown-syntax.ts'
import { SourceOutlineModel } from '../src/renderer/src/source-outline.ts'
import { readFrontmatter } from '../src/shared/frontmatter.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const flavors = [
  {
    id: 'github-markdown.github',
    markedOptions: { gfm: true },
    richExtensions: [GithubAlert, Strike],
    export: { extensions: [alertMarkdown] },
  },
  {
    id: 'text-extras.text-extras',
    richExtensions: [Subscript, Subtext],
    export: { extensions: [textExtrasMarkdown] },
  },
]
const mathFlavor = {
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
        start: (source) => source.indexOf('$$'),
        tokenize: blockMath,
      },
    }),
  ],
  export: { extensions: [mathTokens] },
}
const body = (source) => readFrontmatter(source)?.content ?? source

function nativeHeadings(source, activeFlavors = flavors) {
  const extensions = [
    ...editorExtensions(activeFlavors),
    ...(markdownSyntax.enabled('core.images') ? [documentImage(0)] : []),
  ]
  const markdown = extensions.find((extension) => extension.name === 'markdown')
  const manager = new MarkdownManager({
    extensions,
    marked: markdown.options.marked,
    markedOptions: markdown.options.markedOptions,
  })
  const document = getSchema(extensions).nodeFromJSON(
    manager.parse(body(source)),
  )
  const headings = []
  document.descendants((node) => {
    if (node.type.name === 'heading')
      headings.push({
        label:
          node.textContent.replace(/\s+/g, ' ').trim() || 'Untitled heading',
        level: Number(node.attrs.level),
      })
  })
  return headings
}

function referenceOracle(source) {
  const parser = new Marked({ gfm: true }, alertMarkdown, textExtrasMarkdown)
  const links = new parser.Lexer({ ...parser.defaults, tokenizer: null }).lex(
    body(source),
  ).links
  return (label) => (Object.hasOwn(links, label) ? links[label] : null)
}

function finish(work, resolve) {
  let value
  for (let steps = 0; steps < 100_000; steps++) {
    const step = work.next(value)
    if (step.done) return step.value
    value = step.value ? resolve(step.value.reference) : undefined
  }
  assert.fail('Outline work must converge.')
}

function setup(source, { math = false } = {}) {
  const activeFlavors = math ? [...flavors, mathFlavor] : flavors
  const consumer = createMarkdownSemantics(activeFlavors, 0)
  assert.ok(consumer)
  const store = new SourceStore(source, {
    tabId: 'outline-semantics',
    revision: 0,
  })
  const model = new SourceOutlineModel(store.snapshot(), {
    gfm: true,
    frontmatter: true,
    alerts: true,
    textExtras: true,
    math,
    renderLabel: (tokens, level) =>
      consumer.read(
        [
          {
            type: 'heading',
            raw: '',
            text: '',
            depth: level,
            tokens: [...tokens],
          },
        ],
        { before: false, after: false },
      )?.headings[0]?.label ?? null,
  })
  return { store, model, activeFlavors }
}

function edit(store, model, changes) {
  const before = store.snapshot()
  const prepared = store.prepare({
    document: before.document,
    operationId: crypto.randomUUID(),
    baseVersion: before.version,
    contentVersion: before.version + 1,
    origin: 'source',
    historyGroup: 'test',
    changes,
  })
  store.commit(prepared)
  model.apply(prepared)
}

function check(source, options) {
  const { model, activeFlavors } = setup(source, options)
  try {
    const actual = finish(model.read(), referenceOracle(source))
    assert.deepEqual(
      actual.map(({ label, level }) => ({ label, level })),
      nativeHeadings(source, activeFlavors),
      source,
    )
    return actual
  } finally {
    model.dispose()
  }
}

test('source outline labels match native reference links before and after declarations', () => {
  for (const source of [
    '[ref]: /before\n\n# [visible][ref] and [missing][absent]',
    '# [visible][ref] and [ref][] and [ref]\n\n[ref]: /after',
    '[ref]: /first\n\n# [**bold** *soft*][ref]\n\n[REF]: /second',
    '# [missing][ref] and ![missing image][image]',
    '# [UPPER  Case]\n\n[upper case]: /normalized',
    '# [constructor] and [toString] and [__proto__]',
  ])
    check(source)
})

test('source outline labels ignore declarations inside fences and frontmatter', () => {
  for (const source of [
    '```md\n[ref]: /fake\n```\n\n# [label][ref]',
    '# [label][ref]\n\n```md\n[ref]: /fake\n```\n\n[ref]: /real',
    '---\ntitle: document\nbody: |\n  [ref]: /fake\n  # hidden\n---\n\n# [label][ref]',
    '---\ntitle: document\nbody: |\n  [ref]: /fake\n---\n\n[ref]: /real\n\n# [label][ref]',
  ])
    check(source)
})

test('source outline labels match native entities, nested formatting, and text extras', () => {
  for (const source of [
    '# &amp; &#65; &#x1F600; \\*literal\\* **bold *soft*** `&amp;`',
    '# ~~strike~~ H~2~O and **nested ~sub~ text**',
    '> ## quote [*soft*](https://example.test)\n\n- ### list **bold**',
    '## ![image alt](image.png) tail ![ref alt][image]\n\n[image]: image.png',
    '# ![only image](image.png)',
  ])
    check(source)
  assert.equal(check('# ![image alt](image.png) tail')[0].label, 'tail')
})

test('source outline labels preserve disabled inline syntax exactly like native headings', () => {
  const ids = ['core.bold', 'core.links', 'core.inline-code', 'core.images']
  try {
    for (const id of ids) markdownSyntax.setEnabled(id, false)
    check('# **bold** [link](/target) `code` ![image](image.png)')
    check(
      '# [**bold**][ref] ![image][picture]\n\n[ref]: /target\n[picture]: image.png',
    )
  } finally {
    for (const id of ids) markdownSyntax.setEnabled(id, true)
  }
})

test('source outline refuses source changes while a reference response is pending', () => {
  const source = '# [visible][ref]\n\n[ref]: /target'
  const { store, model } = setup(source)
  try {
    const work = model.read()
    let step
    for (let count = 0; count < 100_000; count++) {
      step = work.next()
      assert.equal(step.done, false)
      if (step.value) break
    }
    assert.deepEqual(step.value, { reference: 'ref' })
    edit(store, model, [{ from: 3, to: 10, insert: 'latest' }])
    assert.throws(() => work.next({ href: '/target' }), /stale/)
    const updated = '# [latest][ref]\n\n[ref]: /target'
    assert.deepEqual(
      finish(model.read(), referenceOracle(updated)).map(({ label }) => label),
      ['latest'],
    )
  } finally {
    model.dispose()
  }
})

test('definition-only edits invalidate cached heading labels and missing references', () => {
  const source = '# [visible][ref]\n\n[other]: /target'
  const { store, model } = setup(source)
  try {
    const before = finish(model.read(), referenceOracle(source))
    assert.equal(before[0].label, '[visible][ref]')
    const from = source.indexOf('other')
    edit(store, model, [{ from, to: from + 5, insert: 'ref' }])
    const updated = source.replace('[other]:', '[ref]:')
    const after = finish(model.read(), referenceOracle(updated))
    assert.equal(after[0].label, 'visible')
    assert.equal(before[0].label, '[visible][ref]')
    edit(store, model, [{ from, to: from + 3, insert: 'other' }])
    assert.equal(
      finish(model.read(), referenceOracle(source))[0].label,
      '[visible][ref]',
    )
  } finally {
    model.dispose()
  }
})

test('source outline labels preserve native inline math atoms', () => {
  check('# before $x^2$ after and **$y$**', { math: true })
})
