import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const { outputFiles, metafile } = await build({
  entryPoints: [join(root, 'src/shared/addon-manifest.ts')],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  metafile: true,
})
const { parseAddonManifest, admitInstalledAddon } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`
)
const base = {
  id: 'sample',
  name: 'Sample',
  description: 'Compiled manifest fixture',
  apiVersion: 2,
  version: '1.0.0',
  kind: 'extension',
  authors: [{ displayName: 'Test' }],
  entry: 'index.js',
}
const compiled = (fields = {}) =>
  parseAddonManifest({ ...base, ...fields }, { trust: 'compiled' })

test('compiled parser bundles without platform or editor dependencies', () => {
  assert.doesNotMatch(
    Object.keys(metafile.inputs).join('\n'),
    /node_modules|src\/main\//,
  )
  assert.equal(
    Object.values(metafile.outputs).flatMap((output) => output.imports).length,
    0,
  )
})

test('compiled renderer and native entries accept source and javascript modules', () => {
  for (const extension of ['ts', 'tsx', 'js', 'mjs']) {
    const entry = `views/index.${extension}`
    const native = { entry: `handlers/native.${extension}` }
    const parsed = compiled({ entry, native })
    assert.equal(parsed.entry, entry)
    assert.deepEqual(parsed.native, native)
    assert.equal('native' in parsed.manifest, false)
  }
  assert.equal('native' in compiled(), false)
  for (const extension of ['ts', 'tsx']) {
    assert.throws(
      () => parseAddonManifest({ ...base, entry: `index.${extension}` }),
      /extension entry/,
    )
  }
})

test('compiled manifests retain optional authors without weakening installed validation', () => {
  assert.equal('authors' in compiled({ authors: undefined }).manifest, false)
  assert.deepEqual(compiled({ authors: [] }).manifest.authors, [])
  for (const authors of [undefined, []])
    assert.throws(() => parseAddonManifest({ ...base, authors }), /authors/)
  for (const authors of [null, {}, [null], [{}]])
    assert.throws(() => compiled({ authors }), /authors/)
})

test('renderer and native entries share package path validation', () => {
  for (const entry of [
    '',
    '../index.ts',
    '/index.ts',
    'a/./index.ts',
    'a/.index.ts',
    'https://example.com/index.ts',
    'a\\index.ts',
    'index.ts?x',
    'index.ts#x',
    'index%2ets',
    'index\n.ts',
    'index.cjs',
    'index.jsx',
    'index.TS',
    'index.json',
    `${'x'.repeat(2048)}.ts`,
  ]) {
    assert.throws(() => compiled({ entry }), /extension entry/)
    assert.throws(() => compiled({ native: { entry } }), /native entry/)
  }
  for (const native of [null, false, 'native.ts', [], {}, { entry: 1 }])
    assert.throws(() => compiled({ native }), /native entry/)
})

test('compiled analysis accepts typescript without rewriting runtime metadata', () => {
  for (const entry of ['analysis.ts', 'analysis.js', 'analysis.mjs'])
    assert.deepEqual(compiled({ analysis: { entry } }).manifest.analysis, {
      entry,
    })
  assert.throws(
    () => parseAddonManifest({ ...base, analysis: { entry: 'analysis.ts' } }),
    /analysis entry/,
  )
  for (const entry of [
    '../analysis.ts',
    '/analysis.ts',
    'analysis.ts?x',
    'analysis.tsx',
  ])
    assert.throws(() => compiled({ analysis: { entry } }), /analysis entry/)
})

test('compiled importer retains instructions and source order after validation', () => {
  for (const sources of [['folder'], ['zip'], ['zip', 'folder']]) {
    const importer = { instructions: 'Choose exported notes.', sources }
    assert.deepEqual(compiled({ importer }).manifest.importer, importer)
  }
  for (const importer of [
    null,
    false,
    [],
    'folder',
    {},
    { instructions: 1, sources: ['folder'] },
    { instructions: 'Choose notes.', sources: 'folder' },
    { instructions: 'Choose notes.', sources: ['url'] },
    { instructions: 'Choose notes.', sources: [null] },
  ])
    assert.throws(() => compiled({ importer }), /importer/)
})

test('installed admission rejects privileged metadata after inert parsing regardless of claimed origin', () => {
  for (const field of ['native', 'windows', 'importer']) {
    for (const value of [null, false, {}, { entry: 'native.js' }]) {
      const input = {
        ...base,
        [field]: value,
        source: 'built-in',
        origin: 'local',
        trust: 'compiled',
      }
      assert.deepEqual(parseAddonManifest(input), parseAddonManifest(base))
      assert.deepEqual(
        parseAddonManifest(input, { trust: 'installed' }),
        parseAddonManifest(base),
      )
      assert.throws(() => admitInstalledAddon(input, []), /cannot declare/)
      assert.deepEqual(
        admitInstalledAddon(input, [], 'load'),
        admitInstalledAddon(base, []),
      )
    }
  }
})

test('compiled source themes can register colors through their renderer entry', () => {
  const parsed = compiled({
    kind: 'theme',
    entry: 'index.tsx',
    capabilities: ['ui'],
  })
  assert.equal(parsed.manifest.kind, 'theme')
  assert.equal(parsed.entry, 'index.tsx')
  assert.deepEqual(parsed.themes, [])
  assert.throws(
    () => parseAddonManifest({ ...base, kind: 'theme', capabilities: ['ui'] }),
    /without executable code/,
  )
})

test('api compatibility uses one format and caller-owned compiled trust', () => {
  for (const apiVersion of [1, 2, 3]) {
    const parsed = compiled({ apiVersion, native: { entry: 'native.ts' } })
    assert.equal(parsed.manifest.apiVersion, 3)
    assert.equal(parsed.manifest.defaultEnabled, false)
    assert.deepEqual(
      compiled({ apiVersion }).manifest,
      parseAddonManifest({ ...base, apiVersion }).manifest,
    )
  }
  assert.throws(() => compiled({ kind: undefined }), /kind/)
  assert.throws(() => compiled({ apiVersion: 4 }), /API version/)
})

test('all 41 json manifests match their compatibility shims without entry or native metadata', async () => {
  const parent = join(root, 'src/addons')
  const folders = []
  for (const folder of await readdir(parent, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue
    const path = join(parent, folder.name)
    const files = await readdir(path)
    if (files.includes('manifest.ts')) folders.push({ path, files })
  }
  const { outputFiles } = await build({
    stdin: {
      contents: `${folders
        .map(
          ({ path }, index) =>
            `import manifest${index} from ${JSON.stringify(join(path, 'manifest.ts'))};`,
        )
        .join(
          '\n',
        )}\nexport default [${folders.map((_, index) => `manifest${index}`).join(',')}]`,
      resolveDir: root,
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    loader: { '.md': 'text' },
  })
  const { default: manifests } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`
  )
  assert.equal(manifests.length, 41)
  for (const [index, manifest] of manifests.entries()) {
    const { path } = folders[index]
    const input = JSON.parse(
      await readFile(join(path, 'hibi-addon.json'), 'utf8'),
    )
    const { entry: _entry, native: _native, ...metadata } = input
    assert.deepEqual(manifest, metadata, manifest.id)
    assert.deepEqual(
      parseAddonManifest(input, { trust: 'compiled' }).manifest,
      { ...manifest, apiVersion: 3 },
      manifest.id,
    )
    assert.equal('entry' in manifest, false, manifest.id)
    assert.equal('native' in manifest, false, manifest.id)
  }
  assert.deepEqual(manifests.find(({ id }) => id === 'review').analysis, {
    entry: 'analysis.js',
  })
})
