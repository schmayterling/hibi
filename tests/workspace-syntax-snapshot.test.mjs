import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test, { after } from 'node:test'
import { build } from 'esbuild'

const values = new Map()
const storage = {
  get length() {
    return values.size
  },
  key(index) {
    return [...values.keys()][index] ?? null
  },
  getItem(key) {
    return values.get(key) ?? null
  },
  setItem(key, value) {
    values.set(key, String(value))
  },
  removeItem(key) {
    values.delete(key)
  },
}
const previousStorage = globalThis.localStorage
globalThis.localStorage = storage
after(() => {
  globalThis.localStorage = previousStorage
})

const bundle = await build({
  stdin: {
    contents: `
      export { activeNoteMetadataSyntax, captureWorkspaceSyntaxSnapshot } from './src/renderer/src/workspace-syntax-snapshot.ts'
      export { flavors } from './src/renderer/src/flavors.ts'
      export { markdownSyntax } from './src/renderer/src/markdown-syntax.ts'
      export { workspaceSyntaxEvents } from './src/shared/workspace-syntax-events.ts'
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
  activeNoteMetadataSyntax,
  captureWorkspaceSyntaxSnapshot,
  flavors,
  markdownSyntax,
  workspaceSyntaxEvents,
} = module.exports

test('snapshot captures saved file flavor, disabled syntax, and registry revisions', () => {
  const id = 'a'.repeat(64)
  storage.setItem(
    `hibi:flavor:${id}`,
    JSON.stringify({ dialect: 'probe.wiki', syntax: ['probe.wiki'] }),
  )
  storage.setItem('hibi:flavor:not-a-file-id', '{}')
  const projections = [
    { id: 'frontmatter.metadata', preservation: { version: '2' } },
  ]
  const before = captureWorkspaceSyntaxSnapshot(false, projections)
  const unregister = flavors.register('probe', {
    id: 'wiki',
    name: 'Wiki',
    kind: 'syntax',
    description: 'test syntax',
    detect: () => false,
    preservation: { level: 'semantic', version: '9', fallback: 'source' },
  })
  const registeredRevision = flavors.version()
  try {
    markdownSyntax.setEnabled('core.bold', false)
    const current = captureWorkspaceSyntaxSnapshot(true, projections)
    assert.equal(current.version, 1)
    assert.equal(current.complete, true)
    assert.equal(current.hashtags, true)
    assert.deepEqual(current.projections, [
      { id: 'frontmatter.metadata', parserVersion: '2' },
    ])
    assert.deepEqual(current.choices, [
      { id, dialect: 'probe.wiki', syntax: ['probe.wiki'] },
    ])
    assert.deepEqual(
      current.flavors.find((flavor) => flavor.id === 'probe.wiki'),
      { id: 'probe.wiki', kind: 'syntax', parserVersion: '9' },
    )
    assert.equal(
      current.features.find((feature) => feature.id === 'core.bold').enabled,
      false,
    )
    assert.ok(current.flavorRevision > before.flavorRevision)
    assert.ok(current.featureRevision > before.featureRevision)
  } finally {
    markdownSyntax.setEnabled('core.bold', true)
    unregister()
  }
  assert.ok(
    captureWorkspaceSyntaxSnapshot(false).flavorRevision > registeredRevision,
  )
})

test('snapshot stays bounded when storage is too large or unavailable', () => {
  values.clear()
  for (let index = 0; index < 4097; index++)
    storage.setItem(
      `hibi:flavor:${index.toString(16).padStart(64, '0')}`,
      '{"dialect":"auto","syntax":"auto"}',
    )
  const capped = captureWorkspaceSyntaxSnapshot(false)
  assert.equal(capped.complete, false)
  assert.equal(capped.choices.length, 4096)
  values.clear()
  globalThis.localStorage = {
    get length() {
      throw new Error('storage unavailable')
    },
  }
  try {
    const unavailable = captureWorkspaceSyntaxSnapshot(false)
    assert.equal(unavailable.complete, false)
    assert.deepEqual(unavailable.choices, [])
  } finally {
    globalThis.localStorage = storage
  }
})

test('visible metadata consumers receive flavor and syntax invalidations', () => {
  let notifications = 0
  const remove = workspaceSyntaxEvents.subscribe(() => notifications++)
  const initial = workspaceSyntaxEvents.snapshot()
  const unregister = flavors.register('probe', {
    id: 'metadata',
    name: 'Metadata',
    kind: 'syntax',
    description: 'test syntax',
    detect: () => false,
  })
  try {
    markdownSyntax.setEnabled('core.links', false)
    workspaceSyntaxEvents.publish()
    assert.equal(workspaceSyntaxEvents.snapshot(), initial + 3)
    assert.equal(notifications, 3)
  } finally {
    markdownSyntax.setEnabled('core.links', true)
    unregister()
    remove()
  }
})

test('active-note syntax changes count key when Frontmatter is disabled', () => {
  values.clear()
  const source = '---\ntag: #yaml\n---\n# Body'
  const enabled = activeNoteMetadataSyntax('a'.repeat(64), source, true, [
    { id: 'frontmatter.metadata', preservation: { version: '1' } },
  ])
  const disabled = activeNoteMetadataSyntax('a'.repeat(64), source, true, [])
  assert.equal(enabled.settings.frontmatter, true)
  assert.equal(disabled.settings.frontmatter, false)
  assert.notEqual(enabled.fingerprint, disabled.fingerprint)
  assert.equal(enabled.complete, true)
  assert.equal(disabled.complete, true)
})
