import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

// Modules the CodeMirror editors would load from the rich editor's engine.
async function legacyModules(followDemand) {
  const { metafile } = await build({
    entryPoints: ['src/renderer/src/FormattedEditor.tsx'],
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
          bundle.onResolve({ filter: /.*/ }, ({ kind, path }) =>
            kind === 'dynamic-import' &&
            (!followDemand ||
              // Outline labels and the addon SDK still load the rich editor's schema.
              /^\.\/markdown-semantics$|\/sdk-loader$/.test(path))
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
