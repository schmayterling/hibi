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
// outline labels still load the rich editor's schema, from this import only.
const retained = new Set([
  'src/renderer/src/use-source-outline.ts -> ./markdown-semantics',
])
const local = (file) => relative('', file).replaceAll('\\', '/')

// Modules the CodeMirror editors would load from the rich editor's engine,
// with `load.code` appended to `load.file` and `load.alias` resolved when given.
async function legacyModules(followDemand, load) {
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
          bundle.onResolve({ filter: /.*/ }, ({ importer, kind, path }) => {
            const edge = `${local(importer)} -> ${path}`
            return provided.has(edge) ||
              (kind === 'dynamic-import' &&
                (!followDemand || retained.has(edge)))
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

test('the rich schema stays allowed only through its retained imports', async () => {
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
