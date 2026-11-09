import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createRawServer } from 'node:net'
import { resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { fixtureVault } from './obsidian/harness.mjs'

test('trusted API fixture has main-process networking, real moment and local protocol links', {
  timeout: 90000,
}, async (t) => {
  const fixture = await fixtureVault(t, 'api-parity', { cleanup: false })
  let hungClosed
  const disconnected = new Promise((resolve) => {
    hungClosed = resolve
  })
  let hungStarted
  const started = new Promise((resolve) => {
    hungStarted = resolve
  })
  const hits = []
  // Node's HTTP parser refuses unknown methods before its request callback.
  const raw = createRawServer((socket) => {
    let headers = ''
    socket.on('data', (bytes) => {
      headers += bytes.toString('latin1')
      if (!headers.includes('\r\n\r\n')) return
      socket.removeAllListeners('data')
      const body = JSON.stringify({ method: headers.split(' ')[0] })
      socket.end(
        'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' +
          Buffer.byteLength(body) +
          '\r\nConnection: close\r\n\r\n' +
          body,
      )
    })
  })
  await new Promise((resolve) => raw.listen(0, '127.0.0.1', resolve))
  const customBase = 'http://127.0.0.1:' + raw.address().port
  t.after(() => raw.close())
  const serve = async (req, res) => {
    hits.push(req.url)
    if (req.url === '/hang') {
      hungStarted()
      res.on('close', hungClosed)
      return
    }
    if (req.url === '/redirect') {
      res.writeHead(307, { Location: '/echo' }).end()
      return
    }
    if (req.url === '/loop') {
      res.writeHead(302, { Location: '/loop' }).end()
      return
    }
    if (req.url === '/binary') {
      res.writeHead(200, {
        'X-Fixture': 'binary',
        'Content-Type': 'application/octet-stream',
      })
      res.end(Buffer.from([0, 128, 255, 13, 10]))
      return
    }
    if (req.url === '/missing') {
      res
        .writeHead(404, { 'Content-Type': 'application/json' })
        .end('{"error":"missing"}')
      return
    }
    if (req.url === '/empty') {
      res.writeHead(204).end()
      return
    }
    const parts = []
    for await (const chunk of req) parts.push(chunk)
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Fixture': 'yes',
    })
    res.end(
      JSON.stringify({
        method: req.method,
        headers: req.headers,
        bytes: [...Buffer.concat(parts)],
      }),
    )
  }
  const server = createServer(serve)
  const cert = await readFile(
    new URL('./fixtures/host-network-localhost-cert.pem', import.meta.url),
    'utf8',
  )
  const key = await readFile(
    new URL('./fixtures/host-network-localhost-key.pem', import.meta.url),
    'utf8',
  )
  const https = createHttpsServer({ cert, key }, serve)
  await new Promise((resolve) => https.listen(0, '127.0.0.1', resolve))
  const secureBase = 'https://127.0.0.1:' + https.address().port
  t.after(() => {
    https.closeAllConnections()
    https.close()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const app = await electron.launch({
    args: [resolve('.'), '--user-data-dir=' + fixture.overlay],
    env: { ...process.env, LANG: 'fr_FR.UTF-8' },
  })
  t.after(async () => {
    try {
      await app.close()
      await fixture.assertUnchanged()
    } finally {
      await fixture.dispose()
    }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ session }, cert) => {
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      callback(
        request.hostname === '127.0.0.1' &&
          request.certificate.data.trim() === cert.trim()
          ? 0
          : -3,
      )
    })
  }, cert)
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, fixture.folder)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page
    .getByRole('checkbox', { name: 'Obsidian plugins', exact: true })
    .click()
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page
    .getByRole('button', {
      name: 'Install Obsidian plugin from folder',
      exact: true,
    })
    .click()
  const enabled = page.getByRole('checkbox', {
    name: 'Enable API parity',
    exact: true,
  })
  await enabled.click()
  await page.waitForFunction(() => window.__apiParity?.rendered)
  await t.test(
    'requestUrl sends methods, binary, headers and follows redirects without CORS',
    async () => {
      const actual = await page.evaluate(
        async ({ base, secureBase, customBase }) => {
          const f = window.__apiParity
          const secure = await f.requestUrl({
            url: secureBase + '/echo',
            method: 'PUT',
            body: 'héllo✓',
            contentType: 'text/plain',
          })
          const deprecated = JSON.parse(await f.request(base + '/echo'))
          const selfFetch = await f.fetch.call(window, window.location.href)
          const request = f.requestUrl({
            url: base + '/redirect',
            method: 'PATCH',
            contentType: 'application/octet-stream',
            headers: { 'X-Token': 'fixture' },
            body: new Uint8Array([0, 128, 255]).buffer,
          })
          const response = await request
          const binary = await f.requestUrl(base + '/binary')
          const missing = await f.requestUrl({
            url: base + '/missing',
            throw: false,
          })
          let statusError
          try {
            await f.requestUrl(base + '/missing')
          } catch (error) {
            statusError = error.message
          }
          const empty = await f.requestUrl(base + '/empty')
          let jsonError = false
          try {
            await f.requestUrl(base + '/empty').json
          } catch {
            jsonError = true
          }
          let loopError = false
          try {
            await f.requestUrl(base + '/loop')
          } catch {
            loopError = true
          }
          const methods = []
          for (const method of [
            'GET',
            'POST',
            'PUT',
            'DELETE',
            'OPTIONS',
            'CUSTOM',
          ]) {
            methods.push(
              (
                await f.requestUrl({
                  url: (method === 'CUSTOM' ? customBase : base) + '/echo',
                  method,
                })
              ).json.method,
            )
          }
          const head = await f.requestUrl({
            url: base + '/echo',
            method: 'HEAD',
          })
          f.networkPassed = true
          return {
            status: response.status,
            header: response.headers['x-fixture'],
            echoed: response.json,
            shortcut: await request.json,
            text: await request.text,
            bytes: [...new Uint8Array(binary.arrayBuffer)],
            missing: missing.status,
            statusError,
            empty: empty.status,
            jsonError,
            loopError,
            methods,
            head: [head.status, head.text],
            fetchSame: f.fetch === window.fetch,
            secure: secure.json,
            deprecated: deprecated.method,
            selfFetch: selfFetch.status,
          }
        },
        { base, secureBase, customBase },
      )
      assert.equal(actual.status, 200)
      assert.equal(actual.header, 'yes')
      assert.equal(actual.echoed.method, 'PATCH')
      assert.equal(actual.echoed.headers['x-token'], 'fixture')
      assert.equal(
        actual.echoed.headers['content-type'],
        'application/octet-stream',
      )
      assert.deepEqual(actual.echoed.bytes, [0, 128, 255])
      assert.deepEqual(actual.shortcut, actual.echoed)
      assert.deepEqual(JSON.parse(actual.text), actual.echoed)
      assert.deepEqual(actual.bytes, [0, 128, 255, 13, 10])
      assert.equal(actual.missing, 404)
      assert.match(actual.statusError, /404/)
      assert.equal(actual.empty, 204)
      assert.equal(actual.jsonError, true)
      assert.equal(actual.loopError, true)
      assert.deepEqual(actual.methods, [
        'GET',
        'POST',
        'PUT',
        'DELETE',
        'OPTIONS',
        'CUSTOM',
      ])
      assert.deepEqual(actual.head, [200, ''])
      assert.equal(actual.fetchSame, true)
      assert.equal(actual.selfFetch, 200)
      assert.equal(actual.deprecated, 'GET')
      assert.equal(actual.secure.method, 'PUT')
      assert.deepEqual(actual.secure.bytes, [...Buffer.from('héllo✓')])
      assert.equal(actual.secure.headers['content-type'], 'text/plain')
    },
  )

  await t.test(
    'moment is same real function globally, sets user locale, and switches locales synchronously',
    async () => {
      assert.deepEqual(
        await page.evaluate(() => {
          const m = window.__apiParity.moment
          return [
            typeof m,
            m === window.moment,
            m.utc('2024-02-29').add(1, 'year').format('YYYY-MM-DD'),
            m.duration(90, 'minutes').asHours(),
            m.locale('fr'),
            m('2024-01-01').format('MMMM'),
            m.locale('ja'),
            m('2024-01-01').format('MMMM'),
          ]
        }),
        ['function', true, '2025-02-28', 1.5, 'fr', 'janvier', 'ja', '1月'],
      )
    },
  )

  await t.test(
    'plugin links and OS hibi scheme reach registered action without launching Obsidian',
    async () => {
      assert.equal(
        await page.evaluate(() => window.__apiParity.protocolError),
        undefined,
      )
      assert.equal(
        await page
          .getByText('Unsafe protocol', { exact: true })
          .getAttribute('href'),
        null,
      )
      assert.equal(
        await page
          .getByText('No styles', { exact: true })
          .getAttribute('style'),
        null,
      )
      await page
        .getByRole('link', { name: 'Fixture protocol', exact: true })
        .click()
      await page.waitForFunction(() => window.__apiParity.seen.length === 1)
      await page
        .getByRole('link', { name: 'Rendered protocol', exact: true })
        .click()
      await page.waitForFunction(() => window.__apiParity.seen.length === 2)
      await page
        .getByRole('link', { name: 'Hibi protocol', exact: true })
        .click()
      await page.waitForFunction(() => window.__apiParity.seen.length === 3)
      await page.evaluate(async () => {
        await window.hibi.openDocumentLink(
          'obsidian://parity-fixture?from=source',
          (await window.hibi.getDocument()).revision,
        )
      })
      await page.waitForFunction(() => window.__apiParity.seen.length === 4)
      await app.evaluate(({ app }) => {
        app.emit(
          'open-url',
          { preventDefault() {} },
          'hibi://obsidian/parity-fixture?from=os&title=a%20b',
        )
      })
      await page.waitForFunction(() => window.__apiParity.seen.length === 5)
      assert.deepEqual(
        await page.evaluate(() =>
          window.__apiParity.seen.map((p) => ({ ...p })),
        ),
        [
          { from: 'plugin', flag: 'true', action: 'parity-fixture' },
          { from: 'markdown', action: 'parity-fixture' },
          { from: 'hibi', action: 'parity-fixture' },
          { from: 'source', action: 'parity-fixture' },
          { from: 'os', title: 'a b', action: 'parity-fixture' },
        ],
      )
    },
  )

  if (await page.evaluate(() => window.__apiParity.networkPassed)) {
    await page.evaluate((base) => {
      window.__apiParity.pending = window.__apiParity
        .requestUrl(base + '/hang')
        .then(
          () => 'resolved',
          (error) => error.message,
        )
    }, base)
    await started
    await enabled.click()
    await disconnected
    assert.match(
      await page.evaluate(() => window.__apiParity.pending),
      /unloaded|cancel|abort/i,
    )
    const before = hits.length
    assert.equal(
      await page.evaluate(async (base) => {
        try {
          await window.__apiParity.requestUrl(base + '/echo')
          return 'sent'
        } catch {
          return 'refused'
        }
      }, base),
      'refused',
    )
    assert.equal(hits.length, before)
    assert.equal(await page.locator('#parity-links').count(), 0)
    assert.equal(await page.evaluate(() => typeof window.moment), 'undefined')
  }
})
