import assert from 'node:assert/strict'
import test from 'node:test'
import { getSchema } from '@tiptap/core'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import { Strike } from '@tiptap/extension-strike'
import { MarkdownManager } from '@tiptap/markdown'
import { Marked } from 'marked'
import { alertMarkdown } from '../src/addons/markdown/alerts.ts'
import { GithubAlert } from '../src/addons/markdown/GithubAlert.ts'
import {
  blockMath,
  blockMathStart,
  inlineMath,
  mathTokens,
} from '../src/addons/math/syntax.ts'
import { Subscript, Subtext } from '../src/addons/text-extras/nodes.ts'
import { textExtrasMarkdown } from '../src/addons/text-extras/syntax.ts'
import { documentImage } from '../src/renderer/src/DocumentImage.ts'
import { editorExtensions } from '../src/renderer/src/markdown.ts'
import { markdownSyntax } from '../src/renderer/src/markdown-syntax.ts'
import { SourceOutlineModel } from '../src/renderer/src/source-outline.ts'
import { createOutlineLabelRenderer } from '../src/renderer/src/source-outline-label.ts'
import { createOutlineLabelReader } from '../src/renderer/src/source-outline-label.worker.ts'
import { readFrontmatter } from '../src/shared/frontmatter.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const flavors = [
  {
    id: 'markdown.github',
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
        start: blockMathStart,
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
    if (node.type.name !== 'heading') return
    // Inline formulas read as their LaTeX, and stay apart in the label parts.
    const parts = []
    node.forEach((child) => {
      if (child.type.name === 'inlineMath')
        parts.push({ latex: child.attrs.latex })
      else if (typeof parts.at(-1) === 'string')
        parts[parts.length - 1] += child.textContent
      else parts.push(child.textContent)
    })
    const label = parts
      .map((part) => (typeof part === 'string' ? part : part.latex))
      .join('')
    const math = parts.some((part) => typeof part !== 'string')
    headings.push({
      label: label.replace(/\s+/g, ' ').trim() || 'Untitled heading',
      level: Number(node.attrs.level),
      ...(math && {
        parts: parts
          .map((part, index) =>
            typeof part !== 'string'
              ? part
              : part
                  .replace(/\s+/g, ' ')
                  .replace(index === 0 ? /^ / : /(?!)/, '')
                  .replace(index === parts.length - 1 ? / $/ : /(?!)/, ''),
          )
          .filter((part) => part !== ''),
      }),
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

function finish(work, resolve, readLabel) {
  let value
  for (let steps = 0; steps < 100_000; steps++) {
    const step = work.next(value)
    if (step.done) return step.value.headings
    value = step.value
      ? 'label' in step.value
        ? readLabel(step.value.label)
        : resolve(step.value.reference)
      : undefined
  }
  assert.fail('Outline work must converge.')
}

function setup(source, { math = false, deferLabels = false } = {}) {
  const activeFlavors = math ? [...flavors, mathFlavor] : flavors
  const consumer = createOutlineLabelRenderer(
    activeFlavors.map((flavor) => flavor.id),
  )
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
    deferLabels,
    renderLabel: consumer,
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
      actual.map(({ label, level, parts }) => ({
        label,
        level,
        ...(parts && { parts }),
      })),
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

test('ordered first-item blocks agree with rich headings', () => {
  for (const source of [
    '1. #### ordered\n',
    '2. #### ordered\n',
    '1) ## one\n2) ### two\n',
    '1. first\n\n   #### nested\n',
    '1. setext\n   ===\n',
    '1. > ## quoted\n',
    '1. first\n   1. ### nested\n',
    '- ### bullet\n\n1. #### ordered\n',
  ])
    for (const ending of ['\n', '\r\n']) check(source.replaceAll('\n', ending))
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
    '# <https://example.test/a&amp;b> and https://example.test/a&amp;amp;b',
    '# <https://example.test/a&lt;b&amp;amp;> and <a&amp;b@example.test>',
    '# **<https://example.test/a&amp;b>** and [label &amp;](/target)',
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
      '# <https://example.test/a&amp;b> and https://example.test/a&amp;amp;b',
    )
    check(
      '# [**bold**][ref] ![image][picture]\n\n[ref]: /target\n[picture]: image.png',
    )
  } finally {
    for (const id of ids) markdownSyntax.setEnabled(id, true)
  }
})

for (const [disabled, text, label] of [
  ['core.italic', 'H~*i*~O', 'HiO'],
  ['core.italic', '~x *y* z~', 'x y z'],
  ['core.bold', 'H~**b *i***~O', 'Hb iO'],
  ['core.links', 'H~[**b**](/target)~O', 'HbO'],
  ['core.links', 'H~<https://e.test/a&amp;b>~O', 'Hhttps://e.test/a&bO'],
  ['core.images', 'H~![alt](image.png)~O', 'HaltO'],
  ['core.escapes', 'H~\\*~O', 'H*O'],
  ['core.inline-code', 'H~`c`~O', 'HO'],
  ['math.inline', 'H~$x$~O', 'HO'],
])
  test(`source outline subscript matches frozen native labels with ${disabled} disabled: ${text}`, () => {
    const activeFlavors = [...flavors, mathFlavor]
    const reader = createOutlineLabelReader({
      syntax: { gfm: true, alerts: true, textExtras: true, math: true },
      flavors: activeFlavors.map((flavor) => flavor.id),
      disabled: [disabled],
    })
    try {
      for (const padding of ['', 'heading '.repeat(90)]) {
        const source = `# ${padding}${text}`
        const expected = [{ label: padding + label, level: 1 }]
        assert.deepEqual(nativeHeadings(source, activeFlavors), expected)
        for (const deferLabels of [false, true]) {
          const { model } = setup(source, { math: true, deferLabels })
          try {
            const actual = finish(model.read(), referenceOracle(source), reader)
            assert.deepEqual(
              actual.map(({ label, level }) => ({ label, level })),
              expected,
            )
          } finally {
            model.dispose()
          }
        }
      }
    } finally {
      markdownSyntax.reset()
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

test('body reuse preserves definition edits, queued edits, removals and undo', () => {
  for (const ending of ['\n', '\r\n']) {
    let source = [
      '# [visible][ref] and [later][missing]',
      'body text',
      '[ref]: /one',
      'tail',
    ].join(ending + ending)
    const { store, model } = setup(source)
    const apply = (from, to, insert) => {
      edit(store, model, [{ from, to, insert }])
      source = source.slice(0, from) + insert + source.slice(to)
    }
    const expectNative = () =>
      assert.deepEqual(
        finish(model.read(), referenceOracle(source)).map(
          ({ label, level }) => ({ label, level }),
        ),
        nativeHeadings(source),
      )
    try {
      expectNative()
      const body = source.indexOf('body')
      apply(body, body + 1, 'B')
      expectNative()
      const href = source.indexOf('/one')
      apply(href, href + 4, '/two')
      expectNative()
      const ref = source.indexOf('[ref]:')
      apply(ref, ref + 5, '[gone]')
      expectNative()
      apply(ref, ref + 6, '[ref]')
      expectNative()
      // Queue a definition change and a body edit before the next outline read.
      const tail = source.indexOf('tail')
      apply(tail, tail + 4, '[missing]: /later')
      apply(body, body + 1, 'b')
      expectNative()
      const definition = source.indexOf('[missing]:')
      apply(definition, source.length, 'tail')
      expectNative()
      apply(definition, source.length, '[missing]: /later')
      expectNative()
    } finally {
      model.dispose()
    }
  }
})

test('source outline labels preserve native inline math atoms', () => {
  check('# before $x^2$ after and **$y$**', { math: true })
})

test('source and rich outline labels keep heading formulas as their LaTeX and as parts', () => {
  const [taylor, whole, spaced] = check(
    '# If $f(x,y)\\in C^{k+1}$ at each point\n\n## $P_{k,(a,b)}(x,y) + R_{k,(a,b)}(x,y)$\n\n###   a  $\\bar x$  b  \n',
    { math: true },
  )
  assert.deepEqual(taylor, {
    ...taylor,
    label: 'If f(x,y)\\in C^{k+1} at each point',
    parts: ['If ', { latex: 'f(x,y)\\in C^{k+1}' }, ' at each point'],
  })
  assert.deepEqual(whole.parts, [
    { latex: 'P_{k,(a,b)}(x,y) + R_{k,(a,b)}(x,y)' },
  ])
  assert.deepEqual(spaced.parts, ['a ', { latex: '\\bar x' }, ' b'])
  check('# H~$x$~O and ~~$y$~~', { math: true })
  // Without the math syntax, dollars are text and no parts are kept.
  const [plain] = check('# If $f(x)$ holds')
  assert.equal(plain.label, 'If $f(x)$ holds')
  assert.equal(plain.parts, undefined)
})

test('source outline labels preserve mid-line display math in atx and setext headings', () => {
  const source = '# Before $$f(x)$$ after\n\nSetext $$g(x)$$\n---\n'
  const { model } = setup(source, { math: true })
  try {
    const headings = finish(model.read(), referenceOracle(source))
    assert.deepEqual(
      headings.map(({ label, parts, level }) => ({ label, parts, level })),
      [
        {
          label: 'Before f(x) after',
          parts: ['Before ', { latex: 'f(x)' }, ' after'],
          level: 1,
        },
        {
          label: 'Setext g(x)',
          parts: ['Setext ', { latex: 'g(x)' }],
          level: 2,
        },
      ],
    )
  } finally {
    model.dispose()
  }
})

test('large math outlines retain label parts and reuse them across body edits', () => {
  const count = 1200
  const source = Array.from(
    { length: count },
    (_, index) => `## Heading ${index} $x_{${index}}$\n\nbody ${index}\n\n`,
  ).join('')
  const { store, model } = setup(source, { math: true })
  try {
    const before = finish(model.read(), referenceOracle(source))
    assert.equal(before.length, count)
    assert.deepEqual(before.at(-1).parts, [
      'Heading 1199 ',
      { latex: 'x_{1199}' },
    ])
    model.counters(true)
    const from = source.indexOf('body 600')
    edit(store, model, [{ from, to: from + 1, insert: 'B' }])
    const after = finish(model.read(), referenceOracle(source))
    assert.equal(after, before)
    assert.equal(model.counters().labelsRead, 0)
    assert.ok(model.counters().indexVisits < 100)
    assert.equal(store.counters().materializations, 0)
  } finally {
    model.dispose()
  }
})

test('deferred labels preserve complete native formatting, references, math and disabled syntax', () => {
  const padding = 'heading '.repeat(90)
  const fixtures = [
    `# ${padding}&amp; &#65; \\*literal\\* **bold *soft*** \`&amp;\``,
    `# ${padding}~~strike~~ H~2~O ![alt](image.png) <em>html</em><br>tail`,
    `# ${padding}**before <em>html</em> after** [*a <br> b*](/target)`,
    `# ${padding}**outer *inner <span>html</span> tail* end**`,
    `# ${padding}**cross <span>scope** ends</span>`,
    `# ${padding}\\*literal\\* **bold**`,
    `# ${padding}[**visible**][ref] [missing][absent]\n\n[ref]: /target`,
    `# ${padding}**before [outer [inner](/nested)](/target) after**`,
    `# ${padding}*<pre>raw &amp;</pre>* tail <https://example.test>`,
    `# ${padding}*<a href="/target">inside* https://example.test </a> tail`,
    `# ${padding}![![nested image](inside.png)](outside.png) tail`,
    `${padding}**bold**\n[*link*](/target) &amp;\n---\n`,
    `# ${'*a '.repeat(64)}b${' a*'.repeat(64)}${padding}\n`,
    `# ${padding}before $x^2$ after **$y$**`,
  ]
  const disabled = [
    'core.bold',
    'core.italic',
    'core.links',
    'core.images',
    'core.inline-code',
    'markdown.strike',
    'text-extras.subscript',
    'math.inline',
  ]
  for (const off of [false, true]) {
    const reader = createOutlineLabelReader({
      syntax: { gfm: true, alerts: true, textExtras: true, math: true },
      flavors: [...flavors, mathFlavor].map((flavor) => flavor.id),
      disabled: off ? disabled : [],
    })
    const nested = `${'*a '.repeat(1000)}b${' a*'.repeat(1000)}`
    for (const text of [nested, `[${nested}](/target)`]) {
      const deep = reader({ text, level: 1, references: new Map() })
      assert.equal(
        deep.label,
        off ? text : `${'a '.repeat(1000)}b${' a'.repeat(1000)}`,
      )
    }
    for (const source of fixtures) {
      const { model, activeFlavors } = setup(source, {
        math: true,
        deferLabels: true,
      })
      try {
        let requests = 0
        const actual = finish(
          model.read(),
          referenceOracle(source),
          (request) => {
            requests++
            assert.ok(request.text.length > 512)
            return reader(request)
          },
        )
        assert.ok(requests > 0)
        assert.deepEqual(
          actual.map(({ label, level, parts }) => ({
            label,
            level,
            ...(parts && { parts }),
          })),
          nativeHeadings(source, activeFlavors),
        )
      } finally {
        model.dispose()
      }
    }
  }
  markdownSyntax.reset()
})

test('long heading labels match native headings in full', () => {
  const words = Array.from(
    { length: 300 },
    (_, i) => `word${i} **bold ${i}** [link ${i}](/target) &amp;`,
  )
  const [atx] = check(`# ${words.join(' ')}`)
  assert.ok(atx.label.length > 4096, `${atx.label.length}`)
  // A paragraph before a dashed line is one setext heading.
  check(`${words.join('\n')}\n---\n`)
})
