import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'

test('remote https images neither send nor store cookies', {
  timeout: 45000,
}, async (t) => {
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
  const page = await app.firstWindow()
  const origin = `https://127.0.0.1:${server.address().port}`
  await app.evaluate(async ({ session }, url) => {
    session.defaultSession.setCertificateVerifyProc((_request, done) => done(0))
    await session.defaultSession.cookies.set({
      url,
      name: 'existing',
      value: '1',
      secure: true,
      sameSite: 'no_restriction',
    })
  }, origin)
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
  assert.deepEqual(
    await app.evaluate(
      async ({ session }, url) =>
        (await session.defaultSession.cookies.get({ url })).map(
          (cookie) => cookie.name,
        ),
      origin,
    ),
    ['existing'],
  )
})
