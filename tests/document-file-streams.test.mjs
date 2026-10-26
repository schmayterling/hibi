import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { SourceStore } from '../src/shared/source-buffer.ts'

const bundle = await build({
  entryPoints: ['src/main/files.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
})
const require = createRequire(import.meta.url)
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'hibi-file-streams-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const work = { reads: 0, pieces: [] }
  const mocks = {
    ...fs,
    open: async (...args) => {
      const file = await fs.open(...args)
      const read = file.read.bind(file),
        writeFile = file.writeFile.bind(file)
      file.read = async (...args) => {
        work.reads++
        return read(...args)
      }
      file.writeFile = async (value, ...args) => {
        if (typeof value === 'string' || value instanceof Uint8Array)
          return writeFile(value, ...args)
        async function* tracked() {
          for await (const part of value) {
            work.pieces.push(part.byteLength)
            yield part
          }
        }
        return writeFile(tracked(), ...args)
      }
      return file
    },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
    (id) => (id === 'node:fs/promises' ? mocks : require(id)),
    module,
    module.exports,
  )
  return { api: module.exports, root, work }
}

test('whole-string reads reject oversized files before their first data read', async (t) => {
  const { api, root, work } = await fixture(t)
  const path = join(root, 'large.md'),
    file = await fs.open(path, 'wx')
  await file.truncate(200 * 1024 * 1024)
  await file.close()
  await assert.rejects(api.readMarkdown(path, 2 * 1024 * 1024), /limit|large/)
  assert.equal(work.reads, 0)
})

test('stable UTF-8 file comparison checks exact text and EOF without rebuilding source', async (t) => {
  const { api, root } = await fixture(t)
  const path = join(root, 'compare.md')
  for (const text of [
    '',
    '\uFEFFa\r\n😀'.repeat(12000),
    'a'.repeat(65535) + '😀\r\nend',
  ]) {
    const store = new SourceStore(text, { tabId: 'compare', revision: 0 })
    const snapshot = store.snapshot()
    store.counters(true)
    await fs.writeFile(path, text)
    assert.equal(await api.matchesMarkdown(path, snapshot), true)
    await fs.writeFile(path, text + 'extra')
    assert.equal(await api.matchesMarkdown(path, snapshot), false)
    if (text) {
      await fs.writeFile(path, text.slice(0, -1))
      assert.equal(await api.matchesMarkdown(path, snapshot), false)
      await fs.writeFile(path, 'X' + text.slice(1))
      assert.equal(await api.matchesMarkdown(path, snapshot), false)
    }
    assert.equal(store.counters().unitsScanned, 0)
    assert.equal(store.counters().materializations, 0)
  }
  await fs.writeFile(path, Buffer.from([0xc3]))
  await assert.rejects(
    api.matchesMarkdown(
      path,
      new SourceStore('', { tabId: 'compare', revision: 0 }).snapshot(),
    ),
    /encoding|encoded/,
  )
})

test('atomic streamed writes coalesce small encoded pieces into bounded buffers', async (t) => {
  const { api, root, work } = await fixture(t)
  const path = join(root, 'saved.md')
  const parts = Array.from({ length: 512 }, (_, index) =>
    Buffer.alloc(4096, index % 251),
  )
  parts.push(Buffer.from('the end'))
  await api.writeText(path, parts)
  assert.deepEqual(await fs.readFile(path), Buffer.concat(parts))
  assert.equal(work.pieces.length, 3)
  assert.equal(Math.max(...work.pieces), 1024 * 1024)
  assert.equal(work.pieces.at(-1), 7)
})
