import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { exportOptions } from '../src/addons/documentation/options.ts'
import { SiteWorker } from '../src/addons/documentation/site-runtime.ts'

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
    for (const path of paths)
      await worker.request({
        kind: 'page',
        page: {
          path,
          markdown: '# Note\n\n[next](1.md)',
          html: '<h1>Note</h1><script>attack()</script>',
        },
      })
    const files = await worker.request({
      kind: 'finish',
      template,
      css: '',
      colorschemes: [],
      addons: [],
      password: '',
    })
    assert.equal(files.length, count + 6)
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
  } finally {
    running = false
    await worker.close()
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
