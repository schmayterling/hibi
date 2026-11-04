import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs, {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import {
  refreshRemoteImage,
  remoteImageResponse,
} from '../src/main/remote-images.ts'

async function waitFor(check) {
  const end = performance.now() + 5000
  while (!(await check())) {
    if (performance.now() > end) throw new Error('The cache did not settle.')
    await delay(10)
  }
}

const SOURCE = 'https://images.test/garden.png'
const NAME = createHash('sha256').update(SOURCE).digest('hex')
const png = (text) =>
  Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(text)])

/** A workspace with a note, an app data folder, and an image host that records its requests. */
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-remote-images-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await mkdir(join(root, 'data'))
  const host = {
    root,
    workspace,
    place: {
      note: join(workspace, 'note.md'),
      workspace,
      data: join(root, 'data'),
    },
    kept: join(workspace, '.hibi', 'cache', 'images', NAME),
    requests: [],
    /** What the host answers next: a Response, or an error for no connection. */
    answer: () =>
      new Response(png('first'), {
        headers: {
          'Content-Type': 'image/png',
          ETag: '"first"',
          'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
        },
      }),
    fetch: async (url, init) => {
      host.requests.push({ url: String(url), init })
      const answer = host.answer(String(url))
      if (answer instanceof Error) throw answer
      return answer
    },
    draw: async (source = SOURCE, place = host.place) => {
      const response = await remoteImageResponse(source, place, host.fetch)
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        body: Buffer.from(await response.arrayBuffer()).toString('latin1'),
      }
    },
    /** Moves the kept copy's last check `hours` into the past. */
    age: async (hours, path = host.kept) => {
      const kept = JSON.parse(await readFile(`${path}.json`, 'utf8'))
      kept.checked -= hours * 60 * 60 * 1000
      await writeFile(`${path}.json`, JSON.stringify(kept))
    },
  }
  return host
}

const drawn = (text) => ({
  status: 200,
  type: 'image/png',
  body: png(text).toString('latin1'),
})

test('remote images are kept in the workspace cache, which git skips, and drawn from disk until a day old', async (t) => {
  const host = await setup(t)
  assert.deepEqual(await host.draw(), drawn('first'))
  assert.deepEqual(await host.draw(), drawn('first'))
  assert.equal(host.requests.length, 1)
  const [request] = host.requests
  assert.equal(request.url, SOURCE)
  assert.deepEqual(
    [request.init.credentials, request.init.redirect, request.init.cache],
    ['omit', 'manual', 'no-store'],
  )
  assert.equal(new Headers(request.init.headers).get('if-none-match'), null)
  assert.equal(
    await readFile(
      join(host.workspace, '.hibi', 'cache', '.gitignore'),
      'utf8',
    ),
    '*\n',
  )
  assert.deepEqual(
    (await readdir(join(host.workspace, '.hibi', 'cache', 'images'))).sort(),
    [NAME, `${NAME}.json`],
  )
  const kept = JSON.parse(await readFile(`${host.kept}.json`, 'utf8'))
  assert.deepEqual(
    [kept.url, kept.type, kept.size, kept.etag, kept.modified],
    [SOURCE, 'image/png', 13, '"first"', 'Wed, 01 Jan 2025 00:00:00 GMT'],
  )

  // A day later the host is asked with the copy's validators; unchanged, the
  // copy stays and counts as checked now.
  await host.age(25)
  host.answer = () => new Response(null, { status: 304 })
  assert.deepEqual(await host.draw(), drawn('first'))
  const revalidation = new Headers(host.requests[1].init.headers)
  assert.deepEqual(
    [revalidation.get('if-none-match'), revalidation.get('if-modified-since')],
    ['"first"', 'Wed, 01 Jan 2025 00:00:00 GMT'],
  )
  assert.deepEqual(await host.draw(), drawn('first'))
  assert.equal(host.requests.length, 2)

  // A changed image replaces the copy.
  await host.age(25)
  host.answer = () =>
    new Response(png('second'), { headers: { 'Content-Type': 'image/png' } })
  assert.deepEqual(await host.draw(), drawn('second'))
  // A copy checked in the future is checked again.
  await host.age(-48)
  assert.deepEqual(await host.draw(), drawn('second'))
  assert.equal(host.requests.length, 4)
})

