import assert from 'node:assert/strict'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { exportOptions } from '../src/addons/documentation/options.ts'
import {
  readSiteFiles,
  SiteWorker,
} from '../src/addons/documentation/site-runtime.ts'

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
    'worker streams staged media for ' + mode + ' without encrypted sidecars',
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
      ])
      try {
        await worker.request({
          kind: 'start',
          directory,
          name: 'notes',
          paths: ['note.md'],
          options: exportOptions({ singleFile }),
          inMemory,
        })
        await mkdir(join(directory, 'assets', 'hibi-assets', 'media'), {
          recursive: true,
        })
        await writeFile(join(directory, 'assets', asset), bytes)
        await writeFile(join(directory, 'assets', svg), vector)
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
        let payload = JSON.parse(
          singleFile
            ? text.match(
                /<script id="workspace-data" type="application\/json">([\s\S]*?)<\/script>/,
              )[1]
            : text.slice('window.__HIBI_WORKSPACE__='.length, -1),
        )
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
          assert.equal(text.includes('PRIVATE-ASSET-SENTINEL-9153'), false)
          await assert.rejects(
            readFile(join(directory, 'files', asset)),
            /ENOENT/,
          )
        }
        assert.equal(
          Buffer.from(
            payload.pages[0].images['vector.svg'].split(',')[1],
            'base64',
          ).toString('utf8'),
          vector,
        )
        assert.equal(
          files.some((file) => file.path === svg),
          false,
        )
        await assert.rejects(readFile(join(directory, 'files', svg)), /ENOENT/)
        const image = payload.pages[0].images['image.png']
        if (inline)
          assert.deepEqual(Buffer.from(image.split(',')[1], 'base64'), bytes)
        else {
          assert.equal(image, asset)
          assert.deepEqual(
            await readFile(join(directory, 'files', asset)),
            bytes,
          )
          assert.ok(
            (
              await readFile(
                join(directory, 'files', 'note.md/index.html'),
                'utf8',
              )
            ).includes('../' + asset),
          )
        }
        if (inMemory)
          assert.equal(
            (await readSiteFiles(join(directory, 'files'), files)).length,
            files.length,
          )
      } finally {
        await worker.close()
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
}
