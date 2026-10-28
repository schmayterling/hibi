import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'vite'
import { electron, waitForDocumentEditor } from './electron.mjs'

test('a real worker formats a never-visited 50 mib far jump without main-thread scanning and declines unknown blocks', {
  timeout: 180000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-boundary-worker-'))
  let app, server
  t.after(async () => {
    await app?.close()
    if (server) await new Promise((done) => server.close(done))
    await rm(folder, { recursive: true, force: true })
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
  await t.test(
    'a restarted worker replaces its partial index for the same document',
    async () => {
      await page.evaluate(async () => {
        const NativeWorker = window.Worker
        const restart = { workers: 0, crashed: false, pages: [] }
        window.boundaryRestart = restart
        window.restoreBoundaryWorker = () => {
          window.Worker = NativeWorker
        }
        window.Worker = class extends NativeWorker {
          constructor(...args) {
            super(...args)
            const worker = ++restart.workers
            this.addEventListener('message', ({ data }) => {
              if (data.type === 'boundaries')
                restart.pages.push({
                  worker,
                  epoch: data.epoch,
                  version: data.version,
                  sequence: data.sequence,
                  done: data.done,
                })
            })
          }
          postMessage(message, ...args) {
            if (message.type === 'boundary-ack' && !restart.crashed) {
              restart.crashed = true
              this.dispatchEvent(
                new ErrorEvent('error', {
                  message: 'restart after the first adopted boundary page',
                  cancelable: true,
                }),
              )
              return
            }
            super.postMessage(message, ...args)
          }
        }
        await window.livePreview.mount(
          '# heading\n\nparagraph words\n\n'.repeat(80000),
          undefined,
          { worker: true },
        )
      })
      try {
        await page.waitForFunction(
          () =>
            window.livePreview.workerState.ready ||
            window.livePreview.probe.adoptionDeclined,
        )
        const result = await page.evaluate(() => ({
          restart: window.boundaryRestart,
          ...window.livePreview.workerState,
          declined: window.livePreview.probe.adoptionDeclined ?? 0,
        }))
        assert.equal(result.restart.workers, 2)
        assert.equal(result.restart.pages[0].done, false)
        const starts = result.restart.pages.filter(
          (page) => page.sequence === 0,
        )
        assert.equal(starts.length, 2)
        assert.equal(starts[0].version, starts[1].version)
        assert.notEqual(starts[0].epoch, starts[1].epoch)
        assert.equal(result.ready, true, JSON.stringify(result))
        assert.equal(result.declined, 0)
        assert.deepEqual(result.errors, [])
      } finally {
        await page.evaluate(() => window.restoreBoundaryWorker())
      }
    },
  )
  await t.test(
    'a short structural repair keeps the unchanged 52 mib suffix in the view',
    async () => {
      await page.evaluate(async () => {
        const unit = '# heading\n\nparagraph **bold** words\n\n- one\n- two\n\n'
        const body = unit.repeat(Math.ceil((52 * 1024 * 1024) / unit.length))
        const close = body.indexOf(
          'paragraph',
          Math.floor(body.length * 0.01) + 200 * 1024,
        )
        await window.livePreview.mount(
          body.slice(0, close) + 'paragraph --> text\n\n' + body.slice(close),
          undefined,
          { worker: true },
        )
      })
      await page.waitForFunction(
        () => window.livePreview.workerState.ready,
        undefined,
        { timeout: 120000 },
      )
      const before = await page.evaluate(() => {
        const preview = window.livePreview
        const view = preview.view()
        const at = view.state.doc.lineAt(
          Math.floor(view.state.doc.length * 0.01),
        ).from
        const result = {
          pages: preview.workerState.pages,
          requests: preview.workerState.requests,
        }
        preview.reset()
        preview.edit(at, at, '<!--\n')
        return result
      })
      await page.waitForFunction(
        (before) =>
          window.livePreview.workerState.pages - before.pages > 4 ||
          (!window.livePreview.settling() &&
            window.livePreview.workerState.ready),
        before,
        { timeout: 120000 },
      )
      const repaired = await page.evaluate(
        (before) => ({
          pages: window.livePreview.workerState.pages - before.pages,
          requests: window.livePreview.workerState.requests - before.requests,
          records: window.livePreview.probe.adoptedRecords,
          settling: window.livePreview.settling(),
          errors: window.livePreview.workerState.errors,
        }),
        before,
      )
      t.diagnostic(JSON.stringify({ shortRepair: repaired }))
      assert.equal(repaired.settling, false, JSON.stringify(repaired))
      assert.ok(
        repaired.requests > 0 && repaired.requests <= 4,
        JSON.stringify(repaired),
      )
      assert.ok(
        repaired.pages > 0 && repaired.pages <= 2,
        JSON.stringify(repaired),
      )
      assert.ok(
        repaired.records > 0 && repaired.records <= 256,
        JSON.stringify(repaired),
      )
      assert.deepEqual(repaired.errors, [])
      const at = await page.evaluate(() => {
        const preview = window.livePreview
        preview.reset()
        const at = preview.view().state.doc.length - 8192
        preview.scrollTo(at)
        return at
      })
      await page.waitForFunction(
        (at) =>
          [...document.querySelectorAll('.hibi-lp-heading')].some(
            (element) =>
              Math.abs(window.livePreview.view().posAtDOM(element) - at) <
              12000,
          ),
        at,
      )
      assert.equal(
        await page.evaluate(() => window.livePreview.probe.scannedUnits),
        0,
      )
    },
  )
  await t.test(
    'frontmatter activation refreshes boundaries without a text edit',
    async () => {
      await page.evaluate(async () => {
        await window.livePreview.mount(
          '---\ntitle: exact\n---\n\n' + '# heading\n\nbody\n\n'.repeat(100),
          undefined,
          { worker: true },
        )
      })
      await page.waitForFunction(() => window.livePreview.workerState.ready)
      const before = await page.evaluate(() => {
        const preview = window.livePreview
        const doc = preview.view().state.doc
        const requests = preview.workerState.requests
        const prefixBefore = preview.definitionIndex().start
        preview.setFrontmatter(true)
        return {
          requests,
          sameDoc: doc === preview.view().state.doc,
          prefixBefore,
          prefixAfter: preview.definitionIndex().start,
          bodyFrom: doc.line(5).from,
        }
      })
      await page.waitForFunction(() => window.livePreview.workerState.ready)
      const after = await page.evaluate(() => ({
        requests: window.livePreview.workerState.requests,
        errors: window.livePreview.workerState.errors,
      }))
      assert.equal(before.sameDoc, true)
      assert.equal(before.prefixBefore, 0)
      assert.equal(before.prefixAfter, before.bodyFrom)
      assert.equal(after.requests, before.requests + 1)
      assert.deepEqual(after.errors, [])
    },
  )
  await t.test(
    'properties keystrokes retain worker boundaries and a complete footnote index',
    async () => {
      await page.evaluate(async () => {
        const prefix = '---\ntitle: exact\n---\n\n'
        const unit =
          '# heading\n\nparagraph reference[^a]\n\n[^a]: definition\n\n'
        await window.livePreview.mount(
          prefix + unit.repeat(Math.ceil((8 * 1024 * 1024) / unit.length)),
          undefined,
          { worker: true, frontmatter: true, editable: true },
        )
      })
      await page.waitForFunction(
        () =>
          window.livePreview.workerState.ready &&
          window.livePreview.definitionsReady(),
        undefined,
        { timeout: 120000 },
      )
      const result = await page.evaluate(async () => {
        const preview = window.livePreview
        const before = preview.definitionIndex()
        const requests = preview.workerState.requests,
          pages = preview.workerState.pages
        const length = preview.view().state.doc.length
        preview.reset()
        preview.footnoteScan.scanned = preview.footnoteScan.parsed = 0
        for (const insert of ['x', '\nother: value', 'z']) {
          const at = preview.view().state.doc.line(2).to
          preview.edit(at, at, insert, true)
        }
        for (let i = 0; i < 3; i++)
          await new Promise((done) =>
            requestIdleCallback(done, { timeout: 200 }),
          )
        const after = preview.definitionIndex()
        return {
          requests: preview.workerState.requests - requests,
          pages: preview.workerState.pages - pages,
          scanned: preview.probe.scannedUnits,
          footnoteScanned: preview.footnoteScan.scanned,
          footnoteParsed: preview.footnoteScan.parsed,
          sameGroups: before.groups === after.groups,
          sameLabels: before.labels === after.labels,
          readDelta: after.read - before.read,
          prefixBefore: before.start,
          prefixAfter: after.start,
          lengthDelta: preview.view().state.doc.length - length,
          ready: preview.definitionsReady(),
          errors: preview.workerState.errors,
        }
      })
      t.diagnostic(JSON.stringify({ properties: result }))
      assert.equal(result.requests, 0, JSON.stringify(result))
      assert.equal(result.pages, 0, JSON.stringify(result))
      assert.equal(result.scanned, 0, JSON.stringify(result))
      assert.equal(result.footnoteScanned, 0, JSON.stringify(result))
      assert.equal(result.footnoteParsed, 0, JSON.stringify(result))
      assert.ok(result.prefixBefore > 0)
      assert.equal(result.prefixAfter - result.prefixBefore, result.lengthDelta)
      assert.equal(result.sameGroups, true)
      assert.equal(result.sameLabels, true)
      assert.equal(result.readDelta, result.lengthDelta)
      assert.equal(result.ready, true)
      assert.deepEqual(result.errors, [])
    },
  )

  await t.test(
    'foreground far-jump work stays bounded when idle prefetch precedes sampling',
    async (t) => {
      t.after(() => page.evaluate(() => window.prefetchIdle?.restore()))
      await page.evaluate(async () => {
        const request = window.requestIdleCallback
        const cancel = window.cancelIdleCallback
        const held = new Map()
        let next = 0
        // only optional parse-ahead waits; viewport continuations and worker adoption keep their timeouts.
        window.requestIdleCallback = (callback, options) => {
          if (options?.timeout !== undefined) return request(callback, options)
          held.set(--next, callback)
          return next
        }
        window.cancelIdleCallback = (id) => {
          if (!held.delete(id)) cancel(id)
        }
        window.prefetchIdle = {
          units: 0,
          slices: 0,
          run() {
            const now = performance.now
            // a quiet slice finishes its range regardless of machine speed.
            performance.now = () => 0
            try {
              for (const [id, callback] of [...held]) {
                held.delete(id)
                const before = window.livePreview.probe.parsedUnits
                callback({ didTimeout: false, timeRemaining: () => 50 })
                const units = window.livePreview.probe.parsedUnits - before
                this.units += units
                this.slices += Number(units > 0)
              }
            } finally {
              performance.now = now
            }
          },
          restore() {
            window.requestIdleCallback = request
            window.cancelIdleCallback = cancel
            const callbacks = [...held.values()]
            held.clear()
            for (const callback of callbacks)
              callback({ didTimeout: false, timeRemaining: () => 0 })
            delete window.prefetchIdle
          },
        }
        const unit = '# heading\n\nparagraph **bold** words\n\n- one\n- two\n\n'
        await window.livePreview.mount(
          unit.repeat(Math.ceil((52 * 1024 * 1024) / unit.length)),
          undefined,
          { worker: true, history: true, editable: true },
        )
      })
      await page
        .waitForFunction(
          () =>
            window.livePreview.workerState.ready ||
            window.livePreview.workerState.errors.length,
          undefined,
          { timeout: 120000 },
        )
        .catch(async (error) => {
          t.diagnostic(
            JSON.stringify(
              await page.evaluate(() => ({
                ...window.livePreview.workerState,
                ...window.livePreview.probe,
              })),
            ),
          )
          throw error
        })
      assert.deepEqual(
        await page.evaluate(() => window.livePreview.workerState.errors),
        [],
      )
      const before = await page.evaluate(() => {
        const preview = window.livePreview,
          view = preview.view()
        preview.reset()
        window.prefetchIdle.units = window.prefetchIdle.slices = 0
        const at = view.state.doc.lineAt(view.state.doc.length - 4096).from
        view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
        return { at, length: view.state.doc.length }
      })
      await page.waitForFunction(
        (at) =>
          [...document.querySelectorAll('.hibi-lp-heading')].some(
            (element) =>
              Math.abs(window.livePreview.view().posAtDOM(element) - at) <
              12000,
          ),
        before.at,
      )
      await page.waitForFunction(() => {
        const preview = window.livePreview
        preview.refresh()
        window.prefetchIdle.run()
        const { from, to } = preview.view().viewport
        return window.prefetchIdle.units > 0 && preview.covered(from, to)
      })
      const after = await page.evaluate(() => ({
        foregroundParsedUnits:
          window.livePreview.probe.parsedUnits - window.prefetchIdle.units,
        prefetchedUnits: window.prefetchIdle.units,
        prefetchSlices: window.prefetchIdle.slices,
        // sixteen chunks each way, plus context and whole-chunk alignment at both ends.
        prefetchLimit:
          Math.min(
            window.livePreview.view().state.doc.length,
            window.livePreview.view().viewport.to + 16 * 4096,
          ) -
          Math.max(0, window.livePreview.view().viewport.from - 16 * 4096) +
          4 * 4096,
        ...window.livePreview.probe,
        ...window.livePreview.workerState,
      }))
      assert.ok(after.prefetchedUnits > 0)
      assert.ok(
        after.prefetchedUnits < after.prefetchLimit,
        JSON.stringify(after),
      )
      assert.ok(after.parsedUnits > 64 * 1024, JSON.stringify(after))
      assert.ok(before.length >= 50 * 1024 * 1024)
      assert.equal(after.scannedUnits, 0, JSON.stringify(after))
      assert.ok(after.foregroundParsedUnits < 64 * 1024, JSON.stringify(after))
      assert.ok(after.maxRecords <= 128)
      assert.deepEqual(errors, [])
      t.diagnostic(
        JSON.stringify({
          length: before.length,
          mainThreadScannedUnits: after.scannedUnits,
          foregroundParsedUnits: after.foregroundParsedUnits,
          prefetchedUnits: after.prefetchedUnits,
          totalParsedUnits: after.parsedUnits,
          prefetchLimit: after.prefetchLimit,
          pages: after.pages,
        }),
      )
    },
  )

  await t.test(
    'warm edits reuse mapped boundaries without retransferring the index',
    async () => {
      const samples = []
      for (const fraction of [0.99, 0.5]) {
        const before = await page.evaluate((fraction) => {
          const preview = window.livePreview
          const at = Math.floor(preview.view().state.doc.length * fraction)
          const before = {
            at,
            length: preview.view().state.doc.length,
            pages: preview.workerState.pages,
            requests: preview.workerState.requests,
          }
          preview.reset()
          preview.edit(at, at, 'x')
          return before
        }, fraction)
        await page.waitForFunction(
          () =>
            !window.livePreview.settling() &&
            (window.livePreview.workerState.ready ||
              window.livePreview.workerState.errors.length),
          undefined,
          { timeout: 30000 },
        )
        const after = await page.evaluate((before) => {
          const preview = window.livePreview
          return {
            pages: preview.workerState.pages - before.pages,
            records: preview.probe.adoptedRecords,
            requests: preview.workerState.requests - before.requests,
            scanned: preview.probe.scannedUnits,
            length: preview.view().state.doc.length,
            inserted: preview
              .view()
              .state.doc.sliceString(before.at, before.at + 1),
            errors: preview.workerState.errors,
          }
        }, before)
        assert.equal(after.length, before.length + 1)
        assert.equal(after.inserted, 'x')
        assert.deepEqual(after.errors, [])
        samples.push(after)
      }
      t.diagnostic(JSON.stringify({ warmEdits: samples }))
      for (const sample of samples) {
        assert.equal(sample.pages, 0, JSON.stringify(sample))
        assert.equal(sample.records, 0, JSON.stringify(sample))
        assert.equal(sample.requests, 0, JSON.stringify(sample))
        assert.ok(sample.scanned <= 65536, JSON.stringify(sample))
      }
    },
  )

  await t.test(
    'typing a mid-note fence after idle edits settles without repeated adoption or scanning',
    async () => {
      const before = await page.evaluate(() => {
        const preview = window.livePreview
        const view = preview.view()
        const at = view.state.doc.lineAt(
          Math.floor(view.state.doc.length / 2),
        ).from
        view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
        preview.reset()
        const requests = preview.workerState.requests
        const pages = preview.workerState.pages
        for (const [i, character] of [...'~~~\n'].entries())
          preview.edit(at + i, at + i, character)
        return { at, requests, pages }
      })
      await page.waitForFunction(
        (before) =>
          window.livePreview.workerState.requests - before.requests > 4 ||
          (!window.livePreview.settling() &&
            window.livePreview.workerState.ready),
        before,
        { timeout: 120000 },
      )
      const counters = () =>
        page.evaluate(
          (before) => ({
            requests: window.livePreview.workerState.requests - before.requests,
            pages: window.livePreview.workerState.pages - before.pages,
            adopted: window.livePreview.probe.adoptionSlices ?? 0,
            scanned: window.livePreview.probe.scannedUnits,
            settling: window.livePreview.settling(),
            errors: window.livePreview.workerState.errors,
          }),
          before,
        )
      const settled = await counters()
      t.diagnostic(JSON.stringify({ typedFence: settled }))
      assert.equal(settled.settling, false, JSON.stringify(settled))
      assert.ok(settled.requests <= 4, JSON.stringify(settled))
      assert.ok(settled.pages <= 4, JSON.stringify(settled))
      assert.ok(settled.adopted <= 4, JSON.stringify(settled))
      assert.deepEqual(settled.errors, [])
      await page.evaluate(async () => {
        for (let i = 0; i < 3; i++)
          await new Promise((done) =>
            requestIdleCallback(done, { timeout: 200 }),
          )
      })
      // Worker timing changes cumulative scans; every counter must stop.
      assert.deepEqual(await counters(), settled)
      await page.evaluate(() => {
        for (let i = 0; i < 4; i++) window.livePreview.undo()
      })
      await page.waitForFunction(
        () =>
          !window.livePreview.settling() &&
          window.livePreview.workerState.ready,
        undefined,
        { timeout: 120000 },
      )
    },
  )

  await t.test(
    'edited indexes retain far jumps and rebuild after structural undo and redo',
    async () => {
      for (const fraction of [0.01, 0.5, 0.99]) {
        const at = await page.evaluate((fraction) => {
          const preview = window.livePreview
          const view = preview.view()
          const at = view.state.doc.lineAt(
            Math.floor(view.state.doc.length * fraction),
          ).from
          preview.reset()
          view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
          return at
        }, fraction)
        await page.waitForFunction(
          (at) =>
            [...document.querySelectorAll('.hibi-lp-heading')].some(
              (element) =>
                Math.abs(window.livePreview.view().posAtDOM(element) - at) <
                12000,
            ),
          at,
        )
        assert.equal(
          await page.evaluate(() => window.livePreview.probe.scannedUnits),
          0,
        )
      }
      const original = await page.evaluate(() => {
        const preview = window.livePreview
        const view = preview.view()
        const tail = view.state.doc.sliceString(view.state.doc.length - 300)
        const at =
          view.state.doc.length - 300 + tail.lastIndexOf('# heading') + 3
        view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
        return { at, length: view.state.doc.length }
      })
      const repairs = []
      for (const action of ['insert', 'undo', 'redo', 'undo']) {
        await page.evaluate(() => window.livePreview.reset())
        const before = await page.evaluate(
          () => window.livePreview.workerState.requests,
        )
        const fenced = action === 'insert' || action === 'redo'
        assert.equal(
          await page.evaluate((action) => {
            const preview = window.livePreview
            if (action === 'insert') {
              preview.edit(0, 0, '~~~\n')
              return true
            }
            return preview[action]()
          }, action),
          true,
        )
        await page.waitForFunction(
          () =>
            !window.livePreview.settling() &&
            window.livePreview.workerState.ready,
          undefined,
          { timeout: 120000 },
        )
        if (fenced)
          assert.ok(
            (await page.evaluate(
              () => window.livePreview.workerState.requests,
            )) > before,
            'a newly opened fence must request its invalidated boundaries',
          )
        const at = original.at + (fenced ? 4 : 0)
        await page.evaluate((at) => window.livePreview.scrollTo(at), at)
        await page.waitForFunction(
          ({ at, fenced }) => {
            let node = window.livePreview.tree().resolveInner(at)
            while (node) {
              if (node.name === (fenced ? 'FencedCode' : 'ATXHeading1'))
                return true
              node = node.parent
            }
            return false
          },
          { at, fenced },
        )
        assert.deepEqual(
          await page.evaluate(() => ({
            length: window.livePreview.view().state.doc.length,
            head: window.livePreview.view().state.selection.main.head,
            exact: window.livePreview.sourceMatchesView(),
            errors: window.livePreview.workerState.errors,
          })),
          {
            length: original.length + (fenced ? 4 : 0),
            head: at,
            exact: true,
            errors: [],
          },
        )
        repairs.push(
          await page.evaluate(
            (action) => ({
              action,
              requestedFrom: window.livePreview.workerState.ranges.at(-1),
              scanned: window.livePreview.probe.scannedUnits,
              parsed: window.livePreview.probe.parsedUnits,
              records: window.livePreview.probe.adoptedRecords,
            }),
            action,
          ),
        )
      }
      t.diagnostic(JSON.stringify({ structuralRepairs: repairs }))
    },
  )

  const unknown = await page.evaluate(async () => {
    window.removeUnknown = window.livePreview.unknownBlock()
    await window.livePreview.mount(
      '%%\n\n# heading\n\nparagraph\n\n'.repeat(4000),
      undefined,
      { worker: true },
    )
    const view = window.livePreview.view()
    const releases = window.livePreview.workerState.releases
    // Selection moves update the view without changing the syntax configuration.
    for (let at = 1; at <= 40; at++)
      view.dispatch({ selection: { anchor: at } })
    const result = {
      requests: window.livePreview.workerState.requests,
      declined: window.livePreview.probe.adoptionDeclined ?? 0,
      releases,
      repeatedReleases: window.livePreview.workerState.releases - releases,
    }
    window.livePreview.reset()
    view.dispatch({
      selection: { anchor: view.state.doc.length - 10 },
      scrollIntoView: true,
    })
    return result
  })
  assert.equal(unknown.requests, 0)
  assert.ok(unknown.declined > 0)
  assert.ok(unknown.releases > 0, JSON.stringify(unknown))
  // Each release posts a message to the worker; updates after the first have nothing to cancel.
  assert.equal(unknown.repeatedReleases, 0, JSON.stringify(unknown))
  await page.waitForFunction(() => window.livePreview.probe.scannedUnits > 0)
  await page.evaluate(() => window.removeUnknown())
  await page.waitForFunction(
    () =>
      window.livePreview.workerState.requests > 0 &&
      window.livePreview.workerState.ready,
  )
  assert.equal(
    await page.evaluate(() => window.livePreview.workerState.ranges[0]),
    0,
  )
})
