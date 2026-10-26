import assert from 'node:assert/strict'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { once } from 'node:events'
import {
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { Worker } from 'node:worker_threads'
import { exportOptions } from '../src/addons/documentation/options.ts'
import {
  readSiteFiles,
  SiteWorker,
} from '../src/addons/documentation/site-runtime.ts'
import { decodeSiteMedia } from '../src/site/media.ts'

const template =
  '<html lang="en"><head><title>site</title><style>body{}</style></head><body><div id="root"></div><script id="workspace-data" type="application/json">__HIBI_WORKSPACE_DATA__</script><script>void 0</script></body></html>'

test('owned export worker stages pages and yields main task turns while streaming files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-site-worker-'))
  const worker = new SiteWorker(resolve('out/main/documentation-worker.js'))
  const count = 100
  const paths = Array.from({ length: count }, (_, index) => index + '.md')
  let running = true,
    turns = 0
  const tick = () => {
    turns++
    if (running) setImmediate(tick)
  }
  setImmediate(tick)
  try {
    await worker.request({
      kind: 'start',
      directory,
      paths,
      name: 'notes',
      options: exportOptions({ singleFile: false, graph: true }),
    })
    for (const [markdown, sources] of [
      ['# Plain note\n\n[link](image.png)', []],
      [
        '![inline](image.png)\n\n![ref][picture]\n\n[picture]: other.png',
        ['image.png', 'other.png'],
      ],
      ['---\nimage: "![private](secret.png)"\n---\n# Note', []],
      ['`![code](code.png)`\n\n\\![escaped](escaped.png)', []],
    ])
      assert.deepEqual(
        await worker.request({
          kind: 'images',
          page: { path: '0.md', markdown },
        }),
        sources,
      )
    await Promise.all(
      paths.map((path) =>
        worker.request({
          kind: 'page',
          page: {
            path,
            markdown: '# Note\n\n[next](1.md)',
            html: '<h1>Note</h1><script>attack()</script>',
          },
        }),
      ),
    )
    assert.deepEqual((await readdir(directory)).sort(), [
      'files',
      'pages.jsonl',
    ])
    const files = await worker.request({
      kind: 'finish',
      template,
      css: '',
      colorschemes: [],
      addons: [],
      password: '',
    })
    assert.equal(files.length, count + 6)
    for (const file of files)
      assert.equal(
        file.bytes,
        (await readFile(join(directory, 'files', file.path))).length,
        file.path + ' reports exact UTF-8 bytes',
      )
    const artifact = await readSiteFiles(join(directory, 'files'), files)
    assert.equal(artifact.length, files.length)
    assert.ok(
      turns > count,
      turns + ' task turns while preparing ' + count + ' pages',
    )
    const data = await readFile(
      join(directory, 'files', 'hibi-assets', 'workspace.js'),
      'utf8',
    )
    const site = JSON.parse(data.slice('window.__HIBI_WORKSPACE__='.length, -1))
    assert.equal(site.pages.length, count)
    assert.equal(site.graph.nodes.length, count)
    assert.equal(site.graph.edges.length, count - 1)
    assert.doesNotMatch(data, /attack\(\)/)
    const html = await readFile(
      join(directory, 'files', '99.md', 'index.html'),
      'utf8',
    )
    assert.match(html, /<h1 id="note">Note<\/h1>/)
    assert.match(html, /98.md\//)
    await rename(
      join(directory, 'pages.jsonl'),
      join(directory, 'saved-pages.jsonl'),
    )
    await worker.request({
      kind: 'verify',
      page: { path: '99.md', markdown: '# Note\n\n[next](1.md)' },
    })
    await assert.rejects(
      worker.request({
        kind: 'verify',
        pages: [
          { path: '99.md', markdown: '# Note\n\n[next](1.md)' },
          { path: '98.md', markdown: '# Changed' },
        ],
      }),
      /workspace changed/,
    )
  } finally {
    running = false
    await worker.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('version-1 artifacts refuse oversized IPC payloads before reading content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-site-artifact-'))
  try {
    const file = await open(join(directory, 'large.html'), 'wx')
    try {
      await file.truncate(41 * 1024 * 1024)
    } finally {
      await file.close()
    }
    await assert.rejects(
      readSiteFiles(directory, [
        { path: 'large.html', bytes: 41 * 1024 * 1024 },
      ]),
      /Export to disk instead/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('worker rejects unsafe paths before any output is staged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-site-worker-invalid-'))
  const worker = new SiteWorker(resolve('out/main/documentation-worker.js'))
  try {
    await assert.rejects(
      worker.request({
        kind: 'start',
        directory,
        paths: ['../escape.md'],
        name: 'notes',
        options: exportOptions(),
      }),
      /invalid export path/,
    )
  } finally {
    await worker.close()
    await rm(directory, { recursive: true, force: true })
  }
})

