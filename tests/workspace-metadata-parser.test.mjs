import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkspaceMetadataParser } from '../src/main/workspace-metadata-parser.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

const entry = new URL(
  '../src/main/workspace-metadata-worker.ts',
  import.meta.url,
)
const syntax = {
  key: 'default',
  settings: defaultNoteSyntax,
  complete: true,
  unsupported: false,
}
const id = createHash('sha256').update('note.md').digest('hex')
const parse = (markdown, version = 'disk:1') => ({
  kind: 'parse',
  page: { id, path: 'note.md', markdown },
  syntax,
  version,
  fingerprint: 'default',
})

test('large-page metadata parsing stays in one worker while main gets task turns', async (t) => {
  const parser = new WorkspaceMetadataParser(() => ({ entry }))
  t.after(async () => {
    parser.close()
    await parser.stopping
  })
  await parser.request(parse('# warmup'), () => true)
  const worker = parser.worker
  assert.ok(worker.threadId > 0)
  const original = String.prototype.matchAll
  const split = String.prototype.split
  let mainNormalizations = 0
  t.mock.method(String.prototype, 'split', function (...args) {
    if (String(this).startsWith('././')) mainNormalizations++
    return split.apply(this, args)
  })
  let mainParses = 0
  t.mock.method(String.prototype, 'matchAll', function (...args) {
    if (String(this).startsWith('metadata-worker-marker')) mainParses++
    return original.apply(this, args)
  })
  const source = `metadata-worker-marker ${'body '.repeat(200000)} [target](${'./'.repeat(100000)}target.md#${'fragment'.repeat(5000)}) #work [[target#${'fragment'.repeat(5000)}]]`
  let settled = false
  const pending = parser
    .request(parse(source, 'disk:2'), () => true)
    .finally(() => {
      settled = true
    })
  let turns = 0
  for (; turns < 8 && !settled; turns++)
    await new Promise((resolve) => setImmediate(resolve))
  const page = await pending
  assert.ok(turns > 0)
  assert.equal(mainParses, 0)
  assert.equal(mainNormalizations, 0)
  assert.deepEqual(page.metadata.references.links, ['target.md'])
  assert.equal(parser.worker, worker)
  assert.deepEqual(page.metadata.references.wikilinks, ['target'])
  assert.deepEqual(page.metadata.tags, ['work'])
  assert.equal(Object.hasOwn(page, 'markdown'), false)
})

test('derived cache survives reopening and validates source, syntax and corrupt records', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-metadata-cache-'))
  let parser = new WorkspaceMetadataParser(() => ({
    entry,
    cacheDirectory: directory,
  }))
  t.after(async () => {
    parser.close()
    await parser.stopping
    await rm(directory, { recursive: true, force: true })
  })
  const metadata = await parser.request(
    parse('body-only-marker [[target]] #work'),
    () => true,
  )
  const path = join(directory, `${id}.json`)
  const disk = await readFile(path, 'utf8')
  assert.equal(disk.includes('body-only-marker'), false)
  parser.close()
  await parser.stopping
  parser = new WorkspaceMetadataParser(() => ({
    entry,
    cacheDirectory: directory,
  }))
  const cached = {
    kind: 'cached',
    id,
    path: 'note.md',
    version: 'disk:1',
    fingerprint: 'default',
  }
  assert.deepEqual(await parser.request(cached, () => true), metadata)
  assert.equal(
    await parser.request({ ...cached, version: 'disk:2' }, () => true),
    null,
  )
  assert.equal(
    await parser.request({ ...cached, fingerprint: 'changed' }, () => true),
    null,
  )
  await writeFile(path, '{"page": {"metadata": {}}}')
  assert.equal(await parser.request(cached, () => true), null)
  assert.equal(await parser.request(parse('# obsolete'), () => false), null)
})
