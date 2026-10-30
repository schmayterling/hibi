import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
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
