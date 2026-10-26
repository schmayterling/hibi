import assert from 'node:assert/strict'
import fs, { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { DocumentMediaServer } from '../src/main/document-media.ts'
import { observeDocumentMedia } from '../src/renderer/src/document-media.ts'
import { mediaPathsChanged } from '../src/shared/media.ts'

const gif = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
)

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-media-refresh-'))
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'assets', 'x.gif'), gif)
  t.after(() => rm(root, { recursive: true, force: true }))
  const scope = { note: join(root, 'a.md'), revision: 7, workspace: root }
  const server = new DocumentMediaServer(() => scope)
  const changes = new Set(),
    scopes = new Set(),
    pending = new Set()
  const disposers = []
  globalThis.window = {
    hibi: {
      resolveDocumentMedia(...args) {
        const result = server.resolve(...args)
        pending.add(result)
        void result.finally(() => pending.delete(result))
        return result
      },
      cancelDocumentMedia: async (request) => server.cancel(request),
      onWorkspaceHeaderChanged(callback) {
        changes.add(callback)
        return () => changes.delete(callback)
      },
      onDocumentMediaScopeChanged(callback) {
        scopes.add(callback)
        return () => scopes.delete(callback)
      },
    },
  }
  t.after(() => {
    for (const dispose of disposers) dispose()
  })
  const flush = async () => {
    await Promise.resolve()
    while (pending.size) await Promise.all([...pending])
    for (let i = 0; i < 4; i++) await Promise.resolve()
  }
  return {
    root,
    scope,
    server,
    flush,
    observe(source, listener) {
      disposers.push(observeDocumentMedia(source, 7, listener))
    },
    emit(change) {
      server.invalidate(change)
      for (const callback of changes) callback(change)
    },
    relocated() {
      for (const callback of scopes) callback(scope.revision)
    },
  }
}

test('rename/save-as/move re-resolves observed and duplicate images without changing revision', async (t) => {
  const f = await fixture(t)
  let shown, duplicate
  f.observe('assets/x.gif', (media) => {
    shown = media
  })
  await f.flush()
  for (const name of ['renamed.md', 'saved-as.md', 'moved.md']) {
    const previous = shown.url
    f.scope.note = join(f.root, name)
    f.emit({ kind: 'tree', paths: [name] })
    f.relocated()
    await f.flush()
    assert.notEqual(shown.url, previous)
    const response = await f.server.serve(new Request(shown.url))
    assert.equal(response.status, 200)
    await response.body.cancel()
    f.observe('assets/x.gif', (media) => {
      duplicate = media
    })
    assert.equal(duplicate.url, shown.url)
  }
})

test('first save resolves an untitled relative image whose dependencies were unknown', async (t) => {
  const f = await fixture(t)
  f.scope.note = null
  let shown
  f.observe('assets/x.gif', (media) => {
    shown = media
  })
  await f.flush()
  assert.equal(shown, null)
  assert.equal((await f.server.resolve('assets/x.gif', 7, 'check')).paths, null)
  f.scope.note = join(f.root, 'first-save.md')
  f.emit({ kind: 'tree', paths: ['first-save.md'] })
  f.relocated()
  await f.flush()
  assert.equal(shown.kind, 'image')
})

test('unknown-path resync preserves unchanged urls, callbacks and open video streams', async (t) => {
  const f = await fixture(t)
  const bytes = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('ftypisom'),
    Buffer.alloc(8 * 1024 * 1024),
  ])
  await writeFile(join(f.root, 'assets', 'clip.mp4'), bytes)
  const updates = []
  f.observe('assets/clip.mp4', (media) => updates.push(media))
  await f.flush()
  const url = updates[0].url
  const response = await f.server.serve(new Request(url))
  const reader = response.body.getReader()
  let length = (await reader.read()).value.byteLength
  f.emit({ kind: 'tree', paths: null })
  await f.flush()
  assert.equal(updates.length, 1)
  const repeated = await f.server.resolve('assets/clip.mp4', 7, 'again')
  assert.equal(repeated.media.url, url)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
  }
  assert.equal(length, bytes.length)
  await writeFile(
    join(f.root, 'assets', 'clip.mp4'),
    Buffer.concat([bytes, Buffer.from([0])]),
  )
  f.emit({ kind: 'tree', paths: null })
  await f.flush()
  assert.equal(updates.length, 2)
  assert.notEqual(updates[1].url, url)
  assert.equal((await f.server.serve(new Request(url))).status, 404)
})

