import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

// Outline labels and the addon SDK still load the rich editor's schema, from these imports only.
const retained = new Set([
  'src/renderer/src/use-source-outline.ts -> ./markdown-semantics',
  'src/renderer/src/addon-definition.ts -> ../../addons/sdk-loader',
])
const local = (file) => relative('', file).replaceAll('\\', '/')

// Modules the CodeMirror editors would load from the rich editor's engine,
// with `load.code` appended to `load.file` when given.
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
          // Raw stylesheets and the addon catalog come from the build; other queries are followed.
          bundle.onResolve(
            { filter: /\.css\?raw$|^virtual:hibi-addon-catalog\// },
            ({ path }) => ({ path, external: true }),
          )
          bundle.onResolve({ filter: /.*/ }, ({ importer, kind, path }) =>
            kind === 'dynamic-import' &&
            (!followDemand || retained.has(`${local(importer)} -> ${path}`))
              ? { path, external: true }
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
  for (const [file, code] of [
    [
      'src/renderer/src/SourceEditor.tsx',
      "void import('./markdown-semantics')",
    ],
    [
      'src/renderer/src/SourceEditor.tsx',
      "void import('../../addons/sdk-loader')",
    ],
    [
      'src/renderer/src/use-source-outline.ts',
      "void import('./markdown-semantics?outline')",
    ],
    [
      'src/renderer/src/addon-definition.ts',
      "void import('../../addons/sdk-loader?sdk')",
    ],
  ])
    assert.notDeepEqual(
      await legacyModules(true, { file, code }),
      [],
      `${file}: ${code}`,
    )
})