for (const mode of [
  'folder',
  'single',
  'protected-folder',
  'protected-single',
  'memory',
]) {
  test(
    'worker streams bounded media for ' + mode + ' without plaintext sidecars',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'hibi-site-worker-media-'))
      const worker = new SiteWorker(resolve('out/main/documentation-worker.js'))
      const singleFile = mode === 'single' || mode === 'protected-single'
      const protectedSite = mode.startsWith('protected')
      const inMemory = mode === 'memory'
      const inline = singleFile || protectedSite || inMemory
      const asset = 'hibi-assets/media/' + 'a'.repeat(64) + '.png'
      const svg = 'hibi-assets/media/' + 'b'.repeat(64) + '.svg'
      const vector =
        '<svg xmlns="http://www.w3.org/2000/svg"><script>attack()</script></svg>'
      const bytes = Buffer.concat([
        Buffer.from('89504e470d0a1a0a', 'hex'),
        Buffer.from('PRIVATE-ASSET-SENTINEL-9153'.repeat(2000)),
        ...(mode === 'protected-single' ? [Buffer.alloc(8 * 1024 * 1024)] : []),
        ...(mode === 'protected-folder'
          ? [Buffer.alloc(15 * 1024 * 1024)]
          : []),
      ])
      const urls = []
      try {
        await worker.request({
          kind: 'start',
          directory,
          name: 'notes',
          paths: ['note.md'],
          options: exportOptions({ singleFile }),
          inMemory,
        })
        const sources = [
          { path: asset, source: join(directory, 'source.png'), value: bytes },
          { path: svg, source: join(directory, 'source.svg'), value: vector },
        ]
        const assets = []
        for (const { path, source, value } of sources) {
          await writeFile(source, value)
          const info = await stat(source)
          assets.push({ path, source, bytes: info.size, mtimeMs: info.mtimeMs })
        }
        await worker.request({
          kind: 'page',
          page: {
            path: 'note.md',
            markdown: '# Note\n\n![image](image.png)\n\n![vector](vector.svg)',
            html: '<h1>Note</h1><img src="image.png" alt="image">',
            images: { 'image.png': asset, 'vector.svg': svg },
          },
        })
        const files = await worker.request({
          kind: 'finish',
          template,
          css: '',
          colorschemes: [],
          addons: [],
          password: protectedSite ? 'private-export-password' : '',
          assets,
        })
        assert.equal(
          files.some((file) => file.path === asset),
          !inline,
        )
        const text = await readFile(
          join(
            directory,
            'files',
            singleFile ? 'index.html' : 'hibi-assets/workspace.js',
          ),
          'utf8',
        )
        let payload
        const blocks = []
        if (singleFile) {
          for (const block of text.matchAll(
            /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g,
          ))
            assert.ok(
              block[1].length <= 128 * 1024,
              'every inline JSON block stays bounded',
            )
          payload = JSON.parse(
            text.match(
              /<script id="workspace-data" type="application\/json">([\s\S]*?)<\/script>/,
            )[1],
          )
          for (const block of text.matchAll(
            /<script[^>]*data-site-media[^>]*>([\s\S]*?)<\/script>/g,
          ))
            blocks.push(block[1])
        } else {
          const window = {}
          runInNewContext(text, { window })
          payload = window.__HIBI_WORKSPACE__
          assert.ok(
            (window.__HIBI_MEDIA_FILES__ ?? []).length <= 8,
            '15 mib media uses at most eight packed files',
          )
          for (const path of window.__HIBI_MEDIA_FILES__ ?? []) {
            const script = await readFile(
              join(directory, 'files', path),
              'utf8',
            )
            assert.ok(script.length <= 4 * 1024 * 1024)
            runInNewContext(script, {
              window: {
                __HIBI_MEDIA_CHUNK__: (record) => {
                  assert.ok(record.length <= 128 * 1024)
                  blocks.push(record)
                },
              },
            })
          }
        }
        let decryptionKey
        if (protectedSite) {
          const ciphertext = Buffer.from(payload.ciphertext, 'base64')
          const key = pbkdf2Sync(
            'private-export-password',
            Buffer.from(payload.salt, 'base64'),
            payload.iterations,
            32,
            'sha256',
          )
          const cipher = createDecipheriv(
            'aes-256-gcm',
            key,
            Buffer.from(payload.iv, 'base64'),
          )
          cipher.setAuthTag(ciphertext.subarray(-16))
          payload = JSON.parse(
            Buffer.concat([
              cipher.update(ciphertext.subarray(0, -16)),
              cipher.final(),
            ]).toString('utf8'),
          )
          decryptionKey = await crypto.subtle.importKey(
            'raw',
            key,
            'AES-GCM',
            false,
            ['decrypt'],
          )
          assert.equal(text.includes('PRIVATE-ASSET-SENTINEL-9153'), false)
        }
        assert.equal(
          blocks.length,
          inMemory
            ? 0
            : (inline ? Math.ceil(bytes.length / (48 * 1024)) : 0) + 1,
          'only full records plus one final data record per asset',
        )
        async function* records() {
          yield* blocks
        }
        await decodeSiteMedia(payload, records(), decryptionKey)
        urls.push(...Object.values(payload.media))
        if (inMemory) {
          assert.equal(
            Buffer.from(
              payload.pages[0].images['vector.svg'].split(',')[1],
              'base64',
            ).toString('utf8'),
            vector,
          )
          assert.deepEqual(
            Buffer.from(
              payload.pages[0].images['image.png'].split(',')[1],
              'base64',
            ),
            bytes,
          )
          assert.equal(
            (await readSiteFiles(join(directory, 'files'), files)).length,
            files.length,
          )
        } else {
          assert.equal(await (await fetch(payload.media[svg])).text(), vector)
          if (inline)
            assert.deepEqual(
              Buffer.from(
                await (await fetch(payload.media[asset])).arrayBuffer(),
              ),
              bytes,
            )
          else {
            assert.equal(payload.pages[0].images['image.png'], asset)
            assert.ok(
              (
                await readFile(
                  join(directory, 'files/note.md/index.html'),
                  'utf8',
                )
              ).includes('../' + asset),
            )
          }
          assert.equal(payload.pages[0].images['vector.svg'], svg)
        }
        assert.equal(
          files.some((file) => file.path === svg),
          false,
        )
        await assert.rejects(readFile(join(directory, 'files', svg)), /ENOENT/)
        await assert.rejects(
          readFile(join(directory, 'files', asset)),
          /ENOENT/,
        )
        await assert.rejects(readdir(join(directory, 'assets')), /ENOENT/)
      } finally {
        for (const url of urls) URL.revokeObjectURL(url)
        await worker.close()
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
}