test('watcher paths match case and unicode variants and scan each batch once', () => {
  assert.ok(
    mediaPathsChanged(['assets/photo.gif'], {
      kind: 'content',
      paths: ['Assets/Photo.gif'],
    }),
  )
  assert.ok(
    mediaPathsChanged(['assets/café.gif'], {
      kind: 'content',
      paths: ['Assets/cafe\u0301.gif'],
    }),
  )
  assert.ok(
    mediaPathsChanged(['assets/deep/photo.gif'], {
      kind: 'tree',
      paths: ['ASSETS'],
    }),
  )
  let reads = 0
  const paths = new Proxy(
    Array.from({ length: 1000 }, (_, i) => 'build/' + i + '/out.js'),
    {
      get(target, key, receiver) {
        if (/^\d+$/.test(String(key))) reads++
        return Reflect.get(target, key, receiver)
      },
    },
  )
  const change = { kind: 'tree', paths }
  for (let i = 0; i < 100; i++)
    assert.equal(mediaPathsChanged(['assets/' + i + '.gif'], change), false)
  assert.equal(reads, 1000)
})

test('stalled serve stays isolated and canceled resolutions retain their two pool slots until I/O finishes', async (t) => {
  const root = join(tmpdir(), 'virtual-media')
  const scope = { note: join(root, 'a.md'), revision: 7, workspace: root }
  const server = new DocumentMediaServer(() => scope)
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const info = {
    dev: 1,
    ino: 1,
    size: gif.length,
    mtimeMs: 1,
    ctimeMs: 1,
    isFile: () => true,
  }
  const blocked = new Set(),
    started = new Set()
  t.mock.method(fs, 'realpath', async (path) => path)
  t.mock.method(fs, 'stat', async () => info)
  t.mock.method(fs, 'open', async (path) => {
    if (blocked.has(path)) {
      started.add(path)
      await gate
    }
    return {
      stat: async () => info,
      read: async (buffer) => ({ bytesRead: gif.copy(buffer), buffer }),
      close: async () => {},
      createReadStream: () => Readable.from([gif], { objectMode: false }),
    }
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const fast = await server.resolve('assets/fast.gif', 7, 'fast')
  const slow = await server.resolve('assets/slow.gif', 7, 'issued-slow')
  blocked.add(join(root, 'assets', 'slow.gif'))
  const heldServe = server.serve(new Request(slow.media.url))
  let served, resolved
  const healthyServe = server
    .serve(new Request(fast.media.url))
    .then(async (response) => {
      served = response.status
      await response.body.cancel()
    })
  const healthyResolve = server
    .resolve('assets/later.gif', 7, 'later')
    .then((result) => {
      resolved = result
    })
  const jobs = []
  let afterCancel
  try {
    for (let i = 0; i < 100; i++) await Promise.resolve()
    assert.equal(served, 200)
    assert.equal(resolved.media.kind, 'image')
    for (let i = 0; i < 3; i++) {
      blocked.add(join(root, 'assets', 'blocked-' + i + '.gif'))
      jobs.push(
        server.resolve('assets/blocked-' + i + '.gif', 7, 'blocked-' + i),
      )
    }
    for (let i = 0; i < 40; i++) await Promise.resolve()
    assert.equal(started.size, 3) // One issued stream and two resolutions.
    jobs.push(
      server
        .resolve('assets/after-cancel.gif', 7, 'after-cancel')
        .then((result) => {
          afterCancel = result
        }),
    )
    server.cancel('blocked-0')
    server.cancel('blocked-2')
    assert.equal(await jobs[0], null)
    assert.equal(await jobs[2], null)
    for (let i = 0; i < 100; i++) await Promise.resolve()
    assert.equal(afterCancel, undefined)
    assert.equal(started.size, 3)
    assert.ok(!started.has(join(root, 'assets', 'blocked-2.gif')))
  } finally {
    release()
    const response = await heldServe
    await response.body?.cancel()
    await Promise.all([...jobs, healthyServe, healthyResolve])
  }
  assert.equal(afterCancel.media.kind, 'image')
})

test('two slow files admit local images after one second while real filesystem work stays capped at three', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const root = join(tmpdir(), 'virtual-media')
  const scope = { note: join(root, 'a.md'), revision: 7, workspace: root }
  const server = new DocumentMediaServer(() => scope)
  const info = {
    dev: 1,
    ino: 1,
    size: gif.length,
    mtimeMs: 1,
    isFile: () => true,
  }
  let releaseSlow, releaseLocal, startedSlow
  const slowGate = new Promise((resolve) => {
    releaseSlow = resolve
  })
  const localGate = new Promise((resolve) => {
    releaseLocal = resolve
  })
  const slowStarted = new Promise((resolve) => {
    startedSlow = resolve
  })
  let active = 0,
    peak = 0,
    slow = 0,
    localStarts = 0
  t.mock.method(fs, 'stat', async (path) => {
    active++
    peak = Math.max(peak, active)
    try {
      if (path.startsWith('/Volumes/NAS/')) {
        if (++slow === 2) startedSlow()
        await slowGate
        throw new Error('unavailable mount')
      }
      localStarts++
      await localGate
      return info
    } finally {
      active--
    }
  })
  t.mock.method(fs, 'realpath', async (path) => path)
  t.mock.method(fs, 'open', async () => ({
    stat: async () => info,
    read: async (buffer) => ({ bytesRead: gif.copy(buffer), buffer }),
    close: async () => {},
  }))
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const remote = ['a', 'b'].map((name) =>
    server.resolve(`/Volumes/NAS/${name}.jpg`, 7, name),
  )
  const local = Array.from({ length: 10 }, (_, i) =>
    server.resolve(`assets/${i}.gif`, 7, `local-${i}`),
  )
  try {
    await slowStarted
    assert.equal(active, 2)
    t.mock.timers.tick(999)
    assert.equal(localStarts, 0)
    t.mock.timers.tick(1)
    assert.equal(localStarts, 1)
    assert.equal(active, 3)
    t.mock.timers.tick(5000)
    assert.equal(localStarts, 1)
    assert.equal(peak, 3)
    releaseLocal()
    const shown = await Promise.all(local)
    assert.equal(
      shown.filter((result) => result.media?.kind === 'image').length,
      10,
    )
    assert.equal(active, 2)
    assert.equal(slow, 2)
    assert.equal(peak, 3)
  } finally {
    releaseSlow()
    releaseLocal()
    await Promise.all([...remote, ...local])
  }
})

test('ten autosaves during one stalled first resolution keep one real filesystem call and rerun once', async (t) => {
  const f = await fixture(t)
  const stat = fs.stat
  let release,
    calls = 0,
    active = 0,
    peak = 0
  const gate = new Promise((resolve) => {
    release = resolve
  })
  t.mock.method(fs, 'stat', async (...args) => {
    calls++
    active++
    peak = Math.max(peak, active)
    try {
      await gate
      return await stat(...args)
    } finally {
      active--
    }
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const updates = []
  f.observe('assets/x.gif', (media) => updates.push(media))
  try {
    for (let i = 0; i < 100; i++) await Promise.resolve()
    assert.equal(calls, 1)
    for (let event = 0; event < 10; event++) {
      f.emit({ kind: 'content', paths: ['a.md'] })
      for (let i = 0; i < 100; i++) await Promise.resolve()
    }
    assert.equal(calls, 1)
    assert.equal(peak, 1)
  } finally {
    release()
    await f.flush()
  }
  assert.equal(updates.length, 1)
  assert.equal(updates[0].kind, 'image')
  assert.equal(calls, 3) // One canceled stat, then one resolution's two validation stats.
  assert.equal(peak, 1)
})

test('scope changes during document open leave old-revision views alone', async (t) => {
  const f = await fixture(t)
  const updates = []
  f.observe('assets/x.gif', (media) => updates.push(media))
  await f.flush()
  const before = updates[0]
  f.scope.note = join(f.root, 'other.md')
  f.scope.revision++
  f.relocated()
  await f.flush()
  assert.deepEqual(updates, [before])
})

test('opened inode must match validation when a symlink changes during open', async (t) => {
  const f = await fixture(t)
  const media = await f.server.resolve('assets/x.gif', 7, 'image')
  const open = fs.open
  t.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args)
    const stat = file.stat.bind(file)
    t.mock.method(file, 'stat', async () => {
      const info = await stat()
      info.ino++
      return info
    })
    return file
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  assert.equal((await f.server.serve(new Request(media.media.url))).status, 404)
})

test('metadata-only ctime changes preserve tokens when path, inode, mime, size and mtime match', async (t) => {
  const f = await fixture(t)
  let shown
  f.observe('assets/x.gif', (media) => {
    shown = media
  })
  await f.flush()
  const before = shown.url
  const open = fs.open
  t.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args)
    const stat = file.stat.bind(file)
    t.mock.method(file, 'stat', async () => {
      const info = await stat()
      info.ctimeMs += 1000
      return info
    })
    return file
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  f.emit({ kind: 'tree', paths: null })
  await f.flush()
  assert.equal(shown.url, before)
})
