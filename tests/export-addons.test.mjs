import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
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
