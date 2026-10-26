import assert from 'node:assert/strict'
import fs, { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DocumentMediaServer } from '../src/main/document-media.ts'

const gif = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
)

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-stream-unit-'))
  await mkdir(join(root, 'assets'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const scope = { note: join(root, 'note.md'), revision: 7, workspace: root }
  return { root, scope, server: new DocumentMediaServer(() => scope) }
}

function countIO(t) {
  const counts = { opens: 0, reads: 0, bytes: 0, stats: 0 }
  const open = fs.open,
    stat = fs.stat
  t.mock.method(fs, 'open', async (...args) => {
    counts.opens++
    const file = await open(...args)
    const read = file.read.bind(file)
    t.mock.method(file, 'read', async (...args) => {
      counts.reads++
      const result = await read(...args)
      counts.bytes += result.bytesRead
      return result
    })
    return file
  })
  t.mock.method(fs, 'stat', (...args) => {
    counts.stats++
    return stat(...args)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  return counts
}

test('main shares concurrent resolutions; 20 images x 100 unrelated changes do zero native reads', async (t) => {
  const { root, server } = await fixture(t)
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      writeFile(join(root, 'assets', `${i}.gif`), gif),
    ),
  )
  const counts = countIO(t)
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      Promise.all(
        Array.from({ length: 3 }, (_, j) =>
          server.resolve(`assets/${i}.gif`, 7, `${i}-${j}`),
        ),
      ),
    ),
  )
  assert.equal(counts.opens, 20)
  assert.equal(counts.reads, 20)
  for (const group of results)
    assert.equal(new Set(group.map((r) => r.media.url)).size, 1)
  const before = { ...counts }
  for (let i = 0; i < 100; i++) {
    server.invalidate({ kind: 'tree', paths: [`build/${i}.js`] })
    await Promise.all(
      Array.from({ length: 20 }, (_, j) =>
        server.resolve(`assets/${j}.gif`, 7, `again-${j}`),
      ),
    )
  }
  assert.deepEqual(counts, before)
  t.diagnostic(
    JSON.stringify({
      images: 20,
      unrelatedEvents: 100,
      extraOpens: counts.opens - before.opens,
      extraReads: counts.reads - before.reads,
      extraBytes: counts.bytes - before.bytes,
    }),
  )
  await writeFile(
    join(root, 'assets', '3.gif'),
    Buffer.concat([gif, Buffer.from([0])]),
  )
  server.invalidate({ kind: 'content', paths: ['assets/3.gif'] })
  const refreshed = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      server.resolve(`assets/${i}.gif`, 7, `refresh-${i}`),
    ),
  )
  assert.equal(counts.opens, before.opens + 1)
  assert.deepEqual(
    refreshed.flatMap((r, i) =>
      r.media.url === results[i][0].media.url ? [] : [i],
    ),
    [3],
  )
  assert.equal(
    (await server.serve(new Request(results[3][0].media.url))).status,
    404,
  )
})

test('cancelled queued requests and stale revisions perform no native I/O', async (t) => {
  const { server } = await fixture(t)
  const counts = countIO(t)
  const queued = server.resolve('assets/never.gif', 7, 'unmounted')
  server.cancel('unmounted')
  assert.equal(await queued, null)
  assert.equal(await server.resolve('assets/never.gif', 6, 'stale'), null)
  assert.deepEqual(counts, { opens: 0, reads: 0, bytes: 0, stats: 0 })
})

test('cancelling during path resolution stops before opening a file', async (t) => {
  const { root, server } = await fixture(t)
  await writeFile(join(root, 'assets', 'image.gif'), gif)
  const stat = fs.stat
  let finish
  const waiting = new Promise((resolve) => {
    finish = resolve
  })
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  const counts = countIO(t)
  t.mock.method(fs, 'stat', async (...args) => {
    started()
    await waiting
    return stat(...args)
  })
  syncBuiltinESMExports()
  const pending = server.resolve('assets/image.gif', 7, 'obsolete')
  await ready
  server.cancel('obsolete')
  finish()
  assert.equal(await pending, null)
  assert.equal(counts.opens, 0)
})

