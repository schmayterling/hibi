import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  root: resolve('.'),
  server: { middlewareMode: true },
  appType: 'custom',
})
after(() => server.close())
const { readAddonPackages, addonCatalog } = await server.ssrLoadModule(
  '/scripts/addon-packages.ts',
)
const packages = await readAddonPackages()
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, field]) => [key, stable(field)]),
        )
      : value

test('all 42 compiled manifests retain their metadata before catalog migration', async () => {
  const expected = JSON.parse(
    await readFile(
      fileURLToPath(
        new URL('./fixtures/addon-catalog-manifests.json', import.meta.url),
      ),
      'utf8',
    ),
  )
  const builtins = packages.filter(({ source }) => source === 'built-in')
  assert.equal(builtins.length, 42)
  for (const { manifest, directory } of builtins) {
    assert.equal(basename(directory), manifest.id)
    assert.equal(
      createHash('sha256')
        .update(JSON.stringify(stable(manifest)))
        .digest('hex'),
      expected[manifest.id],
      manifest.id,
    )
  }
})

test('pilot author metadata stays in sync with the shared author record', async () => {
  const { authors } = await server.ssrLoadModule('/src/addons/authors.ts')
  for (const id of ['ui-preview', 'quick-note', 'review'])
    assert.deepEqual(
      packages.find(({ manifest }) => manifest.id === id).manifest.authors,
      [authors.may],
      id,
    )
})

test('catalog watches the real files behind metadata imports', async () => {
  const inputs = new Set()
  await readAddonPackages(undefined, (file) => inputs.add(file))
  assert.ok(inputs.has(resolve('src/addons/quick-note/hibi-addon.json')))
  assert.ok(inputs.has(resolve('src/addons/authors.ts')))
  assert.ok(inputs.has(resolve('docs/licenses/typst-assets.md')))
  assert.ok([...inputs].every((file) => !file.includes('?')))
  assert.equal(inputs.has(resolve('src/addons/quick-note/index.tsx')), false)
  assert.equal(inputs.has(resolve('src/addons/quick-note/native.ts')), false)
})