test('offline or failing hosts leave the last copy showing; without one the image fails', async (t) => {
  const host = await setup(t)
  await host.draw()
  for (const answer of [
    () => new TypeError('fetch failed'),
    () => new Response('busy', { status: 503 }),
    () =>
      new Response('<h1>Sign in</h1>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    () => new Response(png('cut'), { headers: { 'Content-Length': '99' } }),
  ]) {
    await host.age(25)
    host.answer = answer
    assert.deepEqual(await host.draw(), drawn('first'))
  }
  assert.equal(host.requests.length, 5)
  host.answer = () => new TypeError('fetch failed')
  assert.equal((await host.draw('https://images.test/missing.png')).status, 404)
  for (const source of ['http://images.test/a.png', 'file:///etc/hosts', 7])
    assert.equal((await host.draw(source)).status, 404)
  assert.equal(host.requests.length, 6)
})

test('redirects stay on https, and hosts can neither send other files nor fill the disk', async (t) => {
  const host = await setup(t)
  host.answer = (url) =>
    url === SOURCE
      ? new Response(null, {
          status: 302,
          headers: { Location: '/moved.png' },
        })
      : new Response(png('moved'), { headers: { 'Content-Type': 'image/png' } })
  assert.deepEqual(await host.draw(), drawn('moved'))
  assert.deepEqual(
    host.requests.map(({ url }) => url),
    [SOURCE, 'https://images.test/moved.png'],
  )
  const fails = async (source, answer) => {
    host.answer = answer
    assert.equal((await host.draw(source)).status, 404, source)
  }
  await fails(
    'https://images.test/insecure.png',
    () =>
      new Response(null, {
        status: 301,
        headers: { Location: 'http://images.test/a.png' },
      }),
  )
  await fails(
    'https://images.test/loop.png',
    () =>
      new Response(null, { status: 302, headers: { Location: '/loop.png' } }),
  )
  await fails(
    'https://images.test/huge.png',
    () =>
      new Response(png('huge'), {
        headers: { 'Content-Length': String(65 * 1024 * 1024) },
      }),
  )
  await fails(
    'https://images.test/script.png',
    () =>
      new Response('alert(1)', {
        headers: { 'Content-Type': 'text/javascript' },
      }),
  )
  // A declared image type that sniffing can't confirm keeps the declared type.
  host.answer = () =>
    new Response('BM-bitmap', { headers: { 'Content-Type': 'image/bmp' } })
  assert.equal(
    (await host.draw('https://images.test/old.bmp')).type,
    'image/bmp',
  )
})

test('notes outside the workspace, and workspaces with a linked .hibi, keep images in the app data folder', async (t) => {
  const host = await setup(t)
  const outside = { ...host.place, note: join(host.root, 'loose.md') }
  assert.deepEqual(await host.draw(SOURCE, outside), drawn('first'))
  assert.deepEqual(await readdir(join(host.place.data, 'image-cache')), [
    NAME,
    `${NAME}.json`,
  ])
  const draft = { ...host.place, note: null }
  assert.deepEqual(await host.draw(SOURCE, draft), drawn('first'))
  assert.equal(host.requests.length, 1)
  const elsewhere = join(host.root, 'elsewhere')
  await mkdir(elsewhere)
  await symlink(elsewhere, join(host.workspace, '.hibi'))
  assert.deepEqual(await host.draw(), drawn('first'))
  assert.deepEqual(await readdir(elsewhere), [])
  assert.equal(host.requests.length, 1)
})

test("a workspace cache folder Hibi can't write to, such as in a shared folder, leaves images to the app data folder", async (t) => {
  const host = await setup(t)
  const images = join(host.workspace, '.hibi', 'cache', 'images')
  await mkdir(images, { recursive: true })
  if (process.platform === 'win32') {
    // Deny writes to the folder and new files, while keeping directory reads.
    execFileSync('icacls', [images, '/deny', '*S-1-1-0:(OI)(CI)(WD,AD)', '/Q'])
  } else await chmod(images, 0o500)
  await assert.rejects(
    writeFile(join(images, 'write-probe'), 'unwritable'),
    (error) => ['EACCES', 'EPERM'].includes(error.code),
  )
  assert.deepEqual(await host.draw(), drawn('first'))
  assert.deepEqual(await host.draw(), drawn('first'))
  assert.equal(host.requests.length, 1)
  assert.deepEqual(await readdir(images), [])
  assert.deepEqual(await readdir(join(host.place.data, 'image-cache')), [
    NAME,
    `${NAME}.json`,
  ])
})

test('draws at once share one download, and a refresh downloads again without validators', async (t) => {
  const host = await setup(t)
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  const answer = host.answer
  host.answer = () => held.then(answer)
  const draws = Promise.all([host.draw(), host.draw(), host.draw()])
  await waitFor(() => host.requests.length === 1)
  release()
  assert.deepEqual(await draws, [
    drawn('first'),
    drawn('first'),
    drawn('first'),
  ])
  assert.equal(host.requests.length, 1)
  host.answer = () =>
    new Response(png('fresh'), { headers: { 'Content-Type': 'image/png' } })
  await refreshRemoteImage(SOURCE, host.place, host.fetch)
  assert.equal(host.requests.length, 2)
  assert.equal(
    new Headers(host.requests[1].init.headers).get('if-none-match'),
    null,
  )
  assert.deepEqual(await host.draw(), drawn('fresh'))
  // Offline, a refresh keeps the copy.
  host.answer = () => new TypeError('fetch failed')
  await refreshRemoteImage(SOURCE, host.place, host.fetch)
  assert.deepEqual(await host.draw(), drawn('fresh'))
  assert.equal(host.requests.length, 3)
})

test('a host trickling bytes holds back neither the kept copy nor a refresh, which stops its check', {
  timeout: 30_000,
}, async (t) => {
  const host = await setup(t)
  assert.deepEqual(await host.draw(), drawn('first'))
  await host.age(25)
  // A byte at a time, each well within the quiet time.
  let ended = false
  t.after(() => {
    ended = true
  })
  host.answer = () =>
    new Response(
      new ReadableStream({
        async pull(controller) {
          await delay(200)
          if (ended) controller.close()
          else controller.enqueue(new Uint8Array([0]))
        },
      }),
      { headers: { 'Content-Type': 'image/png' } },
    )
  const settled = (work) =>
    Promise.race([work, delay(10_000).then(() => 'still waiting')])
  assert.deepEqual(await settled(host.draw()), drawn('first'))
  assert.equal(host.requests.length, 2)
  // A draw that comes later, as after a reload, shares the check's deadline,
  // which has passed, so it shows the copy at once. With time stopped, only
  // timers already due run: a deadline of its own would never come, and the
  // draw could only end with the check.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let later
  let checking
  host.draw().then((drawing) => {
    later = drawing
    checking = !host.requests[1].init.signal.aborted
  })
  while (!later) {
    t.mock.timers.tick(0)
    await new Promise(setImmediate)
  }
  t.mock.timers.reset()
  assert.deepEqual(later, drawn('first'))
  assert.equal(checking, true, 'the draw waited for the check to end')
  assert.equal(host.requests.length, 2)
  host.answer = () =>
    new Response(png('second'), { headers: { 'Content-Type': 'image/png' } })
  assert.equal(
    await settled(refreshRemoteImage(SOURCE, host.place, host.fetch)),
    undefined,
  )
  assert.ok(host.requests[1].init.signal.aborted)
  assert.deepEqual(await host.draw(), drawn('second'))
})

test("a refresh during an image's first download keeps that download, so its draws don't fail", async (t) => {
  const host = await setup(t)
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  const answer = host.answer
  host.answer = () => held.then(answer)
  const draw = host.draw()
  await waitFor(() => host.requests.length === 1)
  const refreshed = refreshRemoteImage(SOURCE, host.place, host.fetch)
  // Long enough for a refresh to stop the download, as it would a check.
  await delay(100)
  release()
  assert.deepEqual(await draw, drawn('first'))
  await refreshed
  assert.equal(host.requests.length, 1)
  assert.deepEqual(await host.draw(), drawn('first'))
})

test("a refresh restarts an image's first download that a host has held past the deadline", {
  timeout: 30_000,
}, async (t) => {
  const host = await setup(t)
  // A byte at a time, so the first download never ends on its own.
  let ended = false
  t.after(() => {
    ended = true
  })
  host.answer = () =>
    new Response(
      new ReadableStream({
        async pull(controller) {
          await delay(200)
          if (ended) controller.close()
          else controller.enqueue(new Uint8Array([0]))
        },
      }),
      { headers: { 'Content-Type': 'image/png' } },
    )
  const draw = host.draw()
  await waitFor(() => host.requests.length === 1)
  // Past the deadline, without waiting for it.
  const now = Date.now()
  t.mock.method(Date, 'now', () => now + 4000)
  host.answer = () =>
    new Response(png('second'), { headers: { 'Content-Type': 'image/png' } })
  assert.equal(
    await Promise.race([
      refreshRemoteImage(SOURCE, host.place, host.fetch),
      delay(10_000).then(() => 'still waiting'),
    ]),
    undefined,
  )
  assert.ok(host.requests[0].init.signal.aborted)
  // The stopped download's draw had nothing to show; the next has the refresh.
  assert.equal((await draw).status, 404)
  assert.deepEqual(await host.draw(), drawn('second'))
})

test('a full cache folder deletes the images checked longest ago', async (t) => {
  const host = await setup(t)
  const folder = join(host.place.data, 'image-cache')
  await mkdir(folder)
  const old = (name) => join(folder, name.repeat(64))
  // Sparse files take no disk space but count by their size.
  for (const [name, hours] of [
    ['a', 3],
    ['b', 2],
  ]) {
    await writeFile(old(name), '')
    await truncate(old(name), 300 * 1024 * 1024)
    await writeFile(`${old(name)}.json`, '{}')
    const time = new Date(Date.now() - hours * 60 * 60 * 1000)
    await utimes(`${old(name)}.json`, time, time)
  }
  await host.draw(SOURCE, { ...host.place, note: null })
  await waitFor(async () => !(await readdir(folder)).includes('a'.repeat(64)))
  assert.deepEqual((await readdir(folder)).sort(), [
    NAME,
    `${NAME}.json`,
    'b'.repeat(64),
    `${'b'.repeat(64)}.json`,
  ])
})

test('downloads that take a folder past its size delete the images checked longest ago at once', async (t) => {
  const host = await setup(t)
  const folder = join(host.place.data, 'image-cache')
  await mkdir(folder)
  const old = join(folder, 'a'.repeat(64))
  await writeFile(old, '')
  await truncate(old, 500 * 1024 * 1024)
  await writeFile(`${old}.json`, '{}')
  const time = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await utimes(`${old}.json`, time, time)
  const draft = { ...host.place, note: null }
  // Under the folder's size, the first download keeps everything.
  await host.draw(SOURCE, draft)
  await delay(100)
  assert.ok((await readdir(folder)).includes('a'.repeat(64)))
  // The next one passes it within the same hour.
  host.answer = () =>
    new Response(png('x'.repeat(13 * 1024 * 1024)), {
      headers: { 'Content-Type': 'image/png' },
    })
  await host.draw('https://images.test/large.png', draft)
  await waitFor(async () => !(await readdir(folder)).includes('a'.repeat(64)))
})

test('a host body full of comments is sniffed at once', async (t) => {
  // A backtracking pattern froze the main process on such a body; the worker
  // keeps a regression from freezing the test too.
  const worker = new Worker(
    `const { parentPort } = require('node:worker_threads')
    import(${JSON.stringify(new URL('../src/main/images.ts', import.meta.url).href)}).then(({ imageMime }) =>
      parentPort.postMessage(imageMime(Buffer.from('<!---->'.repeat(600) + 'x'))))`,
    { eval: true },
  )
  t.after(() => worker.terminate())
  const timer = setTimeout(() => worker.terminate(), 10_000)
  const [type] = await Promise.race([
    new Promise((resolve) => worker.once('message', (type) => resolve([type]))),
    new Promise((resolve) => worker.once('exit', () => resolve(['stalled']))),
  ])
  clearTimeout(timer)
  assert.equal(type, null)
})

test('a redirect to http is never requested', async (t) => {
  const host = await setup(t)
  host.answer = (url) =>
    url.startsWith('http:')
      ? new Response(png('plain'), { headers: { 'Content-Type': 'image/png' } })
      : new Response(null, {
          status: 301,
          headers: { Location: 'http://images.test/a.png' },
        })
  assert.equal(
    (await host.draw('https://images.test/insecure.png')).status,
    404,
  )
  assert.deepEqual(
    host.requests.map(({ url }) => url),
    ['https://images.test/insecure.png'],
  )
})

for (const declared of [true, false])
  test(`remote images above 64 MiB stream to disk with ${declared ? 'a declared' : 'no declared'} length`, async (t) => {
    const host = await setup(t)
    const header = png('')
    const chunk = new Uint8Array(64 * 1024)
    const chunks = 65 * 16
    const size = header.length + chunks * chunk.length
    let sent = 0
    host.answer = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (sent === 0) controller.enqueue(header)
            else if (sent <= chunks) controller.enqueue(chunk)
            else controller.close()
            sent++
          },
        }),
        {
          headers: {
            'Content-Type': 'image/png',
            ...(declared ? { 'Content-Length': String(size) } : {}),
          },
        },
      )
    const response = await remoteImageResponse(SOURCE, host.place, host.fetch)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-length'), String(size))
    let received = 0
    for await (const bytes of response.body) {
      assert.ok(bytes.length <= 64 * 1024)
      if (!received)
        assert.deepEqual(Buffer.from(bytes.subarray(0, header.length)), header)
      received += bytes.length
    }
    assert.equal(received, size)
    assert.equal(
      JSON.parse(await readFile(`${host.kept}.json`, 'utf8')).size,
      size,
    )
    assert.equal(host.requests.length, 1)
    const cached = await remoteImageResponse(SOURCE, host.place, host.fetch)
    assert.equal(cached.status, 200)
    await cached.body.cancel()
    assert.equal(host.requests.length, 1)
  })

