import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'vite'
import { electron, waitForDocumentEditor } from './electron.mjs'

/** Measure the synchronous capture, including work hidden behind text iterators. */
function selectionWork({ from, to, separator = '' }) {
  const preview = window.livePreview,
    view = preview.view(),
    restore = []
  let units = 0,
    materializations = 0,
    depth = 0,
    moves = 0
  view.dispatch({ selection: { anchor: from, head: to } })
  const prototypes = new Set()
  for (let doc = view.state.doc; doc; doc = doc.children?.[0])
    for (
      let prototype = Object.getPrototypeOf(doc);
      prototype && prototype !== Object.prototype;
      prototype = Object.getPrototypeOf(prototype)
    )
      prototypes.add(prototype)
  for (const prototype of prototypes)
    for (const name of [
      'sliceString',
      'iterRange',
      'iter',
      'toString',
      'toJSON',
    ]) {
      if (!Object.hasOwn(prototype, name)) continue
      const original = prototype[name]
      prototype[name] = function (...args) {
        const outer = depth++ === 0
        let value
        try {
          value = original.apply(this, args)
        } finally {
          depth--
        }
        if (name === 'iterRange' || name === 'iter') {
          let proxy
          proxy = new Proxy(value, {
            get(target, key) {
              if (key === Symbol.iterator) return () => proxy
              if (key === 'next')
                return (...args) => {
                  const outer = depth++ === 0
                  let result
                  try {
                    result = target.next(...args)
                  } finally {
                    depth--
                  }
                  if (outer && !result.done) units += result.value.length
                  return result === target ? proxy : result
                }
              return Reflect.get(target, key, target)
            },
          })
          return proxy
        }
        if (outer) {
          units += Array.isArray(value)
            ? value.reduce((sum, line) => sum + line.length, value.length - 1)
            : value.length
          if (name === 'toString' || name === 'toJSON') materializations++
        }
        return value
      }
      restore.push(() => {
        prototype[name] = original
      })
    }
  const cursor = Object.getPrototypeOf(preview.tree().cursor())
  for (const [name, { value: original }] of Object.entries(
    Object.getOwnPropertyDescriptors(cursor),
  )) {
    if (typeof original !== 'function' || name === 'constructor') continue
    cursor[name] = function (...args) {
      moves++
      return original.apply(this, args)
    }
    restore.push(() => {
      cursor[name] = original
    })
  }
  const before = { ...preview.probe }
  let text
  try {
    text = preview.selectedText(from, to, separator)
  } finally {
    for (const reset of restore.reverse()) reset()
  }
  return {
    units,
    materializations,
    moves,
    parsedChunks: preview.probe.parsedChunks - before.parsedChunks,
    parsedUnits: preview.probe.parsedUnits - before.parsedUnits,
    scannedUnits: preview.probe.scannedUnits - before.scannedUnits,
    length: text.length,
    first: text.slice(0, 32),
    last: text.slice(-32),
  }
}

