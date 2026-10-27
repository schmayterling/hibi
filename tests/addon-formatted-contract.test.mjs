import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { formattedCompatibility } from '../src/renderer/src/formatted-compatibility.ts'

test('bundled rich-only addons remain on an explicit migration allowlist', async () => {
  const missing = []
  for (const entry of await readdir('src/addons', { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue
    const folder = join('src/addons', entry.name)
    const files = (await readdir(folder, { recursive: true })).filter((file) =>
      /\.(ts|tsx)$/.test(file),
    )
    const source = (
      await Promise.all(
        files.map((file) => readFile(join(folder, file), 'utf8')),
      )
    ).join('\n')
    if (
      /\b(?:registerRich\s*\(|richExtensions\s*:)/.test(source) &&
      !/\b(?:registerFormatted\s*\(|formattedRegistry\.register\s*\()/.test(
        source,
      )
    )
      missing.push(entry.name)
  }
  // This allowlist must be empty before the CodeMirror formatted view becomes the default.
  assert.deepEqual(missing.sort(), [])
})

test('formatted sdk shares the host Lezer common runtime', async () => {
  const { outputFiles } = await build({
    stdin: {
      contents:
        "export * from './src/addons/sdk-formatted.ts'; export * as host from '@lezer/common'",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
  })
  const sdk = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
  )
  assert.ok(
    sdk.common?.NodeProp,
    'formatted addons receive the host NodeProp constructor',
  )
  assert.deepEqual(Object.keys(sdk.common).sort(), Object.keys(sdk.host).sort())
  for (const [key, value] of Object.entries(sdk.host))
    assert.equal(sdk.common[key], value, key)
  const prop = new sdk.common.NodeProp()
  const configured = sdk.markdown.parser.configure({
    props: [prop.add({ Paragraph: 'shared' })],
  })
  assert.equal(
    configured.parse('text').topNode.firstChild.type.prop(prop),
    'shared',
  )
})

test('legacy flavor compatibility follows declared features and live renderer registrations', async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: `
        export { createFormattedCompatibility } from './src/renderer/src/formatted-addon-compatibility.ts'
        export { formattedCompatibility } from './src/renderer/src/formatted-compatibility.ts'
        export { formattedRegistry } from './src/renderer/src/formatted-registry.ts'
        export { markdownSyntax } from './src/renderer/src/markdown-syntax.ts'
        export { flavors } from './src/renderer/src/flavors.ts'
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    loader: { '.css': 'empty' },
  })
  const {
    createFormattedCompatibility,
    formattedCompatibility,
    formattedRegistry,
    markdownSyntax,
    flavors,
  } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
  )
  let notices = 0
  const scope = createFormattedCompatibility(
    'flavor-proof',
    'Flavor proof',
    {
      show() {
        assert.equal(notices++, 0, 'one notice per addon')
        let active = true
        return {
          dismiss() {
            if (active) notices--
            active = false
          },
        }
      },
    },
    () => {},
  )
  const removals = []
  const flavor = {
    id: 'mixed',
    name: 'Mixed',
    kind: 'syntax',
    description: 'Mixed',
    detect: () => true,
    richExtensions: [{ name: 'oneLegacy' }, { name: 'twoLegacy' }],
    render: [
      { nodes: ['StrongEmphasis'], feature: 'one', decorate: () => undefined },
      { nodes: ['Emphasis'], decorate: () => undefined },
    ],
  }
  let entry, removeRenderer
  const register = formattedRegistry.register
  formattedRegistry.register = (value) => {
    entry = value
    removeRenderer = register(value)
    return removeRenderer
  }
  let unsubscribe
  const loaded = new Promise((resolve) => {
    unsubscribe = formattedRegistry.subscribe(() => {
      if (entry) resolve()
    })
  })
  try {
    removals.push(flavors.register('flavor-proof', flavor))
    removals.push(scope.registerFlavor(flavor))
    // Syntax declarations may arrive after the flavor registration.
    for (const [id, extension, node] of [
      ['one', 'oneLegacy', 'StrongEmphasis'],
      ['two', 'twoLegacy', 'Emphasis'],
    ])
      removals.push(
        markdownSyntax.register('flavor-proof', {
          id,
          label: id,
          group: 'Mixed',
          level: 'inline',
          extensions: [extension],
          nodes: id === 'two' ? [node, 'PartialLegacyNode'] : [node],
          matches: () => false,
        }),
      )
    await loaded
    formattedRegistry.register = register
    assert.deepEqual(formattedCompatibility.features(), ['flavor-proof.two'])
    assert.equal(notices, 1)
    const second = scope.register('formatted', 'two')
    removals.push(second)
    assert.deepEqual(formattedCompatibility.features(), [])
    assert.equal(notices, 0)
    removeRenderer()
    assert.deepEqual(formattedCompatibility.features(), ['flavor-proof.one'])
    assert.equal(notices, 1)
    const snapshot = formattedCompatibility.snapshot()
    second()
    assert.deepEqual(formattedCompatibility.features(), [
      'flavor-proof.one',
      'flavor-proof.two',
    ])
    assert.equal(formattedCompatibility.snapshot(), snapshot)
    assert.equal(notices, 1)
    removals.push(register({ ...entry }))
    assert.deepEqual(formattedCompatibility.features(), ['flavor-proof.two'])
    removals[0]()
    assert.deepEqual(formattedCompatibility.features(), [])
    assert.equal(notices, 0)
  } finally {
    unsubscribe()
    formattedRegistry.register = register
    for (const remove of removals.reverse()) remove()
    scope.dispose()
  }
})

test('legacy compatibility follows each feature through migration and cleanup', () => {
  const removals = []
  const register = (kind, feature) => {
    const remove = formattedCompatibility.register('fixture', kind, feature)
    removals.push(remove)
    return remove
  }
  try {
    const rich = register('rich', 'one')
    const second = register('rich', 'two')
    const duplicate = register('rich', 'two')
    assert.deepEqual(formattedCompatibility.snapshot(), ['fixture'])
    const formatted = register('formatted', 'one')
    assert.deepEqual(
      formattedCompatibility.snapshot(),
      ['fixture'],
      'migrating one feature must keep the remaining legacy warning',
    )
    const migrated = register('formatted', 'two')
    assert.deepEqual(formattedCompatibility.snapshot(), [])
    formatted()
    assert.deepEqual(formattedCompatibility.snapshot(), ['fixture'])
    rich()
    rich()
    assert.deepEqual(formattedCompatibility.snapshot(), [])
    migrated()
    assert.deepEqual(formattedCompatibility.snapshot(), ['fixture'])
    second()
    assert.deepEqual(formattedCompatibility.snapshot(), ['fixture'])
    const readded = register('formatted', 'two')
    assert.deepEqual(formattedCompatibility.snapshot(), [])
    readded()
    duplicate()
    assert.deepEqual(formattedCompatibility.snapshot(), [])
  } finally {
    for (const remove of removals.reverse()) remove()
  }
})
