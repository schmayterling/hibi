import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

// Raw stylesheets and the addon catalog, which the build provides; everything else is followed.
const provided = new Set([
  'src/renderer/src/render-markdown.ts -> ../../ui/markdown-literal.css?raw',
  'src/renderer/src/render-markdown.ts -> ../../ui/syntax.css?raw',
  'src/renderer/src/addon-registry.ts -> virtual:hibi-addon-catalog/renderer',
  'src/renderer/src/addon-registry.ts -> virtual:hibi-addon-catalog/details',
])
const local = (file) => relative('', file).replaceAll('\\', '/')
const legacy = (modules) =>
  modules.filter((path) =>
    /node_modules\/(?:@tiptap\/|prosemirror-)/.test(path),
  )

// Modules the CodeMirror editors would load from the rich editor's engine,
// with `load.code` appended to `load.file` and `load.alias` resolved when given.
async function legacyModules(
  followDemand,
  load,
  entry = 'src/renderer/src/FormattedEditor.tsx',
) {
  const { metafile } = await build({
    entryPoints: [entry],
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
          bundle.onResolve({ filter: /.*/ }, ({ importer, kind, path }) => {
            const edge = `${local(importer)} -> ${path}`
            return provided.has(edge) ||
              (kind === 'dynamic-import' && !followDemand)
              ? { path, external: true }
              : undefined
          })
          if (load?.alias)
            bundle.onResolve({ filter: /.*/ }, ({ path }) =>
              path === load.alias[0]
                ? { path: resolve(load.alias[1]) }
                : undefined,
            )
          if (load)
            bundle.onLoad({ filter: /\.tsx?$/ }, async ({ path }) =>
              local(path) === load.file
                ? {
                    contents: `${await readFile(path, 'utf8')}\n${load.code}`,
                    loader: path.endsWith('.tsx') ? 'tsx' : 'ts',
                  }
                : undefined,
            )
        },
      },
    ],
  })
  const modules = Object.keys(metafile.inputs)
  if (entry === 'src/renderer/src/FormattedEditor.tsx') {
    assert.ok(modules.includes('src/renderer/src/SourceEditor.tsx'))
    if (followDemand)
      assert.ok(modules.includes('src/renderer/src/MarkdownSourceEditor.tsx'))
  }
  return legacy(modules)
}

// Diagram addons keep their rich editor node until the rich editor goes. Only
// the node's constructor may come from its module: the formatted view's blocks,
// edit dialogs and previews load nothing from the rich editor's engine.
const richNodes = { mermaid: 'mermaidNode', typst: 'typstNode' }

async function diagramLegacyModules(addon, withNode) {
  const entry = `src/addons/${addon}/index.tsx`
  const { metafile } = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    metafile: true,
    logLevel: 'silent',
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'rich-node',
        setup(bundle) {
          if (withNode) return
          bundle.onResolve({ filter: /^\.\/Block$/ }, ({ importer }) =>
            local(importer) === entry
              ? { path: 'Block', namespace: 'rich-node' }
              : undefined,
          )
          bundle.onLoad({ filter: /.*/, namespace: 'rich-node' }, () => ({
            contents: `export function ${richNodes[addon]}() {}`,
          }))
        },
      },
    ],
  })
  const modules = Object.keys(metafile.inputs)
  assert.ok(modules.includes(`src/addons/${addon}/formatted.tsx`))
  return legacy(modules)
}

test('codemirror editors load no tiptap or prosemirror modules', async () => {
  assert.deepEqual(await legacyModules(false), [])
  assert.deepEqual(await legacyModules(true), [])
})

test('outline label workers load no tiptap or prosemirror modules', async () => {
  assert.deepEqual(
    await legacyModules(
      true,
      undefined,
      'src/renderer/src/source-outline-label.worker.ts',
    ),
    [],
  )
})

test('outline label workers reject injected rich runtime imports', async () => {
  for (const load of [
    {
      file: 'src/renderer/src/source-outline-label.ts',
      code: "void import('./markdown-semantics')",
    },
    {
      file: 'src/renderer/src/source-outline-label.worker.ts',
      code: "void import('../../addons/markdown/obsidian')",
    },
    {
      file: 'src/renderer/src/markdown-entities.ts',
      code: "export { Extension } from '@tiptap/core'",
    },
  ])
    assert.notDeepEqual(
      await legacyModules(
        true,
        load,
        'src/renderer/src/source-outline-label.worker.ts',
      ),
      [],
      load.code,
    )
})

test('codemirror editors reject injected rich runtime imports', async () => {
  for (const load of [
    {
      file: 'src/renderer/src/SourceEditor.tsx',
      code: "void import('./markdown-semantics')",
    },
    {
      file: 'src/renderer/src/SourceEditor.tsx',
      code: "void import('../../addons/sdk')",
    },
    {
      file: 'src/renderer/src/use-source-outline.ts',
      code: "void import('./markdown-semantics?outline')",
    },
    {
      file: 'src/renderer/src/addon-definition.ts',
      code: "void import('../../addons/sdk?sdk')",
    },
    {
      file: 'src/renderer/src/addon-registry.ts',
      code: "void import('virtual:hibi-addon-catalog/review')",
      alias: [
        'virtual:hibi-addon-catalog/review',
        'src/renderer/src/tab-indent.ts',
      ],
    },
  ])
    assert.notDeepEqual(await legacyModules(true, load), [], load.code)
})

test('diagram blocks and their edit dialogs load no tiptap or prosemirror modules', async () => {
  for (const addon of Object.keys(richNodes)) {
    assert.deepEqual(await diagramLegacyModules(addon, false), [], addon)
    assert.notDeepEqual(await diagramLegacyModules(addon, true), [], addon)
  }
})
