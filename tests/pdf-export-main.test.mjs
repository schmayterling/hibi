import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'

const source = stripTypeScriptTypes(
  await readFile(new URL('../src/main/pdf-export.ts', import.meta.url), 'utf8'),
)
  .replace(/^import[\s\S]*?from '[^']+'\n/gm, '')
  .replace(/^export /gm, '')

/** The app's image transport, which the print page's images must use. */
const manualFetch = async () => {
  throw new Error('The test fetched over the network.')
}

function runtime(options = {}) {
  const state = { windows: [], writes: [], reads: [], handlers: {}, images: [] }
  const partition = new EventEmitter()
  partition.protocol = {
    handle: (scheme, handler) => {
      state.handlers[scheme] = handler
    },
    unhandle: (scheme) => {
      delete state.handlers[scheme]
    },
  }
  partition.webRequest = {
    onBeforeRequest: (handler) => {
      state.request = handler
    },
  }
  partition.setPermissionCheckHandler = (handler) => {
    state.check = handler
  }
  partition.setPermissionRequestHandler = (handler) => {
    state.permission = handler
  }
  partition.closeAllConnections = async () => {
    state.connectionsClosed = true
  }
  class Window extends EventEmitter {
    constructor(settings) {
      super()
      if (options.constructError) throw new Error('window failed')
      this.settings = settings
      this.webContents = new EventEmitter()
      this.webContents.setWindowOpenHandler = (handler) => {
        state.open = handler
      }
      this.webContents.executeJavaScript = async () => {
        state.scripts = true
      }
      this.webContents.printToPDF = async (settings) => {
        state.printSettings = settings
        await options.print?.(this, state)
        return Buffer.from('%PDF-1.7')
      }
      this.loadURL = async (url) => {
        state.url = url
        await options.load?.(this, state)
      }
      this.isDestroyed = () => Boolean(this.destroyed)
      this.destroy = () => {
        this.destroyed = true
        this.webContents.emit('destroyed')
      }
      state.windows.push(this)
    }
  }
  const document = {
    id: 'garden',
    tabId: 'tab',
    name: 'garden.md',
    revision: 1,
    markdown: '![pixel](pixel.png)',
  }
  const app = new EventEmitter()
  app.getLocaleCountryCode = () => 'PH'
  app.getPath = (name) => `/app/${name}`
  const owner = new EventEmitter()
  const bindings = {
    randomUUID: () => 'print-page',
    realpath: async (path) => path,
    dirname,
    join,
    app,
    BrowserWindow: Window,
    dialog: {
      showSaveDialog: async () =>
        options.dialog ?? { filePath: '/notes/garden.pdf' },
    },
    session: {
      fromPartition: (name, settings) => {
        assert.equal(name, 'hibi-print')
        assert.equal(settings.cache, false)
        return partition
      },
    },
    PRINT_CSP:
      "default-src 'none'; img-src data: https:; font-src data:; style-src 'unsafe-inline'",
    printPageSize: () => 'Letter',
    getDocument: () => document,
    getDocumentPath: () => '/notes/garden.md',
    getDocumentPathForTab: () => '/notes/garden.md',
    getDocumentTabs: () => [{ ...document, id: 'tab' }],
    hasOpenDocumentPath: (path) => path === '/notes/garden.md',
    runFileDialog: (run) => run(),
    writeText: async (path, bytes) => {
      if (options.writeError) throw new Error('write failed')
      state.writes.push({ path, bytes })
    },
    imageSources: () => new Set(['pixel.png']),
    manualFetch,
    remoteImageResponse: async (...request) => {
      state.images.push(request)
      return new Response('cached pixel')
    },
    documentMediaPath: (source) => decodeURIComponent(source),
    readDocumentImage: async (path) => {
      state.reads.push(path)
      return 'data:image/png;base64,pixel'
    },
    workspaceRoot: () => '/notes',
  }
  const api = new Function(
    ...Object.keys(bindings),
    `${source}\nreturn { exportPdf, readPdfImage: typeof readPdfImage === 'function' ? readPdfImage : undefined }`,
  )(...Object.values(bindings))
  return { api, owner, app, partition, state }
}

