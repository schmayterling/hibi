import assert from 'node:assert/strict'
import test from 'node:test'
import { NodeProp } from '@lezer/common'
import { typstFlavor, typstTokens } from '../src/addons/typst/syntax.ts'
import {
  SourceOutlineModel,
  sourceOutlineGrammar,
} from '../src/renderer/src/source-outline.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

// A third-party block whose lines are not Markdown, like a fenced code block.
const noteBlock = {
  defineNodes: [{ name: 'FixtureNote', block: true }],
  parseBlock: [
    {
      name: 'FixtureNote',
      before: 'FencedCode',
      parse(cx, line) {
        if (!/^:::note[ \t]*$/.test(line.text)) return false
        const from = cx.lineStart
        let to = from + line.text.length
        while (cx.nextLine()) {
          to = cx.lineStart + line.text.length
          if (/^:::[ \t]*$/.test(line.text)) {
            cx.nextLine()
            break
          }
        }
        cx.addElement(cx.elt('FixtureNote', from, to))
        return true
      },
    },
  ],
}
const finish = (work) => {
  for (let steps = 0; ; steps++) {
    const step = work.next(null)
    if (step.done)
      return step.value.headings.map(({ label, level }) => `${level}:${label}`)
    assert.ok(steps < 100_000, 'Outline work must converge.')
  }
}
const edit = (store, model, changes) => {
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

test('addon block syntax hides the # lines its blocks contain', () => {
  const source = '# Top\n\n:::note\n# not a heading\n:::\n\n## After\n'
  const read = (syntax) => {
    const store = new SourceStore(source, { tabId: 'addons', revision: 0 })
    const model = new SourceOutlineModel(store.snapshot(), {
      gfm: true,
      frontmatter: false,
      ...(syntax ? { syntax } : {}),
    })
    return { store, model, headings: finish(model.read()) }
  }
  assert.deepEqual(read().headings, ['1:Top', '1:not a heading', '2:After'])
  const { store, model, headings } = read([noteBlock])
  assert.deepEqual(headings, ['1:Top', '2:After'])

  // Edits inside and around the block follow the same grammar.
  const inside = source.indexOf('# not')
  edit(store, model, [{ from: inside, to: inside, insert: '# more\n' }])
  assert.deepEqual(finish(model.read()), ['1:Top', '2:After'])
  const close = store.snapshot().materialize().lastIndexOf(':::\n')
  edit(store, model, [{ from: close, to: close + 4, insert: '' }])
  assert.deepEqual(finish(model.read()), ['1:Top'])
  edit(store, model, [{ from: close, to: close, insert: ':::\n' }])
  assert.deepEqual(finish(model.read()), ['1:Top', '2:After'])
})

test('addon heading rules replace or remove the built-in heading syntax', () => {
  const source = '# ordinary text\n\n! alternate\n\nunderlined\n===\n'
  const read = (syntax) => {
    const store = new SourceStore(source, { tabId: 'headings', revision: 0 })
    const model = new SourceOutlineModel(store.snapshot(), {
      gfm: true,
      frontmatter: false,
      syntax,
    })
    try {
      return finish(model.read())
    } finally {
      model.dispose()
    }
  }
  assert.deepEqual(read([{ remove: ['ATXHeading'] }]), ['1:underlined'])
  assert.deepEqual(
    read([
      {
        parseBlock: [
          {
            name: 'ATXHeading',
            parse(cx, line) {
              if (!line.text.startsWith('! ')) return false
              const from = cx.lineStart
              cx.addElement(
                cx.elt('ATXHeading1', from, from + line.text.length, [
                  cx.elt('HeaderMark', from, from + 1),
                ]),
              )
              cx.nextLine()
              return true
            },
          },
        ],
      },
    ]),
    ['1:alternate', '1:underlined'],
  )
})

test('outline refuses addon heading nodes it cannot represent', () => {
  const store = new SourceStore(':::note\ncustom heading\n:::\n', {
    tabId: 'custom-heading',
    revision: 0,
  })
  const model = new SourceOutlineModel(store.snapshot(), {
    gfm: true,
    frontmatter: false,
    syntax: [
      {
        ...noteBlock,
        props: [NodeProp.group.add({ FixtureNote: ['Block', 'Heading'] })],
      },
    ],
  })
  try {
    assert.throws(
      () => finish(model.read()),
      /cannot represent the active syntax/,
    )
  } finally {
    model.dispose()
  }
})

test('outline grammar follows addon syntax and refuses only block syntax it cannot read', () => {
  const origins = {
    typst: 'built-in',
    markdown: 'built-in',
    frontmatter: 'built-in',
  }
  const origin = (id) => origins[id] ?? 'local'
  const flavor = (addonId, id, extra = {}) => ({
    id: `${addonId}.${id}`,
    addonId,
    name: id,
    kind: 'syntax',
    description: id,
    detect: () => false,
    ...extra,
  })
  const grammar = (flavors, projections = [], legacy = true) =>
    sourceOutlineGrammar(flavors, projections, { origin, legacy })
  const github = flavor('markdown', 'github', { markedOptions: { gfm: true } })
  const typst = {
    ...typstFlavor,
    id: 'typst.blocks',
    addonId: 'typst',
    richExtensions: [{ name: 'typstBlock', config: {} }],
    export: { extensions: [typstTokens] },
  }
  const frontmatter = { id: 'frontmatter.metadata', addonId: 'frontmatter' }

  // Built-in flavors, including Typst's fenced blocks, keep the outline.
  const builtIn = grammar([github, typst], [frontmatter])
  assert.deepEqual(builtIn.blocked, [])
  assert.deepEqual(builtIn.labels, ['markdown.github'])
  assert.deepEqual(builtIn.syntax, [])
  assert.deepEqual(builtIn.options, {
    gfm: true,
    alerts: true,
    textExtras: false,
    math: false,
    frontmatter: true,
  })

  // Lezer syntax extends the outline grammar, as in the source view.
  const notes = flavor('fixture-notes', 'notes', {
    syntax: noteBlock,
    export: {
      extensions: [{ extensions: [{ name: 'note', level: 'block' }] }],
    },
  })
  const inline = flavor('fixture-marks', 'marks', {
    export: {
      extensions: [{ extensions: [{ name: 'mark', level: 'inline' }] }],
    },
    richExtensions: [
      {
        config: {},
        parent: { config: { markdownTokenizer: { level: 'inline' } } },
      },
    ],
  })
  const extended = grammar([github, notes, inline])
  assert.deepEqual(extended.blocked, [])
  assert.deepEqual(extended.syntax, [notes])
  assert.deepEqual(extended.labels, ['markdown.github'])

  // Block syntax only the visual editor reads is refused, by owner.
  const marked = flavor('fixture-marked', 'blocks', {
    export: { extensions: [{ extensions: [{ name: 'box', level: 'block' }] }] },
  })
  const tiptap = flavor('fixture-tiptap', 'blocks', {
    richExtensions: [
      {
        config: {},
        parent: { config: { markdownTokenizer: { level: 'block' } } },
      },
    ],
  })
  const override = flavor('fixture-override', 'headings', {
    export: { extensions: [{ tokenizer: { heading: () => undefined } }] },
  })
  assert.deepEqual(grammar([github, marked, tiptap, override]).blocked, [
    'fixture-marked',
    'fixture-tiptap',
    'fixture-override',
  ])
  // The formatted view reads only Lezer syntax, like the outline.
  assert.deepEqual(grammar([marked, tiptap], [], false).blocked, [])
  // A local copy cannot authorize Typst's shared fence tokenizer override.
  origins.typst = 'local'
  assert.deepEqual(grammar([typst]).blocked, ['typst'])
  // A matching id cannot authorize an actual block grammar override.
  assert.deepEqual(
    grammar([
      {
        ...typst,
        export: { extensions: [{ tokenizer: { fences: () => undefined } }] },
      },
    ]).blocked,
    ['typst'],
  )
  origins.typst = 'built-in'

  // Projections other than built-in frontmatter hide part of the source.
  const projection = { id: 'fixture-toml.metadata', addonId: 'fixture-toml' }
  assert.deepEqual(grammar([], [frontmatter, projection], false).blocked, [
    'fixture-toml',
  ])
})
