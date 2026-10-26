import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { posix, win32 } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const source = stripTypeScriptTypes(
  await readFile(new URL('../src/main/images.ts', import.meta.url), 'utf8'),
)
  .replace(/^import[\s\S]*?from '[^']+'\n/gm, '')
  .replace(/^export /gm, '')

function harness(paths, files = {}) {
  const calls = []
  const bindings = {
    constants,
    dirname: paths.dirname,
    isAbsolute: paths.isAbsolute,
    resolve: paths.resolve,
    win32,
    fileURLToPath: (url) => fileURLToPath(url, { windows: paths === win32 }),
    isPathInside: (base, path) => {
      const relative = paths.relative(base, path)
      return (
        !paths.isAbsolute(relative) &&
        relative !== '..' &&
        !relative.startsWith(`..${paths.sep}`)
      )
    },
  }
  for (const name of ['lstat', 'open', 'readFile', 'realpath', 'stat'])
    bindings[name] = async (...args) => {
      calls.push([name, ...args])
      if (files[name]) return files[name](...args)
      throw new Error('unexpected filesystem access')
    }
  const api = new Function(
    ...Object.keys(bindings),
    `${source}\nreturn { documentMediaPath, resolveDocumentMediaPath, readDocumentImage }`,
  )(...Object.values(bindings))
  return { ...api, calls }
}

const uncSources = [
  String.raw`\??\UNC\server\share\image.png`,
  String.raw`\??\C:\photos\image.png`,
  String.raw`/??\UNC/server/share/image.png`,
  '%5c%3f%3f%5cUNC%5cserver%5cshare%5cimage.png',
  '//server/share/image.png',
  String.raw`\\server\share\image.png`,
  String.raw`/\server/share/image.png`,
  String.raw`\/server/share/image.png`,
  '%2f%2fserver/share/image.png',
  '%5c%5cserver/share/image.png',
  '%2f%5cserver/share/image.png',
  '%5c%2fserver/share/image.png',
  '/%5cserver/share/image.png',
  String.raw`\%2fserver/share/image.png`,
  String.raw`\\?\UNC\server\share\image.png`,
  String.raw`/\?\UNC\server\share\image.png`,
]
const hostedFileSources = [
  'file://server/share/image.png',
  'FILE://server/share/image.png',
  String.raw`file:/\server/share/image.png`,
  String.raw`file:\/server/share/image.png`,
  String.raw`file:\\server\share\image.png`,
  'file:////server/share/image.png',
  'file://localhost/C:/image.png',
  'file://LOCALHOST/C:/image.png',
  'file://%6cocalhost/C:/image.png',
  'file:\t//localhost/C:/image.png',
  'file:///%5cserver/share/image.png',
]

for (const paths of [posix, win32]) {
  const platform = paths === win32 ? 'win32' : 'posix'
  const note = paths === win32 ? String.raw`C:\notes\note.md` : '/notes/note.md'
  const workspace = paths.dirname(note)

  for (const [kind, sources] of [
    ['unc variants', uncSources],
    ['hosted file urls', hostedFileSources],
  ])
    test(`${platform}: ${kind} reject before filesystem access`, async () => {
      const h = harness(paths)
      for (const input of sources) {
        assert.equal(h.documentMediaPath(input, note), null, input)
        const dependencies = new Set()
        assert.equal(
          await h.resolveDocumentMediaPath(input, note, workspace, {
            paths: dependencies,
          }),
          null,
          input,
        )
        assert.equal(
          await h.readDocumentImage(input, note, workspace),
          null,
          input,
        )
        assert.equal(dependencies.size, 0, input)
        assert.deepEqual(h.calls, [], input)
      }
    })

  test(`${platform}: local paths retain resolution behavior`, () => {
    const h = harness(paths)
    const absolute =
      paths === win32 ? String.raw`C:\photos\image.png` : '/photos/image.png'
    const localUrl =
      paths === win32
        ? 'file:///C:/photos/image%20one.png'
        : 'file:///photos/image%20one.png'
    for (const [input, document, expected] of [
      [absolute, null, absolute],
      [
        'assets/image%20one.png',
        note,
        paths.resolve(workspace, 'assets/image one.png'),
      ],
      ['../image.png', note, paths.resolve(workspace, '../image.png')],
      ['assets/100%.png', note, paths.resolve(workspace, 'assets/100%.png')],
      [
        'assets/%252f%255cimage.png',
        note,
        paths.resolve(workspace, 'assets/%2f%5cimage.png'),
      ],
      [localUrl, null, fileURLToPath(localUrl, { windows: paths === win32 })],
      [
        'C:/photos/image.png',
        note,
        paths === win32
          ? 'C:/photos/image.png'
          : paths.resolve(workspace, 'C:/photos/image.png'),
      ],
      [
        String.raw`C:\photos\image.png`,
        note,
        paths === win32
          ? String.raw`C:\photos\image.png`
          : paths.resolve(workspace, String.raw`C:\photos\image.png`),
      ],
      ['assets/image.png', null, null],
    ])
      assert.equal(h.documentMediaPath(input, document), expected, input)
    assert.deepEqual(h.calls, [])
  })
}

test('win32: relative media on a trusted document share resolve and read normally', async () => {
  const bytes = Buffer.from('GIF89a')
  const h = harness(win32, {
    stat: async () => ({ isFile: () => true }),
    realpath: async (path) => path,
    open: async () => ({
      stat: async () => ({ isFile: () => true, size: bytes.length }),
      read: async (buffer) => ({ bytesRead: bytes.copy(buffer) }),
      close: async () => {},
    }),
  })
  for (const note of [
    String.raw`\\server\share\notes\note.md`,
    '//server/share/notes/note.md',
  ]) {
    for (const input of [
      'image.png',
      '../image.png',
      'assets/image%20one.png',
    ]) {
      const expected = win32.resolve(
        win32.dirname(note),
        decodeURIComponent(input),
      )
      assert.equal(h.documentMediaPath(input, note), expected, input)
      assert.equal(
        await h.resolveDocumentMediaPath(input, note, win32.dirname(note)),
        expected,
        input,
      )
      assert.equal(
        await h.readDocumentImage(input, note),
        `data:image/gif;base64,${bytes.toString('base64')}`,
        input,
      )
    }
  }
})

test('win32: explicit unc sources and hosted file urls stay blocked even on the same share', async () => {
  const h = harness(win32)
  const note = String.raw`\\server\share\notes\note.md`
  for (const input of [...uncSources, ...hostedFileSources]) {
    assert.equal(h.documentMediaPath(input, note), null, input)
    assert.equal(
      await h.resolveDocumentMediaPath(input, note, win32.dirname(note)),
      null,
      input,
    )
    assert.equal(await h.readDocumentImage(input, note), null, input)
  }
  assert.deepEqual(h.calls, [])
})
