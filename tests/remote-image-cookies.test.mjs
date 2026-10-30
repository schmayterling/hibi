import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

/** An https image host that records the cookies it gets and sets one on every image. */
async function imageHost(t) {
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=',
    'base64',
  )
  const cookies = []
  const server = createServer(
    {
      cert: await readFile('tests/fixtures/host-network-localhost-cert.pem'),
      key: await readFile('tests/fixtures/host-network-localhost-key.pem'),
    },
    (request, response) => {
      cookies.push(request.headers.cookie ?? null)
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'Set-Cookie': 'tracker=1; SameSite=None; Secure',
      })
      response.end(pixel)
    },
  )
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const folder = await mkdtemp(join(tmpdir(), 'hibi-image-cookies-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    server.close()
    await rm(folder, { recursive: true, force: true })
  })
  return {
    app,
    folder,
    cookies,
    page: await app.firstWindow(),
    origin: `https://127.0.0.1:${server.address().port}`,
  }
}

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
    await page.evaluate(
      (src) =>
        new Promise((done, fail) => {
          const image = new Image()
          image.onload = done
          image.onerror = () => fail(new Error(`${src} did not load`))
          image.src = src
        }),
      origin + path,
    )
  assert.deepEqual(cookies, [null, null])
  assert.deepEqual(await stored(app, origin), ['existing'])
})

test('PDF exports send image hosts no cookies and keep none between exports', {
  timeout: 60000,
}, async (t) => {
  const { app, page, origin, cookies, folder } = await imageHost(t)
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
        `<img src="${origin}/${name}.png">`,
      ),
      target,
    )
  }
  assert.deepEqual(cookies, [null, null])
  assert.deepEqual(await stored(app, origin, 'hibi-print'), ['existing'])
})
