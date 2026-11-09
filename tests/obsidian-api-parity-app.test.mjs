import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createRawServer } from 'node:net'
import { join, resolve } from 'node:path'
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
  let app = await electron.launch({
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
  let page = await app.firstWindow()
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
  const scriptResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/main.js'),
  )
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'globalThis')
    const state = {
      descriptor,
      stolen: [],
      calls: 0,
      shadowed: false,
    }
    window.__apiShadowProbe = state
    const fake = Object.create(window)
    Object.defineProperty(fake, '__hibiObsidianHost', {
      value: {
        take(identity) {
          state.calls++
          Object.defineProperty(window, 'globalThis', descriptor)
          const bridge = window.__hibiObsidianHost.take(identity)
          return {
            ...bridge,
            activate(token) {
              state.stolen.push(token)
              bridge.activate(token)
            },
          }
        },
      },
    })
    new MutationObserver((records, observer) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (node.tagName !== 'SCRIPT' || !node.src.includes('/main.js?load='))
            continue
          observer.disconnect()
          state.shadowed = true
          Object.defineProperty(window, 'globalThis', {
            configurable: true,
            writable: true,
            value: fake,
          })
        }
    }).observe(document.head, { childList: true })
  })
  // Page code wraps every reachable IPC entry before the plugin loads.
  await page.evaluate((base) => {
    const state = { tokens: [], wrapped: [] }
    window.__apiIpcProbe = state
    window.__apiParityFirstUrl = `${base}/first-onload`
    const spy = (real) =>
      function (id, method, input) {
        if (typeof input?.capability === 'string')
          state.tokens.push(input.capability)
        return real.call(this, id, method, input)
      }
    for (const name of ['hibi', 'hibiTransport']) {
      const real = window[name].invokeAddonProfile
      const wrapped = spy(real)
      const attempts = [
        () => {
          window[name].invokeAddonProfile = wrapped
        },
        () =>
          Object.defineProperty(window[name], 'invokeAddonProfile', {
            value: wrapped,
          }),
        () =>
          Object.defineProperty(window, name, {
            value: { ...window[name], invokeAddonProfile: wrapped },
          }),
        () => {
          window[name] = { ...window[name], invokeAddonProfile: wrapped }
        },
      ]
      for (const attempt of attempts) {
        try {
          attempt()
        } catch {}
        if (window[name].invokeAddonProfile === wrapped) {
          state.wrapped.push(name)
          break
        }
      }
    }
  }, base)
  await enabled.click()
  await page.waitForFunction(
    () => window.__apiParity?.rendered && !window.__apiParity.plugin.isUnloaded,
  )
  const loadedScript = await scriptResponse
  assert.equal(loadedScript.headers()['cache-control'], 'no-store')
  const capabilityMatch = /bridge\.activate\("([a-f0-9-]{36})"\)/.exec(
    await loadedScript.text(),
  )
  assert.ok(
    capabilityMatch,
    'main must mint a capability while loading the plugin script',
  )
  const capability = capabilityMatch[1]
  await t.test(
    'shadowing globalThis cannot intercept script activation or native network authority',
    async () => {
      const result = await page.evaluate(async (base) => {
        const state = window.__apiShadowProbe
        Object.defineProperty(window, 'globalThis', state.descriptor)
        const id = (await window.hibi.queryAddon('obsidian', 'list', {})).find(
          (plugin) => plugin.enabled,
        ).manifest.id
        let direct
        if (state.stolen.length) {
          direct = (
            await window.hibi.invokeAddonProfile('obsidian', 'requestUrl', {
              id,
              capability: state.stolen.at(-1),
              requestId: crypto.randomUUID(),
              request: {
                url: base + '/shadow-theft',
                method: 'POST',
                body: 'x',
              },
            })
          ).status
        }
        return {
          calls: state.calls,
          stolen: state.stolen.length,
          shadowed: state.shadowed,
          direct,
          realStatus: (
            await window.__apiParity.requestUrl(base + '/shadow-real-plugin')
          ).status,
        }
      }, base)
      assert.equal(
        hits.includes('/shadow-theft'),
        false,
        'globalThis shadow stole native network authority',
      )
      assert.deepEqual(result, {
        calls: 0,
        stolen: 0,
        shadowed: true,
        direct: undefined,
        realStatus: 200,
      })
    },
  )
  await t.test(
    'wrapped renderer IPC methods never see a capability, and onload requests run after activation',
    async () => {
      const result = await page.evaluate(async (base) => {
        const state = window.__apiIpcProbe
        const realStatus = (
          await window.__apiParity.requestUrl(`${base}/ipc-real-plugin`)
        ).status
        const id = (await window.hibi.queryAddon('obsidian', 'list', {})).find(
          (plugin) => plugin.enabled,
        ).manifest.id
        let direct
        if (state.tokens.length)
          direct = await window.hibi
            .invokeAddonProfile('obsidian', 'requestUrl', {
              id,
              capability: state.tokens.at(-1),
              requestId: crypto.randomUUID(),
              request: { url: `${base}/ipc-theft`, method: 'POST', body: 'x' },
            })
            .then(
              (response) => response.status,
              (error) => error.message,
            )
        return {
          wrapped: state.wrapped.includes('hibi'),
          transportWrapped: state.wrapped.includes('hibiTransport'),
          tokens: state.tokens.length,
          direct,
          first: await window.__apiParity.first,
          realStatus,
        }
      }, base)
      assert.equal(
        hits.includes('/ipc-theft'),
        false,
        'wrapped IPC stole native network authority',
      )
      assert.deepEqual(result, {
        wrapped: true,
        transportWrapped: false,
        tokens: 0,
        direct: undefined,
        first: 200,
        realStatus: 200,
      })
      assert.ok(hits.includes('/first-onload'))
    },
  )
  await t.test(
    'script replays cannot replace the bridge, steal a capability or revoke the loaded plugin',
    async () => {
      const result = await page.evaluate(
        async ({ base, scriptUrl }) => {
          const descriptor = Object.getOwnPropertyDescriptor(
            globalThis,
            '__hibiObsidianHost',
          )
          let stolen
          let replaced = false
          try {
            Object.defineProperty(globalThis, '__hibiObsidianHost', {
              configurable: true,
              value: {
                take: () => ({
                  activate: (token) => {
                    stolen = token
                  },
                  require: () => ({}),
                  loaded() {},
                  failed() {},
                }),
              },
            })
            replaced = true
          } catch {}
          try {
            const bare = new URL(scriptUrl)
            bare.search = ''
            const plugins = await window.hibi.queryAddon('obsidian', 'list', {})
            const plugin = plugins.find((entry) => entry.enabled)
            const pending = await window.hibi.invokeAddonProfile(
              'obsidian',
              'preparePluginLoad',
              {
                id: plugin.manifest.id,
                hash: plugin.hash,
              },
            )
            for (const url of new Set([
              bare.href,
              scriptUrl,
              bare.href + '?load=' + crypto.randomUUID(),
              bare.href + '?load=' + pending,
            ])) {
              await new Promise((resolve) => {
                const script = document.createElement('script')
                script.src = url
                script.onload = script.onerror = resolve
                document.head.append(script)
                script.remove()
              })
            }
          } finally {
            if (replaced)
              Object.defineProperty(
                globalThis,
                '__hibiObsidianHost',
                descriptor,
              )
          }
          let stolenStatus
          if (stolen) {
            const plugins = await window.hibi.queryAddon('obsidian', 'list', {})
            const plugin = plugins.find((entry) => entry.enabled)
            try {
              stolenStatus = (
                await window.hibi.invokeAddonProfile('obsidian', 'requestUrl', {
                  id: plugin.manifest.id,
                  capability: stolen,
                  requestId: crypto.randomUUID(),
                  request: { url: base + '/review-script-theft' },
                })
              ).status
            } catch {}
          }
          const get = Map.prototype.get
          let missingLookupRejected = false
          try {
            Map.prototype.get = () => ({ activate() {} })
            missingLookupRejected =
              globalThis.__hibiObsidianHost.take('not-a-pending-load') ===
              undefined
          } finally {
            Map.prototype.get = get
          }
          return {
            replaced,
            stolen: !!stolen,
            stolenStatus,
            configurable: descriptor.configurable,
            writable: descriptor.writable,
            frozen: Object.isFrozen(descriptor.value),
            missingLookupRejected,
          }
        },
        { base, scriptUrl: loadedScript.url() },
      )
      assert.equal(
        hits.includes('/review-script-theft'),
        false,
        'renderer replay sent a native request',
      )
      assert.deepEqual(result, {
        replaced: false,
        stolen: false,
        stolenStatus: undefined,
        configurable: false,
        writable: false,
        frozen: true,
        missingLookupRejected: true,
      })
      assert.equal(
        await page.evaluate(
          async (base) =>
            (await window.__apiParity.requestUrl(base + '/live-after-replay'))
              .status,
          base,
        ),
        200,
      )
    },
  )
  await t.test(
    'renderer callers cannot borrow an enabled plugin ID for native networking',
    async () => {
      const before = hits.length
      const result = await page.evaluate(async (base) => {
        const plugins = await window.hibi.queryAddon('obsidian', 'list', {})
        const plugin = plugins.find((entry) => entry.enabled)
        const input = {
          id: plugin.manifest.id,
          requestId: crypto.randomUUID(),
          request: { url: base + '/review-bypass', method: 'POST', body: 'x' },
        }
        const errors = []
        for (const method of ['requestUrl', 'cancelRequestUrl']) {
          try {
            await window.hibi.invokeAddonProfile('obsidian', method, input)
            errors.push(null)
          } catch (error) {
            errors.push(error.message)
          }
        }
        const asset = await window.fetch(
          'app://hibi/obsidian-plugins/global/' +
            plugin.manifest.id +
            '/' +
            plugin.hash +
            '/main.js',
        )
        return { errors, assetStatus: asset.status }
      }, base)
      assert.equal(
        hits.length,
        before,
        'non-plugin renderer code sent a request',
      )
      assert.ok(result.errors.every((error) => /capability/i.test(error)))
      assert.ok(
        result.assetStatus >= 400,
        'script capabilities must not be readable through renderer fetch',
      )
    },
  )
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
          const methods = []
          for (const method of [
            'GET',
            'POST',
            'PUT',
            'DELETE',
            'OPTIONS',
            'CUSTOM',
            'custom-Verb',
          ]) {
            methods.push(
              (
                await f.requestUrl({
                  url:
                    (['CUSTOM', 'custom-Verb'].includes(method)
                      ? customBase
                      : base) + '/echo',
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
      assert.deepEqual(actual.methods, [
        'GET',
        'POST',
        'PUT',
        'DELETE',
        'OPTIONS',
        'CUSTOM',
        'CUSTOM-VERB',
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
    'redirect loops fail at their explicit bound before fixture deadline',
    async () => {
      const result = await page.evaluate(async (base) => {
        let timer
        try {
          return await Promise.race([
            window.__apiParity.requestUrl(base + '/loop').then(
              () => ({ kind: 'resolved' }),
              (error) => ({ kind: 'rejected', message: error.message }),
            ),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve({ kind: 'deadline' }), 2000)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      }, base)
      assert.equal(
        result.kind,
        'rejected',
        'redirect bound did not fire before fixture deadline',
      )
      assert.match(result.message, /redirect limit|ERR_TOO_MANY_REDIRECTS/)
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
          .getByText('Other Hibi', { exact: true })
          .getAttribute('href'),
        null,
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
    await page.evaluate(() => window.__apiParity.plugin.unload())
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
    const stale = await page.evaluate(
      async ({ base, capability }) => {
        const plugins = await window.hibi.queryAddon('obsidian', 'list', {})
        const id = plugins.find((plugin) => plugin.enabled).manifest.id
        const errors = []
        for (const method of ['requestUrl', 'cancelRequestUrl']) {
          try {
            await window.hibi.invokeAddonProfile('obsidian', method, {
              id,
              capability,
              requestId: crypto.randomUUID(),
              request: { url: base + '/stale-capability' },
            })
            errors.push(null)
          } catch (error) {
            errors.push(error.message)
          }
        }
        return errors
      },
      { base, capability },
    )
    assert.ok(
      stale.every((error) => /capability/i.test(error)),
      'a direct unload must revoke main authority while its installed plugin is still enabled',
    )
    assert.equal(hits.length, before)
    await enabled.click()
    await page.waitForFunction(() => typeof window.moment === 'undefined')
    assert.equal(await page.evaluate(() => typeof window.moment), 'undefined')
  }

  await t.test(
    'registered handlers receive cold-launch Hibi links after plugins load',
    async () => {
      await enabled.click()
      await page.waitForFunction(
        () =>
          window.__apiParity?.rendered && !window.__apiParity.plugin.isUnloaded,
      )
      assert.equal(
        await page.evaluate(
          async (base) =>
            (await window.__apiParity.requestUrl(base + '/reload-capability'))
              .status,
          base,
        ),
        200,
      )
      await app.close()
      app = await electron.launch({
        args: [
          resolve('.'),
          '--user-data-dir=' + fixture.overlay,
          'hibi://obsidian/parity-fixture?from=cold&flag&empty=',
          'obsidian://parity-fixture?from=foreign',
        ],
      })
      page = await app.firstWindow()
      page.setDefaultTimeout(8000)
      await page.waitForFunction(() => window.__apiParity?.seen.length === 1)
      assert.deepEqual(
        await page.evaluate(() =>
          window.__apiParity.seen.map((params) => ({ ...params })),
        ),
        [{ from: 'cold', flag: 'true', empty: '', action: 'parity-fixture' }],
      )
      assert.equal(
        await page.evaluate(
          async (base) =>
            (await window.__apiParity.requestUrl(base + '/cold-capability'))
              .status,
          base,
        ),
        200,
      )
    },
  )

  await t.test(
    'actual note link reaches plugin handler and preserves note bytes',
    async () => {
      const note = join(fixture.root, 'protocol-note.md')
      const source =
        'See [Note protocol](obsidian://parity-fixture?from=note) here.\n'
      await writeFile(note, source)
      await app.evaluate(({ dialog }, note) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [note],
        })
      }, note)
      await clickMenu(app, 'Open…')
      const link = page.getByRole('link', {
        name: 'Note protocol',
        exact: true,
      })
      await link.waitFor()
      await link.click({
        modifiers: ['Shift'],
      })
      await page.waitForFunction(() =>
        window.__apiParity.seen.some((params) => params.from === 'note'),
      )
      assert.equal(await readFile(note, 'utf8'), source)
    },
  )
  await t.test(
    'links clicked while addon is disabled never replay when it is enabled again',
    async () => {
      await clickMenu(app, 'Settings')
      await page
        .getByRole('tab', { name: 'Addon Manager', exact: true })
        .click()
      const host = page.getByRole('checkbox', {
        name: 'Obsidian plugins',
        exact: true,
      })
      await host.click()
      await page.waitForFunction(
        () =>
          window.__apiParity.plugin.isUnloaded &&
          typeof window.moment === 'undefined',
      )
      await app.evaluate(({ app }) => {
        app.emit(
          'open-url',
          { preventDefault() {} },
          'hibi://obsidian/parity-fixture?from=disabled',
        )
      })
      await host.click()
      await page.waitForFunction(
        () =>
          window.__apiParity?.rendered && !window.__apiParity.plugin.isUnloaded,
      )
      await app.evaluate(({ app }) => {
        app.emit(
          'open-url',
          { preventDefault() {} },
          'hibi://obsidian/parity-fixture?from=reenabled',
        )
      })
      await page.waitForFunction(() =>
        window.__apiParity.seen.some((params) => params.from === 'reenabled'),
      )
      assert.deepEqual(
        await page.evaluate(() =>
          window.__apiParity.seen.map((params) => ({ ...params })),
        ),
        [{ from: 'reenabled', action: 'parity-fixture' }],
      )
    },
  )
})