test('worker coalesces small output chunks while keeping exact UTF-8 bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-site-worker-writes-'))
  const entry = pathToFileURL(resolve('out/main/documentation-worker.js')).href
  const worker = new Worker(
    new URL(
      'data:text/javascript,' +
        encodeURIComponent(`
      import { promises as fs } from 'node:fs'
      import { syncBuiltinESMExports } from 'node:module'
      import { parentPort } from 'node:worker_threads'
      const counters = { writes: 0, bytes: 0, maxBytes: 0, syncs: 0, scratchFiles: 0 }
      const open = fs.open
      fs.open = async (path, ...args) => {
        const file = await open(path, ...args)
        const normalized = path.split(String.fromCharCode(92)).join('/')
        if (normalized.endsWith('/pages.jsonl')) counters.scratchFiles++
        if (normalized.endsWith('/files/index.html')) {
          const write = file.writeFile.bind(file)
          file.writeFile = (chunk, ...args) => {
            const bytes = Buffer.byteLength(chunk)
            counters.writes++
            counters.bytes += bytes
            counters.maxBytes = Math.max(counters.maxBytes, bytes)
            return write(chunk, ...args)
          }
        }
        const sync = file.sync.bind(file)
        file.sync = () => { counters.syncs++; return sync() }
        return file
      }
      syncBuiltinESMExports()
      const send = parentPort.postMessage.bind(parentPort)
      parentPort.postMessage = message => send({ ...message, counters })
      await import(${JSON.stringify(entry)})
    `),
    ),
  )
  const request = async (job) => {
    const reply = once(worker, 'message')
    worker.postMessage(job)
    const [message] = await reply
    if (message.error) throw new Error(message.error)
    return message
  }
  try {
    const paths = Array.from({ length: 100 }, (_, i) => i + '.md')
    await request({
      kind: 'start',
      directory,
      paths,
      name: 'notes',
      options: exportOptions({ singleFile: true }),
    })
    for (const path of paths)
      await request({
        kind: 'page',
        page: {
          path,
          markdown: '# 日本語\n\n' + '本文'.repeat(500),
          html: '<h1>日本語</h1>',
        },
      })
    const { result: files, counters } = await request({
      kind: 'finish',
      template,
      css: '',
      colorschemes: [],
      addons: [],
      password: '',
    })
    const bytes = await readFile(join(directory, 'files/index.html'))
    assert.equal(counters.bytes, bytes.length)
    assert.equal(files[0].bytes, bytes.length)
    assert.equal(counters.scratchFiles, 1)
    assert.equal(
      counters.syncs,
      0,
      'owned staging files need no durability sync',
    )
    assert.ok(
      counters.writes <= Math.ceil(bytes.length / (64 * 1024)) + 1,
      counters.writes + ' writes for ' + bytes.length + ' output bytes',
    )
    assert.ok(counters.maxBytes < 72 * 1024, 'one block plus one small page')
    const site = JSON.parse(
      bytes
        .toString('utf8')
        .match(
          /<script id="workspace-data" type="application\/json">([\s\S]*?)<\/script>/,
        )[1],
    )
    assert.equal(site.pages.length, paths.length)
    assert.equal(site.pages[99].markdown, '# 日本語\n\n' + '本文'.repeat(500))
  } finally {
    await worker.terminate()
    await rm(directory, { recursive: true, force: true })
  }
})
