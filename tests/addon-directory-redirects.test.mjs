import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'

test('the addon directory follows a redirect on its own host without cookies', {
  timeout: 45000,
}, async (t) => {
  const entry = {
    id: 'example',
    name: 'Example',
    description: 'Directory fixture',
    version: '1.0.0',
    apiVersion: 3,
    kind: 'extension',
    authors: [{ displayName: 'Author' }],
    license: 'MIT',
    path: 'addons/example',
  }
  const requests = []
  const server = createServer(
    {
      cert: await readFile('tests/fixtures/host-network-localhost-cert.pem'),
      key: await readFile('tests/fixtures/host-network-localhost-key.pem'),
    },
    (request, response) => {
      requests.push([request.url, request.headers.cookie ?? null])
      if (request.url === '/catalog.json') {
        response.writeHead(302, {
          Location: '/moved/catalog.json',
          'Set-Cookie': 'moved=1; SameSite=None; Secure',
        })
        response.end()
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify([entry]))
      }
    },
  )
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const folder = await mkdtemp(join(tmpdir(), 'hibi-directory-redirects-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    env: {
      ...process.env,
      HIBI_TEST_ADDON_DIRECTORY_URL: `https://127.0.0.1:${server.address().port}/catalog.json`,
    },
  })
  t.after(async () => {
    await app.close()
    server.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await app.evaluate(({ session }) =>
    session.defaultSession.setCertificateVerifyProc((_request, done) =>
      done(0),
    ),
  )
  const directory = await page.evaluate(() =>
    window.hibi.getAddonDirectory(true),
  )
  assert.equal(directory.error, undefined)
  assert.deepEqual(directory.entries, [entry])
  assert.deepEqual(requests, [
    ['/catalog.json', null],
    ['/moved/catalog.json', null],
  ])
})