test('print window disables scripts and releases its private page after success', async () => {
  const { api, owner, state, partition } = runtime({
    print: async (window, state) => {
      assert.equal(window.settings.webPreferences.sandbox, true)
      assert.equal(window.settings.webPreferences.nodeIntegration, false)
      assert.equal(window.settings.webPreferences.contextIsolation, true)
      assert.equal(window.settings.webPreferences.javascript, false)
      assert.equal(state.scripts, undefined)
      assert.deepEqual(state.open(), { action: 'deny' })
      assert.equal(state.check(), false)
      state.permission(null, 'camera', (allowed) =>
        assert.equal(allowed, false),
      )
      for (const details of [
        { url: 'https://example.com/pixel.png', resourceType: 'stylesheet' },
        { url: 'http://example.com/pixel.png', resourceType: 'image' },
        { url: 'file:///private/secret', resourceType: 'image' },
        { url: 'hibi-print://other/', resourceType: 'mainFrame' },
      ]) {
        state.request(details, ({ cancel }) => assert.equal(cancel, true))
      }
      for (const details of [
        { url: state.url, resourceType: 'mainFrame' },
        { url: 'https://example.com/pixel.png', resourceType: 'image' },
      ])
        state.request(details, ({ cancel }) => assert.equal(cancel, false))
      // Remote images come from the exported note's image cache.
      const image = await state.handlers.https({
        url: 'https://example.com/pixel.png',
      })
      assert.equal(await image.text(), 'cached pixel')
      assert.deepEqual(state.images, [
        [
          'https://example.com/pixel.png',
          {
            note: '/notes/garden.md',
            workspace: '/notes',
            data: '/app/userData',
          },
          manualFetch,
        ],
      ])
      const page = await state.handlers['hibi-print']({ url: state.url })
      assert.equal(await page.text(), '<h1>garden</h1>')
      assert.match(
        page.headers.get('Content-Security-Policy'),
        /default-src 'none'/,
      )
      const download = {
        preventDefault() {
          this.prevented = true
        },
      }
      partition.emit('will-download', download)
      assert.equal(download.prevented, true)
    },
  })
  assert.equal(
    await api.exportPdf(owner, 'tab', '<h1>garden</h1>'),
    '/notes/garden.pdf',
  )
  assert.equal(state.windows[0].destroyed, true)
  assert.deepEqual(state.handlers, {})
  assert.equal(state.connectionsClosed, true)
  assert.equal(state.request, null)
  assert.equal(state.check, null)
  assert.equal(state.permission, null)
  assert.equal(owner.listenerCount('close'), 0)
  assert.equal(partition.listenerCount('will-download'), 0)
  assert.equal(state.writes.length, 1)
  assert.equal(state.writes[0].bytes.toString(), '%PDF-1.7')
})

test('a remote image that never arrives stops the page load after 15 seconds and still prints', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let loading
  const parsed = new Promise((resolve) => {
    loading = resolve
  })
  let stops = 0
  const { api, owner, state } = runtime({
    load: (window) =>
      new Promise((_resolve, reject) => {
        window.webContents.stop = () => {
          stops++
          reject(
            new Error("ERR_ABORTED (-3) loading 'hibi-print://print-page/'"),
          )
        }
        window.webContents.emit('dom-ready')
        loading()
      }),
  })
  let result = 'pending'
  api.exportPdf(owner, 'tab', '<img src="https://example.com/stuck.png">').then(
    (path) => {
      result = path
    },
    (error) => {
      result = error.message
    },
  )
  await parsed
  t.mock.timers.tick(14999)
  assert.equal(stops, 0)
  t.mock.timers.tick(1)
  for (let turn = 0; turn < 20 && result === 'pending'; turn++)
    await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stops, 1)
  assert.equal(result, '/notes/garden.pdf')
  assert.equal(state.writes.length, 1)
  assert.equal(state.windows[0].destroyed, true)
})

test('canceled dialog and open-document target never create a print window or write', async () => {
  for (const dialog of [{ canceled: true }, { filePath: '/notes/garden.md' }]) {
    const { api, owner, state } = runtime({ dialog })
    if (dialog.canceled)
      assert.equal(await api.exportPdf(owner, 'tab', ''), null)
    else await assert.rejects(api.exportPdf(owner, 'tab', ''), /open document/)
    assert.equal(state.windows.length, 0)
    assert.equal(state.writes.length, 0)
  }
})

for (const phase of ['construct', 'load', 'print', 'write']) {
  test(`failed ${phase} releases the page and never commits a PDF`, async () => {
    const fail = async () => {
      throw new Error(`${phase} failed`)
    }
    const { api, owner, state, partition } = runtime({
      constructError: phase === 'construct',
      writeError: phase === 'write',
      [phase]: fail,
    })
    await assert.rejects(api.exportPdf(owner, 'tab', ''), /failed/)
    assert.deepEqual(state.handlers, {})
    assert.equal(partition.listenerCount('will-download'), 0)
    assert.ok(state.windows.every((window) => window.destroyed))
    assert.equal(state.writes.length, 0)
  })
}

for (const event of ['owner-close', 'renderer-gone']) {
  test(`${event} settles an in-flight print so shutdown cannot wait forever`, async () => {
    let printing
    const started = new Promise((resolve) => {
      printing = resolve
    })
    const { api, owner, state } = runtime({
      print: async (window) => {
        printing(window)
        return new Promise(() => {})
      },
    })
    const pending = api.exportPdf(owner, 'tab', '')
    const window = await started
    if (event === 'owner-close') owner.emit('close')
    else
      window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    let timer
    const result = await Promise.race([
      pending.then(
        () => 'saved',
        () => 'canceled',
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('stuck'), 100)
      }),
    ])
    clearTimeout(timer)
    assert.equal(result, 'canceled')
    assert.deepEqual(state.handlers, {})
    assert.equal(window.destroyed, true)
    assert.equal(state.writes.length, 0)
  })
}

test('PDF images require a current note reference before touching the filesystem', async () => {
  const { api, state } = runtime()
  assert.equal(typeof api.readPdfImage, 'function')
  for (const path of [
    '/private/secret.png',
    '../secret.png',
    'file:///private/secret.png',
    'https://example.com/image.png',
  ]) {
    assert.equal(await api.readPdfImage(path, 1), null)
  }
  assert.equal(await api.readPdfImage('pixel.png', 0), null)
  assert.deepEqual(state.reads, [])
  assert.match(await api.readPdfImage('pixel.png', 1), /^data:image/)
  assert.deepEqual(state.reads, ['pixel.png'])
  assert.match(await api.readPdfImage('%70ixel.png', 1), /^data:image/)
})