test('formatted selection previews stay bounded in 50 mib code and prose notes', {
  timeout: 240000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-selection-worker-'))
  let app, server
  t.after(async () => {
    try {
      await app?.close()
    } finally {
      if (server) {
        server.closeAllConnections()
        await new Promise((done) => server.close(done))
      }
      await rm(folder, { recursive: true, force: true })
    }
  })
  const bundle = join(folder, 'bundle')
  await build({
    configFile: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    worker: { format: 'es' },
    build: {
      outDir: bundle,
      assetsInlineLimit: 0,
      lib: {
        entry: resolve('tests/fixtures/live-preview.ts'),
        name: 'LivePreviewHarness',
        formats: ['iife'],
        fileName: () => 'harness.js',
        cssFileName: 'harness',
      },
    },
  })
  await writeFile(
    join(bundle, 'index.html'),
    '<!doctype html><html lang="en"><head><link rel="stylesheet" href="harness.css"></head><body><script src="harness.js"></script></body></html>',
  )
  server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://fixture').pathname
      const file = join(bundle, path === '/' ? 'index.html' : path)
      const type = {
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.html': 'text/html',
      }[extname(file)]
      response.writeHead(200, {
        'Content-Type': type
          ? `${type}; charset=utf-8`
          : 'application/octet-stream',
      })
      response.end(await readFile(file))
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  const main = await app.firstWindow()
  await waitForDocumentEditor(app, main)
  const next = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, port) => {
    const window = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    void window.loadURL(`http://127.0.0.1:${port}/`)
  }, server.address().port)
  const page = await next
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.waitForFunction(() => Boolean(window.livePreview))
  await page.evaluate(async () => {
    const line = 'const value = 1\n'
    await window.livePreview.mount(
      `\`\`\`js\n${line.repeat(Math.ceil((50 * 1024 * 1024) / line.length))}\`\`\`\n\nend\n`,
      { width: 800, height: 600 },
      { worker: true, editable: true },
    )
    window.codeKeywords = () =>
      [
        ...document.querySelectorAll('.hibi-lp-codeblock .hibi-token-keyword'),
      ].filter((token) => token.textContent === 'const').length
  })
  await page.waitForFunction(
    () => window.livePreview.workerState.ready,
    undefined,
    { timeout: 120000 },
  )
  await page.evaluate(() => {
    const preview = window.livePreview
    preview.scrollTo(preview.view().state.doc.length - 2048)
  })
  await page.waitForFunction(
    () =>
      window.livePreview.view().viewport.from > 40 * 1024 * 1024 &&
      window.codeKeywords() > 0 &&
      !window.livePreview.settling(),
    undefined,
    { timeout: 120000 },
  )
  const selection = await page.evaluate(() => {
    const doc = window.livePreview.view().state.doc
    return {
      at: doc.lineAt(doc.length - 2048).from,
      tail: doc.length - '```\n\nend\n'.length - 'const value = 1\n'.length,
      length: doc.length,
    }
  })
  const caret = await page.evaluate(selectionWork, {
    from: selection.at + 2,
    to: selection.at + 2,
  })
  assert.deepEqual(caret, {
    units: 0,
    materializations: 0,
    moves: 0,
    parsedChunks: 0,
    parsedUnits: 0,
    scannedUnits: 0,
    length: 0,
    first: '',
    last: '',
  })
  const interior = await page.evaluate(selectionWork, {
    from: selection.at,
    to: selection.at + 5,
  })
  assert.equal(interior.first, 'const')
  assert.equal(interior.length, 5)
  assert.ok(
    interior.units >= 5 && interior.units <= 8 * 4096,
    JSON.stringify(interior),
  )
  assert.ok(
    interior.moves > 0 && interior.moves <= 128,
    JSON.stringify(interior),
  )
  assert.equal(interior.materializations, 0)
  const tail = await page.evaluate(selectionWork, {
    from: selection.tail,
    to: selection.length,
    separator: '\n',
  })
  assert.equal(tail.first, 'const value = 1\nend')
  assert.equal(tail.length, 'const value = 1\nend'.length)
  assert.ok(
    tail.units >= tail.length && tail.units <= 8 * 4096,
    JSON.stringify(tail),
  )
  assert.ok(tail.moves > 0 && tail.moves <= 128, JSON.stringify(tail))
  assert.equal(tail.materializations, 0)
  const all = await page.evaluate(selectionWork, {
    from: 0,
    to: selection.length,
  })
  assert.equal(all.length, 256)
  assert.equal(all.first, 'const value = 1\n'.repeat(2))
  assert.equal(all.last, 'const value = 1\n'.repeat(2))
  assert.ok(
    all.units >= all.length && all.units <= 8 * 4096,
    JSON.stringify(all),
  )
  assert.ok(all.moves > 0 && all.moves <= 256, JSON.stringify(all))
  assert.ok(
    all.parsedChunks <= 8 && all.parsedUnits <= 8 * 4096,
    JSON.stringify(all),
  )
  assert.ok(all.scannedUnits <= 16 * 4096, JSON.stringify(all))
  assert.equal(all.materializations, 0)
  t.diagnostic(
    JSON.stringify({ selectionCapture: { caret, interior, tail, all } }),
  )
  await page.evaluate(async () => {
    const block = '**alpha** &amp; beta\n\n'
    await window.livePreview.mount(
      block.repeat(Math.ceil((50 * 1024 * 1024) / block.length)),
      { width: 800, height: 600 },
      { worker: true, editable: true },
    )
  })
  await page.waitForFunction(
    () =>
      window.livePreview.workerState.ready && !window.livePreview.settling(),
    undefined,
    { timeout: 120000 },
  )
  const proseLength = await page.evaluate(
    () => window.livePreview.view().state.doc.length,
  )
  assert.ok(proseLength >= 50 * 1024 * 1024)
  const prose = []
  // A menu capture and its liveness check both take the bounded preview path.
  for (let attempt = 0; attempt < 2; attempt++) {
    const work = await page.evaluate(selectionWork, {
      from: 0,
      to: proseLength,
    })
    const expected = 'alpha & beta'.repeat(40).slice(0, 256)
    assert.equal(work.length, 256)
    assert.equal(work.first, expected.slice(0, 32))
    assert.equal(work.last, expected.slice(-32))
    assert.equal(work.materializations, 0)
    assert.ok(
      work.units >= 256 && work.units <= 32 * 4096,
      JSON.stringify(work),
    )
    assert.ok(work.moves > 0 && work.moves <= 4 * 4096, JSON.stringify(work))
    assert.ok(
      work.parsedChunks <= 8 && work.parsedUnits <= 8 * 4096,
      JSON.stringify(work),
    )
    assert.ok(work.scannedUnits <= 16 * 4096, JSON.stringify(work))
    prose.push(work)
  }
  t.diagnostic(
    JSON.stringify({ prosePreview: { length: proseLength, captures: prose } }),
  )
  await page.evaluate(() =>
    window.livePreview.view().dispatch({ selection: { anchor: 0 } }),
  )
  assert.deepEqual(errors, [])
})
