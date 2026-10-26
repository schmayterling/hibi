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
    'asset staging streams ' + name + ' beyond the old embedded limit',
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
        directory,
        'hibi-assets',
        false,
        new AbortController().signal,
      )
      const path = await media.stage(name, note, directory)
      assert.match(path, /^hibi-assets\/media\/[a-f0-9]{64}\.(png|mp4)$/)
      assert.equal(await media.stage('./' + name, note, directory), path)
      assert.deepEqual(
        await readFile(join(directory, 'assets', path)),
        await readFile(join(directory, name)),
      )
      assert.equal(
        (await readdir(join(directory, 'assets', 'hibi-assets', 'media')))
          .length,
        1,
      )
    },
  )

test('memory asset budget rejects before creating a staged copy; cancellation closes readers', async (t) => {
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
  const media = new SiteMedia(directory, 'hibi-assets', true, controller.signal)
  await assert.rejects(
    media.stage('large.png', note, directory),
    /Export to disk instead/,
  )
  await assert.rejects(readdir(join(directory, 'assets')), /ENOENT/)
  controller.abort()
  await assert.rejects(media.stage('large.png', note, directory), {
    name: 'AbortError',
  })
})

test('base64 streaming carries incomplete triples without accumulating the asset', async () => {
  const bytes = Buffer.from('日本語 and arbitrary binary\0\xff', 'utf8')
  for (const width of [1, 2, 3, 4, 17]) {
    async function* input() {
      for (let at = 0; at < bytes.length; at += width)
        yield bytes.subarray(at, at + width)
    }
    const chunks = []
    for await (const chunk of base64Chunks(input())) {
      assert.ok(chunk.length <= 4 * Math.ceil((width + 2) / 3))
      chunks.push(chunk)
    }
    assert.equal(chunks.join(''), bytes.toString('base64'))
  }
})

test('cancelling during an asset copy closes its input and exclusive output', async (t) => {
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
  const fs = process.getBuiltinModule('node:fs/promises')
  const original = fs.open
  const controller = new AbortController()
  let reads = 0
  fs.open = async (path, ...args) => {
    const file = await original(path, ...args)
    if (String(path).includes(join(directory, 'assets'))) {
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
    const media = new SiteMedia(
      directory,
      'hibi-assets',
      false,
      controller.signal,
    )
    await assert.rejects(media.stage('image.png', note, directory), {
      name: 'AbortError',
    })
    assert.equal(reads, 1)
    await rm(join(directory, 'assets'), { recursive: true })
  } finally {
    fs.open = original
    syncBuiltinESMExports()
  }
})
