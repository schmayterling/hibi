import assert from 'node:assert/strict'
import {
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  base64Chunks,
  SiteMedia,
} from '../src/addons/documentation/site-media.ts'

for (const [name, size, header] of [
  ['large.png', 8 * 1024 * 1024 + 1, Buffer.from('89504e470d0a1a0a', 'hex')],
  [
    'large.mp4',
    15 * 1024 * 1024,
    Buffer.from('000000206674797069736f6d', 'hex'),
  ],
])
  test(
    'asset publication copies ' + name + ' once without staging media bytes',
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'hibi-site-media-'))
      t.after(() => rm(directory, { recursive: true, force: true }))
      const note = join(directory, 'note.md')
      await writeFile(note, '# Note')
      const file = await open(join(directory, name), 'wx')
      try {
        await file.writeFile(header)
        await file.truncate(size)
      } finally {
        await file.close()
      }
      const media = new SiteMedia(
        'hibi-assets',
        false,
        new AbortController().signal,
      )
      const path = await media.stage(name, note, directory)
      assert.match(path, /^hibi-assets\/media\/[a-f0-9]{64}\.(png|mp4)$/)
      assert.equal(await media.stage('./' + name, note, directory), path)
      assert.equal(media.files().length, 1)
      assert.deepEqual(
        (await readdir(directory)).sort(),
        [name, 'note.md'].sort(),
      )
      const output = join(directory, 'published')
      assert.equal(await media.publish(path, output), true)
      assert.deepEqual(
        await readFile(output),
        await readFile(join(directory, name)),
      )
      assert.equal(await media.publish('missing', output), false)
      await writeFile(join(directory, name), header)
      await assert.rejects(
        media.publish(path, join(directory, 'changed')),
        /attachment changed/,
      )
    },
  )

test('memory media budget refuses before reading asset bodies; cancellation closes readers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-site-media-memory-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const note = join(directory, 'note.md')
  await writeFile(note, '# Note')
  const file = await open(join(directory, 'large.png'), 'wx')
  try {
    await file.writeFile(Buffer.from('89504e470d0a1a0a', 'hex'))
    await file.truncate(31 * 1024 * 1024)
  } finally {
    await file.close()
  }
  const controller = new AbortController()
  const media = new SiteMedia('hibi-assets', true, controller.signal)
  await assert.rejects(
    media.stage('large.png', note, directory),
    /Export to disk instead/,
  )
  assert.deepEqual((await readdir(directory)).sort(), ['large.png', 'note.md'])
  controller.abort()
  await assert.rejects(media.stage('large.png', note, directory), {
    name: 'AbortError',
  })
})

test('base64 chunks carry incomplete triples and stay bounded for oversized reader chunks', async () => {
  const bytes = Buffer.from('日本語 and arbitrary binary\0\xff', 'utf8')
  for (const width of [1, 2, 3, 4, 17]) {
    async function* input() {
      for (let at = 0; at < bytes.length; at += width)
        yield bytes.subarray(at, at + width)
    }
    const chunks = []
    for await (const chunk of base64Chunks(input())) chunks.push(chunk)
    assert.equal(chunks.join(''), bytes.toString('base64'))
  }
  async function* large() {
    yield Buffer.alloc(2 * 1024 * 1024, 0xa7)
  }
  let size = 0
  for await (const chunk of base64Chunks(large())) {
    assert.ok(chunk.length <= 64 * 1024)
    size += Buffer.from(chunk, 'base64').length
  }
  assert.equal(size, 2 * 1024 * 1024)
})

test('64 kib source reads produce full 48 kib records without fragmentation', async () => {
  const source = Buffer.alloc(64 * 1024, 0xa7)
  async function* input() {
    for (let index = 0; index < 240; index++) yield source
  }
  let count = 0
  for await (const chunk of base64Chunks(input())) {
    assert.equal(chunk.length, 64 * 1024)
    count++
  }
  assert.equal(count, 320)
})

test('cancelling publication closes source and exclusive destination after the first chunk', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-site-media-cancel-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const note = join(directory, 'note.md')
  await writeFile(note, '# Note')
  const file = await open(join(directory, 'image.png'), 'wx')
  try {
    await file.writeFile(Buffer.from('89504e470d0a1a0a', 'hex'))
    await file.truncate(8 * 1024 * 1024 + 1)
  } finally {
    await file.close()
  }
  const controller = new AbortController()
  const media = new SiteMedia('hibi-assets', false, controller.signal)
  const path = await media.stage('image.png', note, directory)
  const output = join(directory, 'published')
  const fs = process.getBuiltinModule('node:fs/promises')
  const original = fs.open
  let reads = 0
  fs.open = async (path, ...args) => {
    const file = await original(path, ...args)
    if (path === output) {
      const write = file.writeFile.bind(file)
      file.writeFile = (chunks) =>
        write(
          (async function* () {
            for await (const chunk of chunks) {
              reads++
              controller.abort()
              yield chunk
            }
          })(),
        )
    }
    return file
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(media.publish(path, output), { name: 'AbortError' })
    assert.equal(reads, 1)
    await rm(output)
    await rm(join(directory, 'image.png'))
  } finally {
    fs.open = original
    syncBuiltinESMExports()
  }
})