test('catalog emits process-specific lazy entries and separate author/license details', async () => {
  const load = async (process, part = process) => {
    const plugin = addonCatalog(process)
    return plugin.load.call(
      { addWatchFile() {} },
      `\0virtual:hibi-addon-catalog/${part}`,
    )
  }
  const main = await load('main')
  const renderer = await load('renderer')
  const authors = await load('renderer', 'details')
  const licenses = await load('main', 'details')
  const windows = await load('renderer', 'windows')
  assert.match(main, /loadNative:.*import\(/)
  assert.doesNotMatch(main, /index\.tsx?["']/)
  assert.match(renderer, /load:.*import\(/)
  assert.match(renderer, /loadSettings:.*import\(/)
  assert.match(renderer, /import flavors/)
  assert.doesNotMatch(
    renderer,
    /native\.ts|loadNative|node:|electron|authors|licenses/,
  )
  assert.doesNotMatch(main, /"authors"|"licenses"/)
  assert.match(windows, /load:.*import\(/)
  assert.doesNotMatch(windows, /flavor-info|flavors:|loadSettings|native\.ts/)
  const { default: owners } = await import(
    `data:text/javascript;base64,${Buffer.from(windows).toString('base64')}`
  )
  assert.deepEqual(
    owners.map(({ id, capabilities }) => ({ id, capabilities })),
    packages.map(({ manifest: { id, capabilities } }) => ({
      id,
      capabilities,
    })),
  )
  for (const owner of owners)
    assert.deepEqual(Object.keys(owner), ['id', 'capabilities', 'load'])
  const authorRecords = JSON.parse(authors.slice('export default '.length))
  const licenseRecords = JSON.parse(licenses.slice('export default '.length))
  for (const { manifest } of packages) {
    assert.deepEqual(authorRecords[manifest.id], {
      ...(manifest.authors ? { authors: manifest.authors } : {}),
    })
    assert.deepEqual(licenseRecords[manifest.id], {
      ...(manifest.licenses ? { licenses: manifest.licenses } : {}),
    })
  }
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-addon-catalog-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const folder = join(root, 'src/addons/sample')
  await mkdir(join(folder, 'views'), { recursive: true })
  await writeFile(
    join(folder, 'views/window.tsx'),
    'throw new Error("catalog must not import addon code")',
  )
  const manifest = {
    id: 'sample',
    name: 'Sample',
    description: 'Catalog fixture',
    version: '1.0.0',
    apiVersion: 2,
    kind: 'extension',
    authors: [{ displayName: 'Example' }],
    entry: 'views/window.tsx',
  }
  const write = (value) =>
    writeFile(join(folder, 'hibi-addon.json'), JSON.stringify(value))
  await write(manifest)
  return { root, folder, manifest, write }
}

test('json takes precedence over a legacy shim and declares the owner renderer entry', async (t) => {
  const { root, folder } = await fixture(t)
  await writeFile(
    join(folder, 'manifest.ts'),
    'throw new Error("json must take precedence")',
  )
  const [item] = await readAddonPackages(root)
  assert.equal(item.manifest.id, 'sample')
  assert.equal(item.entry, 'src/addons/sample/views/window.tsx')
})

test('catalog rejects mismatched ids, missing entries and paths outside the package', async (t) => {
  const { root, folder, manifest, write } = await fixture(t)
  await write({ ...manifest, id: 'different' })
  await assert.rejects(readAddonPackages(root), /folder must match/)
  await write({ ...manifest, entry: 'missing.tsx' })
  await assert.rejects(readAddonPackages(root), /ENOENT/)
  await write({ ...manifest, entry: '../outside.ts' })
  await assert.rejects(readAddonPackages(root), /entry/)
  await writeFile(join(root, 'outside.ts'), 'export default {}')
  await symlink(join(root, 'outside.ts'), join(folder, 'linked.ts'), 'file')
  await write({ ...manifest, entry: 'linked.ts' })
  await assert.rejects(
    readAddonPackages(root),
    /regular file inside its folder/,
  )
})

test('catalog combines legacy built-ins and local json without executing their entries', async (t) => {
  const { root, folder, manifest } = await fixture(t)
  await rm(join(folder, 'hibi-addon.json'))
  const { entry: _entry, authors: _authors, ...metadata } = manifest
  await writeFile(
    join(folder, 'manifest.ts'),
    `export default ${JSON.stringify(metadata)}`,
  )
  await writeFile(join(folder, 'index.ts'), 'throw new Error("never execute")')
  const local = join(root, 'src/useraddons/local')
  await mkdir(local, { recursive: true })
  await writeFile(
    join(local, 'hibi-addon.json'),
    JSON.stringify({
      ...manifest,
      id: 'local',
      entry: 'window.tsx',
      native: { entry: 'host.ts' },
      analysis: { entry: 'analyzer/run.js' },
    }),
  )
  await writeFile(join(local, 'window.tsx'), 'throw new Error("never execute")')
  await writeFile(join(local, 'host.ts'), 'throw new Error("never execute")')
  await mkdir(join(local, 'analyzer'))
  await writeFile(
    join(local, 'analyzer/run.js'),
    'throw new Error("never execute")',
  )
  const items = await readAddonPackages(root)
  assert.deepEqual(
    items.map(({ manifest, source }) => [manifest.id, source]),
    [
      ['sample', 'built-in'],
      ['local', 'local'],
    ],
  )
  assert.equal('authors' in items[0].manifest, false)
  assert.equal(items[1].native, 'src/useraddons/local/host.ts')
  assert.equal(items[1].analysis, 'src/useraddons/local/analyzer/run.js')
  const duplicate = join(root, 'src/useraddons/sample')
  await mkdir(duplicate)
  await writeFile(
    join(duplicate, 'hibi-addon.json'),
    JSON.stringify({ ...manifest, entry: 'index.ts' }),
  )
  await writeFile(
    join(duplicate, 'index.ts'),
    'throw new Error("never execute")',
  )
  await assert.rejects(readAddonPackages(root), /Duplicate addon id/)
})

test('catalog rejects oversized json before reading addon entries', async (t) => {
  const { root, manifest, write } = await fixture(t)
  await write({ ...manifest, description: 'x'.repeat(65536) })
  await assert.rejects(readAddonPackages(root), /64 KiB/)
})

test('catalog names malformed json and recovers after correction', async (t) => {
  const { root, folder, manifest, write } = await fixture(t)
  await writeFile(join(folder, 'hibi-addon.json'), '{')
  await assert.rejects(
    readAddonPackages(root),
    /sample[/\\\\]hibi-addon\.json:/,
  )
  await write(manifest)
  assert.equal((await readAddonPackages(root))[0].manifest.id, 'sample')
})