test('the newest image can exceed the cache target and is evicted when a newer image needs the space', async (t) => {
  const host = await setup(t)
  await mkdir(join(host.workspace, '.hibi', 'cache', 'images'), {
    recursive: true,
  })
  await writeFile(host.kept, png(''))
  const size = 513 * 1024 * 1024
  await truncate(host.kept, size)
  await writeFile(
    `${host.kept}.json`,
    JSON.stringify({
      url: SOURCE,
      type: 'image/png',
      size,
      checked: Date.now() - 25 * 60 * 60 * 1000,
    }),
  )
  const old = join(dirname(host.kept), 'a'.repeat(64))
  await writeFile(old, '')
  await writeFile(`${old}.json`, '{}')
  await utimes(`${old}.json`, new Date(0), new Date(0))
  host.answer = () => new Response(null, { status: 304 })
  const response = await remoteImageResponse(SOURCE, host.place, host.fetch)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-length'), String(size))
  await response.body.cancel()
  await waitFor(
    async () => !(await readdir(dirname(host.kept))).includes('a'.repeat(64)),
  )
  assert.ok((await readdir(dirname(host.kept))).includes(NAME))
  const cached = await remoteImageResponse(SOURCE, host.place, host.fetch)
  assert.equal(cached.status, 200)
  await cached.body.cancel()
  assert.equal(host.requests.length, 1)
  // A subsequent download still evicts the old oversized copy.
  host.answer = () =>
    new Response(png('new'), { headers: { 'Content-Type': 'image/png' } })
  assert.deepEqual(await host.draw('https://images.test/new.png'), drawn('new'))
  await waitFor(async () => !(await readdir(dirname(host.kept))).includes(NAME))
})