test('streams images larger than 8 MiB, supports ranges, and denies stale or aborted URLs without I/O', async (t) => {
  const { root, scope, server } = await fixture(t)
  const bytes = Buffer.concat([gif, Buffer.alloc(9 * 1024 * 1024)])
  await writeFile(join(root, 'assets', 'large.gif'), bytes)
  const counts = countIO(t)
  const { media } = await server.resolve('assets/large.gif', 7, 'large')
  assert.match(media.url, /^app:\/\/hibi\/document-media\//)
  assert.equal(counts.bytes, 4096)
  const response = await server.serve(new Request(media.url))
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  const partial = await server.serve(
    new Request(media.url, { headers: { range: 'bytes=0-15' } }),
  )
  assert.equal(partial.status, 206)
  assert.deepEqual(
    Buffer.from(await partial.arrayBuffer()),
    bytes.subarray(0, 16),
  )
  const invalid = await server.serve(
    new Request(media.url, { headers: { range: 'bytes=999999999-' } }),
  )
  assert.equal(invalid.status, 416)
  const before = { ...counts }
  const controller = new AbortController()
  controller.abort()
  assert.equal(
    (await server.serve(new Request(media.url, { signal: controller.signal })))
      .status,
    404,
  )
  scope.revision++
  assert.equal((await server.serve(new Request(media.url))).status, 404)
  assert.deepEqual(counts, before)
})

test('svg receives inert response headers, and missing media tracks only relevant fallback paths', async (t) => {
  const { root, server } = await fixture(t)
  await mkdir(join(root, 'public', 'uploads'), { recursive: true })
  await writeFile(
    join(root, 'public', 'uploads', 'draw.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>',
  )
  const { media, paths } = await server.resolve('/uploads/draw.svg', 7, 'svg')
  assert.ok(paths.includes('public/uploads/draw.svg'))
  assert.ok(paths.includes('uploads/draw.svg'))
  const response = await server.serve(new Request(media.url))
  assert.equal(response.headers.get('Content-Type'), 'image/svg+xml')
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.match(
    response.headers.get('Content-Security-Policy'),
    /sandbox; default-src 'none'/,
  )
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY')
  await response.body.cancel()
  const missing = await server.resolve('assets/later.gif', 7, 'missing')
  assert.equal(missing.media, null)
  assert.ok(missing.paths.includes('assets/later.gif'))
  await writeFile(join(root, 'assets', 'later.gif'), gif)
  server.invalidate({ kind: 'tree', paths: ['assets'] })
  assert.ok((await server.resolve('assets/later.gif', 7, 'created')).media)
})

test('streaming revalidates a fallback symlink instead of serving a replacement outside the workspace', async (t) => {
  const { root, server } = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), 'hibi-stream-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await mkdir(join(root, 'public'))
  await mkdir(join(root, 'safe'))
  await writeFile(join(root, 'safe', 'image.gif'), gif)
  await writeFile(join(outside, 'image.gif'), gif)
  await symlink(join(root, 'safe'), join(root, 'public', 'uploads'), 'junction')
  const { media } = await server.resolve('/uploads/image.gif', 7, 'safe')
  await rm(join(root, 'public', 'uploads'))
  await symlink(outside, join(root, 'public', 'uploads'), 'junction')
  assert.equal((await server.serve(new Request(media.url))).status, 404)
})

test('last subscriber releases a completed URL; late requests do no I/O', async (t) => {
  const { root, server } = await fixture(t)
  await writeFile(join(root, 'assets', 'image.gif'), gif)
  const counts = countIO(t)
  const [first, second] = await Promise.all([
    server.resolve('assets/image.gif', 7, 'first-view'),
    server.resolve('assets/image.gif', 7, 'second-view'),
  ])
  assert.equal(first.media.url, second.media.url)
  server.cancel('first-view')
  const active = await server.serve(new Request(second.media.url))
  assert.equal(active.status, 200)
  await active.body.cancel()
  server.cancel('second-view')
  const before = { ...counts }
  assert.equal((await server.serve(new Request(second.media.url))).status, 404)
  assert.deepEqual(counts, before)
})
