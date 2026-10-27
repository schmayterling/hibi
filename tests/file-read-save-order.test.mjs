import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({
  stdin: {
    contents:
      "export { readMarkdownChunks, writeText } from './src/main/files.ts'",
    resolveDir: resolve('.'),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
})
const require = createRequire(import.meta.url)

function runtime() {
  const files = new Map()
  const hooks = {}
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' })
  const entry = (text = '') => ({
    bytes: Buffer.from(text),
    mtimeMs: 1,
    ctimeMs: 1,
    nlink: 1,
  })
  const info = (file) => ({
    ...file,
    size: file.bytes.length,
    mode: 0o600,
    isFile: () => true,
  })
  const fs = {
    async open(path, flags) {
      if (flags === 'wx') files.set(path, entry())
      const file = files.get(path)
      if (!file) throw missing()
      return {
        async stat() {
          return info(file)
        },
        async read(buffer, offset, length, position) {
          return {
            bytesRead: file.bytes.copy(
              buffer,
              offset,
              position,
              position + length,
            ),
          }
        },
        async writeFile(source) {
          if (typeof source === 'string' || source instanceof Uint8Array)
            file.bytes = Buffer.from(source)
          else {
            const parts = []
            for await (const part of source) parts.push(Buffer.from(part))
            file.bytes = Buffer.concat(parts)
          }
        },
        async sync() {},
        async close() {},
      }
    },
    async stat(path) {
      const file = files.get(path)
      if (!file) throw missing()
      return info(file)
    },
    async rename(from, to) {
      const old = files.get(to)
      if (old) {
        old.nlink--
        old.ctimeMs++
      }
      files.set(to, files.get(from))
      files.delete(from)
    },
    async link(from, to) {
      files.set(to, files.get(from))
      files.get(to).nlink++
      hooks.linked?.()
    },
    async unlink(path) {
      const file = files.get(path)
      if (!file) throw missing()
      file.nlink--
      file.ctimeMs++
      files.delete(path)
    },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
    (id) => (id === 'node:fs/promises' ? fs : require(id)),
    module,
    module.exports,
  )
  files.set('/notes/saved.md', entry('# snapshot'))
  return { ...module.exports, files, hooks }
}

test('an owned save waits for its chunk reader while another path can commit', async () => {
  const h = runtime()
  const reader = h.readMarkdownChunks('/notes/saved.md')
  assert.equal((await reader.next()).value, '# snapshot')
  let committed = false
  const saving = h.writeText('/notes/saved.md', '# replacement').then(() => {
    committed = true
  })
  await h.writeText('/notes/other.md', '# independent')
  assert.equal(
    committed,
    false,
    'the same-file commit must wait for the reader',
  )
  assert.equal((await reader.next()).done, true)
  await saving
  assert.equal(h.files.get('/notes/saved.md').bytes.toString(), '# replacement')
})

test('closing an abandoned chunk reader releases a queued save', async () => {
  const h = runtime()
  const reader = h.readMarkdownChunks('/notes/saved.md')
  await reader.next()
  const saving = h.writeText('/notes/saved.md', '# replacement')
  await h.writeText('/notes/other.md', '# independent')
  await reader.return()
  await saving
  assert.equal(h.files.get('/notes/saved.md').bytes.toString(), '# replacement')
})

test('external in-place changes still fail the stable-read guard', async () => {
  const h = runtime()
  const reader = h.readMarkdownChunks('/notes/saved.md')
  await reader.next()
  h.files.get('/notes/saved.md').ctimeMs++
  await assert.rejects(reader.next(), /The file changed while opening/)
  await h.writeText('/notes/saved.md', '# after failed read')
})

test('a failed file open releases its path for the next save', async () => {
  const h = runtime()
  await assert.rejects(h.readMarkdownChunks('/notes/missing.md').next(), {
    code: 'ENOENT',
  })
  await h.writeText('/notes/missing.md', '# recovered')
  const chunks = []
  for await (const chunk of h.readMarkdownChunks('/notes/missing.md'))
    chunks.push(chunk)
  assert.equal(chunks.join(''), '# recovered')
})

test('a reader waits until exclusive-save temporary links are removed', async () => {
  const h = runtime()
  let reading
  h.hooks.linked = () => {
    reading = (async () => {
      const chunks = []
      for await (const chunk of h.readMarkdownChunks('/notes/new.md'))
        chunks.push(chunk)
      return chunks.join('')
    })()
  }
  await h.writeText('/notes/new.md', '# exclusive', true)
  assert.equal(await reading, '# exclusive')
  assert.equal(h.files.get('/notes/new.md').nlink, 1)
})

test('a refused save releases its path for a subsequent commit', async () => {
  const h = runtime()
  await assert.rejects(
    h.writeText('/notes/saved.md', '# refused', false, () => false),
    /The save request is no longer current/,
  )
  await h.writeText('/notes/saved.md', '# accepted')
  assert.equal(h.files.get('/notes/saved.md').bytes.toString(), '# accepted')
})

test('a streamed replacement can read its own destination before committing', async () => {
  const h = runtime()
  async function* source() {
    for await (const chunk of h.readMarkdownChunks('/notes/saved.md'))
      yield Buffer.from(chunk)
  }
  await h.writeText('/notes/saved.md', source())
  assert.equal(h.files.get('/notes/saved.md').bytes.toString(), '# snapshot')
})
