import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

/**
 * An https image host that tracks readers as a hostile one could: it sets a
 * cookie and a cache tag (ETag, Last-Modified) on every image, asks for
 * revalidation on every use, and records the cookies and validators it gets.
 */
async function imageHost(t) {
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=',
    'base64',
  )
  const cookies = []
  const validators = []
  const server = createServer(
    {
      cert: await readFile('tests/fixtures/host-network-localhost-cert.pem'),
      key: await readFile('tests/fixtures/host-network-localhost-key.pem'),
    },
    (request, response) => {
      cookies.push(request.headers.cookie ?? null)
      const validator = [
        request.headers['if-none-match'],
        request.headers['if-modified-since'],
      ]
        .filter(Boolean)
        .join(' ')
      validators.push(validator || null)
      response.writeHead(validator ? 304 : 200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-cache',
        ETag: '"reader-42"',
        'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
        'Set-Cookie': 'tracker=1; SameSite=None; Secure',
      })
      response.end(validator ? undefined : pixel)
    },
  )
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const folder = await mkdtemp(join(tmpdir(), 'hibi-image-cookies-'))
  const host = {
    folder,
    cookies,
    validators,
    origin: `https://127.0.0.1:${server.address().port}`,
    /** Starts the app, or restarts it on the same profile. */
    async launch() {
      await host.app?.close()
      host.app = await electron.launch({
        args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
      })
      host.page = await host.app.firstWindow()
      return host
    },
  }
  t.after(async () => {
    await host.app?.close()
    server.close()
    await rm(folder, { recursive: true, force: true })
  })
  return host.launch()
}

/** Shows an image in the app's page, as a note's image is. */
const show = (page, src) =>
  page.evaluate(
    (src) =>
      new Promise((done, fail) => {
        const image = new Image()
        image.onload = done
        image.onerror = () => fail(new Error(`${src} did not load`))
        image.src = src
      }),
    src,
  )

/** Trusts the test host's certificate in a session and gives it a cookie for the host. */
const trust = (app, origin, partition = null) =>
  app.evaluate(
    async ({ session }, [url, partition]) => {
      const target = partition
        ? session.fromPartition(partition, { cache: false })
        : session.defaultSession
      target.setCertificateVerifyProc((_request, done) => done(0))
      await target.cookies.set({
        url,
        name: 'existing',
        value: '1',
        secure: true,
        sameSite: 'no_restriction',
      })
    },
    [origin, partition],
  )

const stored = (app, origin, partition = null) =>
  app.evaluate(
    async ({ session }, [url, partition]) =>
      (
        await (partition
          ? session.fromPartition(partition, { cache: false })
          : session.defaultSession
        ).cookies.get({ url })
      ).map((cookie) => cookie.name),
    [origin, partition],
  )

test('remote https images neither send nor store cookies', {
  timeout: 45000,
}, async (t) => {
  const { app, page, origin, cookies } = await imageHost(t)
  await trust(app, origin)
  for (const path of ['/first.png', '/second.png'])
    await show(page, origin + path)
  assert.deepEqual(cookies, [null, null])
  assert.deepEqual(await stored(app, origin), ['existing'])
})

test('remote https images skip the cache, so hosts get no validators to recognize a reader by', {
  timeout: 90000,
}, async (t) => {
  const host = await imageHost(t)
  const src = `${host.origin}/tracked.png`
  await trust(host.app, host.origin)
  // A first view, a second after a reload, when the cache would revalidate
  // the image, and one more after a restart.
  await show(host.page, src)
  await host.page.reload()
  await show(host.page, src)
  await host.launch()
  await trust(host.app, host.origin)
  await show(host.page, src)
  assert.deepEqual(host.validators, [null, null, null])
  assert.deepEqual(host.cookies, [null, null, null])
})

test('PDF exports send image hosts no cookies or validators and keep no cookies between exports', {
  timeout: 60000,
}, async (t) => {
  const { app, page, origin, cookies, validators, folder } = await imageHost(t)
  await waitForDocumentEditor(app, page)
  // An empty untitled note is not a tab yet, so export an opened one.
  const note = join(folder, 'note.md')
  await writeFile(note, 'Remote images')
  await app.evaluate(({ dialog }, note) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [note] })
  }, note)
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+o`,
  )
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'note.md',
  )
  await trust(app, origin, 'hibi-print')
  for (const name of ['first', 'second']) {
    const target = join(folder, `${name}.pdf`)
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: target,
      })
    }, target)
    assert.equal(
      await page.evaluate(
        async (html) =>
          window.hibi.exportPdf((await window.hibi.getDocument()).tabId, html),
        `<img src="${origin}/tracked.png">`,
      ),
      target,
    )
  }
  assert.deepEqual(cookies, [null, null])
  assert.deepEqual(validators, [null, null])
  assert.deepEqual(await stored(app, origin, 'hibi-print'), ['existing'])
})