test('a paused remote image consumer keeps disk reads bounded and cancellation closes the file', async (t) => {
  const host = await setup(t)
  await mkdir(dirname(host.kept), { recursive: true })
  await writeFile(host.kept, png(''))
  const size = 513 * 1024 * 1024
  await truncate(host.kept, size)
  await writeFile(
    `${host.kept}.json`,
    JSON.stringify({
      url: SOURCE,
      type: 'image/png',
      size,
      checked: Date.now(),
    }),
  )
  const open = fs.open
  let file
  let readBytes = 0
  t.mock.method(fs, 'open', async (...args) => {
    const opened = await open(...args)
    if (args[0] === host.kept) {
      file = opened
      const read = opened.read.bind(opened)
      t.mock.method(opened, 'read', async (...args) => {
        const result = await read(...args)
        readBytes += result.bytesRead
        return result
      })
    }
    return opened
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const response = await remoteImageResponse(SOURCE, host.place, host.fetch)
  try {
    await waitFor(() => readBytes > 0)
    // Give a missing backpressure strategy time to read ahead.
    await delay(50)
    assert.ok(
      readBytes <= 3 * 64 * 1024,
      `Read ${readBytes} bytes without a consumer.`,
    )
    assert.equal(host.requests.length, 0)
  } finally {
    await response.body.cancel()
  }
  await waitFor(() => file.fd === -1)
})
