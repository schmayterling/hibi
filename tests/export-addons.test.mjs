import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import { exportAddons } from '../scripts/export-addons.mjs'

const metadata = {
  id: 'sample',
  name: 'Sample',
  description: 'Export fixture',
  kind: 'extension',
  apiVersion: 2,
  version: '1.0.0',
  defaultEnabled: false,
  authors: [{ displayName: 'Example' }],
}
const json = JSON.stringify({
  ...metadata,
  entry: 'index.ts',
  native: { entry: 'native.ts' },
})

test('addon catalog export keeps metadata, markdown, and relative images without runtime code or audio', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-catalog-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'),
    destination = join(root, 'export')
  await mkdir(join(source, 'sample/images'), { recursive: true })
  for (const [file, contents] of Object.entries({
    'authors.ts': 'static authors',
    'sample/manifest.ts': 'throw new Error("never execute the shim")',
    'sample/hibi-addon.json': json,
    'sample/README.md': '![preview](images/preview.png)',
    'sample/guide.md': 'More help',
    'sample/images/preview.png': 'image bytes',
    'sample/index.ts': 'throw new Error("never execute")',
    'sample/sound.mp3': 'audio bytes',
  }))
    await writeFile(join(source, file), contents)
  const files = await exportAddons(source, destination)
  assert.equal(files.length, 6)
  assert.equal(
    await readFile(join(destination, 'sample/hibi-addon.json'), 'utf8'),
    json,
  )
  const manifest = await readFile(
    join(destination, 'sample/manifest.ts'),
    'utf8',
  )
  const declaration = parse(manifest, { sourceType: 'module' }).program.body[0]
  assert.equal(declaration.type, 'ExportDefaultDeclaration')
  assert.equal(declaration.declaration.type, 'ObjectExpression')
  assert.deepEqual(
    JSON.parse(manifest.slice('export default '.length)),
    metadata,
  )
  assert.equal(
    await readFile(join(source, 'sample/manifest.ts'), 'utf8'),
    'throw new Error("never execute the shim")',
  )
  assert.equal(
    await readFile(join(destination, 'sample/README.md'), 'utf8'),
    '![preview](images/preview.png)',
  )
  assert.equal(
    await readFile(join(destination, 'sample/images/preview.png'), 'utf8'),
    'image bytes',
  )
  assert.ok(!files.some((file) => /index\.ts|mp3/.test(file)))
  await writeFile(
    join(source, 'sample/hibi-addon.json'),
    JSON.stringify({ ...metadata, entry: '../escape.js' }),
  )
  await assert.rejects(
    exportAddons(source, destination),
    /hibi-addon.json:.*entry/,
  )
  assert.equal(
    await readFile(join(destination, 'sample/manifest.ts'), 'utf8'),
    manifest,
  )
  await writeFile(join(source, 'sample/hibi-addon.json'), json)
  await rm(join(source, 'sample/manifest.ts'))
  await rm(join(source, 'sample/guide.md'))
  await exportAddons(source, destination)
  assert.equal(
    await readFile(join(destination, 'sample/manifest.ts'), 'utf8'),
    manifest,
  )
  assert.ok(!(await readdir(join(destination, 'sample'))).includes('guide.md'))
})

test('all 42 canonical manifests export website object literals with frozen metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-builtin-export-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = fileURLToPath(new URL('../src/addons/', import.meta.url))
  const destination = join(root, 'export')
  const expected = JSON.parse(
    await readFile(
      new URL('./fixtures/addon-catalog-manifests.json', import.meta.url),
      'utf8',
    ),
  )
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
  const shims = new Map()
  for (const id of Object.keys(expected))
    shims.set(id, await readFile(join(source, id, 'manifest.ts'), 'utf8'))
  const files = await exportAddons(source, destination)
  assert.equal(
    files.filter((file) => basename(file) === 'hibi-addon.json').length,
    42,
  )
  assert.equal(
    files.filter((file) => basename(file) === 'manifest.ts').length,
    42,
  )
  for (const [id, hash] of Object.entries(expected)) {
    const canonical = await readFile(
      join(source, id, 'hibi-addon.json'),
      'utf8',
    )
    assert.equal(
      await readFile(join(destination, id, 'hibi-addon.json'), 'utf8'),
      canonical,
      id,
    )
    const {
      entry: _entry,
      native: _native,
      ...metadata
    } = JSON.parse(canonical)
    const exported = await readFile(
      join(destination, id, 'manifest.ts'),
      'utf8',
    )
    const body = parse(exported, { sourceType: 'module' }).program.body
    assert.equal(body.length, 1, id)
    assert.equal(body[0].type, 'ExportDefaultDeclaration', id)
    assert.equal(body[0].declaration.type, 'ObjectExpression', id)
    const value = JSON.parse(exported.slice('export default '.length))
    assert.deepEqual(value, metadata, id)
    assert.equal(
      createHash('sha256')
        .update(JSON.stringify(stable(value)))
        .digest('hex'),
      hash,
      id,
    )
    assert.equal(
      await readFile(join(source, id, 'manifest.ts'), 'utf8'),
      shims.get(id),
      id,
    )
  }
  assert.equal(
    await readFile(join(destination, 'authors.ts'), 'utf8'),
    await readFile(join(source, 'authors.ts'), 'utf8'),
  )
})
