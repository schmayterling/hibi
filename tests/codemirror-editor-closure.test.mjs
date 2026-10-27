import assert from 'node:assert/strict'
import { relative, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

// Outline labels and the addon SDK still load the rich editor's schema, from these imports only.
const retained = new Set([
  'src/renderer/src/use-source-outline.ts -> ./markdown-semantics',
  'src/renderer/src/addon-definition.ts -> ../../addons/sdk-loader',
])

// Modules the CodeMirror editors would load from the rich editor's engine.
async function legacyModules(followDemand, load = '') {
  const { metafile } = await build({
    stdin: {
      contents: `export * from './FormattedEditor'\n${load}`,
      resolveDir: resolve('src/renderer/src'),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    metafile: true,
    logLevel: 'silent',
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'demand',
        setup(bundle) {
          bundle.onResolve({ filter: /\?|^virtual:/ }, ({ path }) => ({
            path,
            external: true,
          }))
          bundle.onResolve({ filter: /.*/ }, ({ importer, kind, path }) =>
            kind === 'dynamic-import' &&
            (!followDemand ||
              retained.has(
                `${relative('', importer).replaceAll('\\', '/')} -> ${path}`,
              ))
              ? { path, external: true }
              : undefined,
          )
        },
      },
    ],
  })
  const modules = Object.keys(metafile.inputs)
  assert.ok(modules.includes('src/renderer/src/SourceEditor.tsx'))
  if (followDemand)
    assert.ok(modules.includes('src/renderer/src/MarkdownSourceEditor.tsx'))
  return modules.filter((path) =>
    /node_modules\/(?:@tiptap\/|prosemirror-)/.test(path),
  )
}

test('codemirror editors load no tiptap or prosemirror modules', async () => {
  assert.deepEqual(await legacyModules(false), [])
  assert.deepEqual(await legacyModules(true), [])
})

test('the rich schema stays allowed only from its retained importers', async () => {
  for (const load of [
    "void import('./markdown-semantics')",
    "void import('../../addons/sdk-loader')",
  ])
    assert.notDeepEqual(await legacyModules(true, load), [], load)
})
