import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, win32 } from 'node:path'
import { pipeline } from 'node:stream/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import { DocumentMediaServer, openMedia } from '../src/main/document-media.ts'
import {
  isLocalMediaPath,
  resolveDocumentMediaPath,
} from '../src/main/images.ts'

const mib = 1024 * 1024
const gif = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
)
const video = Buffer.from('000000186674797069736f6d0000000069736f6d', 'hex')
const source = await fs.readFile(
  new URL('../src/main/media.ts', import.meta.url),
  'utf8',
)
// Run the real functions without importing Electron or the built app.
const body = parse(source, {
  sourceType: 'module',
  plugins: ['typescript'],
}).program.body
const code = stripTypeScriptTypes(
  body
    .filter((node) => node.type !== 'ImportDeclaration')
    .map((node) =>
      source.slice(node.declaration?.start ?? node.start, node.end),
    )
    .join('\n'),
)

async function fixture(t, absolute = isAbsolute) {
  const root = await fs.mkdtemp(
    join(dirname(fileURLToPath(import.meta.url)), '.media-byte-limits-'),
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const handles = []
  const state = {
    note: join(root, 'note.md'),
    saves: 0,
    save: async () => false,
    opened() {},
  }
  const bindings = {
    lstat: fs.lstat,
    mkdir: fs.mkdir,
    open: fs.open,
    realpath: fs.realpath,
    unlink: fs.unlink,
    basename,
    dirname,
    extname,
    isAbsolute: absolute,
    isLocalMediaPath,
    join,
    pipeline,
    DocumentMediaServer,
    resolveDocumentMediaPath,
    getDocument: () => ({ revision: 7, ephemeral: !state.note }),
    getDocumentPath: () => state.note,
    workspaceRoot: () => null,
    saveDocument: async () => {
      state.saves++
      return state.save()
    },
    openMedia: async (path) => {
      const media = await openMedia(path)
      handles.push(media.file)
      await state.opened(media, path)
      return media
    },
  }
  const media = new Function(
    ...Object.keys(bindings),
    `${code}\nreturn { attachMedia, exportDocumentMedia, filePath }`,
  )(...Object.values(bindings))
  return {
    ...media,
    root,
    state,
    handles,
    async file(name, header, size = header.length) {
      const path = join(root, name)
      await fs.writeFile(path, header)
      await fs.truncate(path, size)
      return path
    },
    closed() {
      assert.ok(handles.length > 0)
      for (const file of handles) assert.equal(file.fd, -1)
    },
  }
}

for (const [name, header, size, error] of [
  ['large.gif', gif, 8 * mib + 1, /8 MiB/],
  ['large.mp4', video, 512 * mib + 1, /512 MiB/],
  ['empty.gif', gif, 0, /Choose a supported image or video file\./],
]) {
  test(`attachment preflight rejects ${name} before saving or creating assets`, async (t) => {
    const f = await fixture(t)
    const path = await f.file(name, header, size)
    f.state.note = null
    await assert.rejects(f.attachMedia(null, [path], 7), error)
    assert.equal(f.state.saves, 0)
    assert.deepEqual(await fs.readdir(f.root), [name])
    if (size) f.closed()
  })
}

for (const [name, header, size] of [
  ['edge.gif', gif, 8 * mib],
  ['edge.mp4', video, 512 * mib],
]) {
  test(`attachment preflight accepts exact byte limit for ${name}`, async (t) => {
    const f = await fixture(t)
    const path = await f.file(name, header, size)
    f.state.note = null
    assert.equal(await f.attachMedia(null, [path], 7), null)
    assert.equal(f.state.saves, 1)
    f.closed()
  })
}

test('attachment copy rechecks byte limits after save and closes rejected handles', async (t) => {
  const f = await fixture(t)
  const path = await f.file('growing.gif', gif)
  f.state.note = null
  f.state.save = async () => {
    await fs.truncate(path, 8 * mib + 1)
    f.state.note = join(f.root, 'note.md')
    return true
  }
  await assert.rejects(f.attachMedia(null, [path], 7), /8 MiB/)
  assert.equal(f.handles.length, 2)
  assert.deepEqual(await fs.readdir(join(f.root, 'assets')), [])
  f.closed()
})

test('supported images and videos copy only their validated byte range', async (t) => {
  const f = await fixture(t)
  const paths = [
    await f.file('image.gif', gif, 8 * mib),
    await f.file('clip.mp4', video),
  ]
  let copies = 0
  f.state.opened = ({ file, stat }) => {
    const createReadStream = file.createReadStream.bind(file)
    file.createReadStream = (options) => {
      assert.deepEqual(options, { start: 0, end: stat.size - 1 })
      copies++
      return createReadStream(options)
    }
  }
  const result = await f.attachMedia(null, paths, 7)
  assert.equal(result.attachments.length, 2)
  assert.equal(copies, 2)
  for (const [index, attachment] of result.attachments.entries()) {
    assert.deepEqual(
      await fs.readFile(join(f.root, attachment.url)),
      await fs.readFile(paths[index]),
    )
  }
  f.closed()
})

for (const [name, bytes, mime] of [
  ['small.gif', gif, 'image/gif'],
  [
    'small.svg',
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    'image/svg+xml',
  ],
  ['small.mp4', video, 'video/mp4'],
]) {
  test(`export embeds supported ${name} unchanged`, async (t) => {
    const f = await fixture(t)
    const path = await f.file(name, bytes)
    assert.equal(
      await f.exportDocumentMedia(path, f.state.note),
      `data:${mime};base64,${bytes.toString('base64')}`,
    )
    f.closed()
  })
}

for (const size of [8 * mib + 1, 14 * mib + 1]) {
  test(`export omits image of ${size} bytes without failing whole export`, async (t) => {
    const f = await fixture(t)
    const path = await f.file('large.gif', gif, size)
    assert.equal(await f.exportDocumentMedia(path, f.state.note), null)
    f.closed()
  })
}

test('export keeps explicit budget error for video above 14 mib', async (t) => {
  const f = await fixture(t)
  const path = await f.file('large.mp4', video, 14 * mib + 1)
  await assert.rejects(
    f.exportDocumentMedia(path, f.state.note),
    /Embedded media exceeds the 20 MiB export limit/,
  )
  f.closed()
})

test('export accepts image at 8 mib and video at 14 mib', async (t) => {
  const f = await fixture(t)
  for (const [name, header, size, mime] of [
    ['edge.gif', gif, 8 * mib, 'image/gif'],
    ['edge.mp4', video, 14 * mib, 'video/mp4'],
  ]) {
    const path = await f.file(name, header, size)
    const url = await f.exportDocumentMedia(path, f.state.note)
    assert.ok(url.startsWith(`data:${mime};base64,`))
    assert.equal(Buffer.from(url.split(',')[1], 'base64').length, size)
  }
  f.closed()
})

for (const size of [gif.length - 1, gif.length + 1]) {
  test(`export rejects file changing to ${size} bytes after sniffing`, async (t) => {
    const f = await fixture(t)
    const path = await f.file('changing.gif', gif)
    f.state.opened = () => fs.truncate(path, size)
    assert.equal(await f.exportDocumentMedia(path, f.state.note), null)
    f.closed()
  })
}

test('display opener remains uncapped while copy and export stay bounded', async (t) => {
  const f = await fixture(t)
  for (const [name, header, size] of [
    ['display.gif', gif, 8 * mib + 1],
    ['display.mp4', video, 512 * mib + 1],
  ]) {
    const path = await f.file(name, header, size)
    const media = await openMedia(path)
    try {
      assert.equal(media.stat.size, size)
    } finally {
      await media.file.close()
    }
  }
})

test('windows drops and attachments reject mixed UNC prefixes before opening files', async (t) => {
  const f = await fixture(t, win32.isAbsolute)
  for (const path of [
    String.raw`\??\UNC\server\share\x.gif`,
    String.raw`\??\C:\notes\x.gif`,
    String.raw`\/server/share/x.gif`,
    String.raw`/\server/share/x.gif`,
  ]) {
    assert.throws(() => f.filePath(path), /Drag a file here/)
    await assert.rejects(f.attachMedia(null, [path], 7), /Drag a file here/)
  }
  assert.equal(
    f.filePath(String.raw`C:\notes\x.gif`),
    String.raw`C:\notes\x.gif`,
  )
  assert.equal(f.handles.length, 0)
})
