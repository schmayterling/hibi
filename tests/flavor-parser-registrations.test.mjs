import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: `
      export { flavors } from './src/renderer/src/flavors.ts'
      export { flavorSyntax } from './src/renderer/src/flavor-syntax.ts'
      export { protectMarkdownParser } from './src/shared/markdown-flavor-guard.ts'
      export { formattedRegistry } from './src/renderer/src/formatted-registry.ts'
      export { parser } from '@lezer/markdown'
      export { EditorState } from '@codemirror/state'
      export { contributionExtension, formattedMarkdown, inlineStops } from './src/renderer/src/formatted-contributions.ts'
      export { formattedSyntax } from './src/renderer/src/formatted-syntax.ts'
      export { boundarySyntaxIds } from './src/shared/markdown-boundary-syntax.ts'
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'styles',
      setup(builder) {
        builder.onResolve({ filter: /\.css\?raw$/ }, ({ path }) => ({
          path,
          namespace: 'styles',
        }))
        builder.onLoad({ filter: /.*/, namespace: 'styles' }, () => ({
          contents: "export default ''",
        }))
      },
    },
  ],
})
const {
  flavors,
  flavorSyntax,
  protectMarkdownParser,
  formattedRegistry,
  parser,
  EditorState,
  contributionExtension,
  formattedMarkdown,
  inlineStops,
  formattedSyntax,
  boundarySyntaxIds,
} = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
)

const flavor = (id, syntax) => ({
  id,
  syntax,
  name: id,
  kind: 'syntax',
  description: 'Test',
  detect: () => true,
})

test('public inline stops keep guarded parsers and worker boundaries fast on plain text', async (t) => {
  let calls = 0
  const remove = flavors.register(
    'owner',
    {
      ...flavor('fast', {
        defineNodes: ['OwnedInlineFast'],
        parseInline: [
          {
            name: 'OwnedInlineFast',
            parse() {
              calls++
              return -1
            },
          },
        ],
      }),
      inlineStops: true,
    },
    assert.fail,
  )
  try {
    await new Promise((resolve) => setImmediate(resolve))
    const entry = formattedRegistry
      .entries()
      .find((item) => item.id === 'flavor:owner.fast')
    assert.ok(entry)
    const contribution = await entry.load()
    const syntax = formattedSyntax({ slice: 1000 })
    const state = EditorState.create({
      doc: `**strong**\n\n${'plain text '.repeat(2000)}`,
      extensions: [contributionExtension(contribution), syntax.extension],
    })
    const configs = state.facet(formattedMarkdown)
    assert.ok(configs.every((config) => inlineStops(config)))
    assert.deepEqual(boundarySyntaxIds(configs), [])
    assert.match(syntax.tree(state).toString(), /StrongEmphasis/)
    t.diagnostic(
      `${state.doc.length} characters: ${calls} contributed inline calls`,
    )
    assert.ok(
      calls < 50,
      `plain text called contributed inline parser ${calls} times`,
    )
  } finally {
    remove()
  }
})

test('quarantine reports its owner once and old cleanup cannot remove a replacement', async () => {
  const errors = []
  const failure = new Error('callback failed')
  const shared = {
    parseInline: [
      {
        name: 'Proof',
        parse() {
          throw failure
        },
      },
    ],
  }
  const old = flavors.register('owner', flavor('fault', shared), (error) =>
    errors.push(error),
  )
  const sibling = flavors.register('owner', flavor('sibling', {}), assert.fail)
  const item = flavors.snapshot().find((item) => item.id === 'owner.fault')
  const syntax = flavorSyntax(item)
  assert.equal(flavorSyntax(item), syntax)
  const configured = protectMarkdownParser(parser, syntax)
  assert.equal(
    configured.parse('**strong**').toString(),
    parser.parse('**strong**').toString(),
  )
  old()
  const replacement = flavors.register(
    'owner',
    flavor('fault', {}),
    assert.fail,
  )
  try {
    old()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(errors.length, 1)
    assert.equal(errors[0].message, 'owner.fault: callback failed')
    assert.equal(errors[0].cause, failure)
    assert.deepEqual(
      flavors.snapshot().map((item) => item.id),
      ['owner.fault', 'owner.sibling'],
    )
    assert.deepEqual(
      formattedRegistry
        .entries()
        .map((item) => item.id)
        .sort(),
      ['flavor:owner.fault', 'flavor:owner.sibling'],
    )
    assert.equal(
      configured.parse('**strong**').toString(),
      parser.parse('**strong**').toString(),
    )
    assert.equal(errors.length, 1)
  } finally {
    replacement()
    sibling()
  }
})

test('separate registrations sharing a syntax object retain separate ownership', async () => {
  let fail = false
  const errors = []
  const shared = {
    parseInline: [
      {
        name: 'Proof',
        parse() {
          if (fail) throw Error('one owner')
          return -1
        },
      },
    ],
  }
  const first = flavors.register('owner', flavor('first', shared), (error) =>
    errors.push(error),
  )
  const second = flavors.register(
    'owner',
    flavor('second', shared),
    assert.fail,
  )
  try {
    const a = flavors.snapshot().find((item) => item.id === 'owner.first')
    const b = flavors.snapshot().find((item) => item.id === 'owner.second')
    assert.notEqual(flavorSyntax(a), flavorSyntax(b))
    fail = true
    protectMarkdownParser(parser, flavorSyntax(a)).parse('x')
    fail = false
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(
      flavors.snapshot().map((item) => item.id),
      ['owner.second'],
    )
    assert.equal(errors.length, 1)
    assert.equal(
      protectMarkdownParser(parser, flavorSyntax(b))
        .parse('**strong**')
        .toString(),
      parser.parse('**strong**').toString(),
    )
  } finally {
    first()
    second()
  }
})

test('built-in syntax keeps its original config and callback identities', () => {
  const config = { parseInline: [{ name: 'Native', parse: () => -1 }] }
  const remove = flavors.register(
    'native',
    flavor('proof', config),
    assert.fail,
    false,
  )
  try {
    const registered = flavors.snapshot()[0]
    assert.equal(registered.syntax, config)
    assert.equal(flavorSyntax(registered), config)
    assert.equal(
      flavorSyntax(registered).parseInline[0].parse,
      config.parseInline[0].parse,
    )
  } finally {
    remove()
  }
})
