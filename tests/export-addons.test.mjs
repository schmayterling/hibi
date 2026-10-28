import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import { addonDates, exportAddons } from '../scripts/export-addons.mjs'

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
  assert.deepEqual(JSON.parse(manifest.slice('export default '.length)), {
    ...metadata,
    apiVersion: 3,
  })
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

test('all 41 canonical manifests export website object literals with frozen metadata', async (t) => {
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
    41,
  )
  assert.equal(
    files.filter((file) => basename(file) === 'manifest.ts').length,
    41,
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
    assert.deepEqual(value, { ...metadata, apiVersion: 3 }, id)
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

test('addon dates come from the first-parent history of each addon folder', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-addon-dates-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const addons = join(root, 'src/addons')
  const run = (date, ...args) =>
    execFileSync('git', ['-C', root, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: date,
      },
    })
  const commit = async (date, ...files) => {
    for (const file of files) {
      await mkdir(dirname(join(addons, file)), { recursive: true })
      await writeFile(join(addons, file), date)
    }
    run(date, 'add', '.')
    run(date, 'commit', '-qm', files.join(' '))
  }
  assert.equal(await addonDates(root, ['first']), null)
  run('2026-01-01T00:00:00Z', 'init', '-q', '-b', 'main')
  await commit('2026-01-02T12:00:00Z', 'authors.ts')
  await commit('2026-01-03T23:30:00-05:00', 'first/manifest.ts')
  await commit('2026-02-01T00:00:00Z', 'second/hibi-addon.json')
  run('2026-02-01T00:00:00Z', 'switch', '-qc', 'feature')
  await commit('2026-02-05T00:00:00Z', 'first/README.md')
  run('2026-02-01T00:00:00Z', 'switch', '-q', 'main')
  await commit('2026-02-06T00:00:00Z', 'other.md')
  run(
    '2026-03-01T00:00:00Z',
    'merge',
    '-q',
    '--no-ff',
    '-m',
    'merge',
    'feature',
  )
  // Merged work counts from the day it reached main; undated folders are omitted.
  assert.deepEqual(await addonDates(addons, ['first', 'second', 'missing']), {
    first: { released: '2026-01-04', updated: '2026-03-01' },
    second: { released: '2026-02-01', updated: '2026-02-01' },
  })
  // A bulk commit still releases the folders it creates, but a commit across
  // more than three addons never counts as an update.
  await commit(
    '2026-04-01T00:00:00Z',
    'first/a.md',
    'second/a.md',
    'third/manifest.ts',
    'fourth/manifest.ts',
  )
  assert.deepEqual(
    await addonDates(addons, ['first', 'second', 'third', 'fourth']),
    {
      first: { released: '2026-01-04', updated: '2026-03-01' },
      second: { released: '2026-02-01', updated: '2026-02-01' },
      third: { released: '2026-04-01', updated: '2026-04-01' },
      fourth: { released: '2026-04-01', updated: '2026-04-01' },
    },
  )
  await commit(
    '2026-04-02T00:00:00Z',
    'first/b.md',
    'second/b.md',
    'third/b.md',
  )
  assert.deepEqual(
    await addonDates(addons, ['first', 'second', 'third', 'fourth']),
    {
      first: { released: '2026-01-04', updated: '2026-04-02' },
      second: { released: '2026-02-01', updated: '2026-04-02' },
      third: { released: '2026-04-01', updated: '2026-04-02' },
      fourth: { released: '2026-04-01', updated: '2026-04-01' },
    },
  )
  run(
    '2026-03-01T00:00:00Z',
    'clone',
    '-q',
    '--depth',
    '1',
    `file://${root}`,
    'shallow',
  )
  assert.equal(
    await addonDates(join(root, 'shallow/src/addons'), ['first']),
    null,
  )
})
