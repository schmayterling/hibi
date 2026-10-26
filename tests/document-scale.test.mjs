import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { crashAndReload, electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const entry = resolve(process.env.HIBI_SCALE_ENTRY ?? '.')
const baseline = process.env.HIBI_SCALE_BASELINE === '1'
const sizes = process.env.HIBI_SCALE_MIB
  ? process.env.HIBI_SCALE_MIB.split(',').map((size) =>
      size === 'unicode' ? size : Number(size),
    )
  : [2, 8, 32, 50, 'unicode']
const makeSource = (size) => {
  if (size === 'unicode')
    return `\uFEFF# scale-start\r\n${'中😀\r\n'.repeat(Math.ceil((20 * 1024 * 1024) / 9))}`
  const unit = `${'ordinary words '.repeat(16)}\n\n`,
    length = size * 1024 * 1024
  return `# scale-start\n\n${unit.repeat(Math.ceil(length / unit.length))}`.slice(
    0,
    length,
  )
}
const live = (app, callback) =>
  app.evaluate(
    ({ BrowserWindow }, code) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        `(${code})()`,
      ),
    callback.toString(),
  )

for (const size of sizes)
  test(`${size} mib source opens, saves, recovers and closes with exact source`, {
    timeout: 120000,
  }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'hibi-document-scale-')),
      source = makeSource(size),
      file = join(root, `${size}.md`)
    await writeFile(file, source)
    if (size === 50 && !baseline) {
      const directory = join(
        root,
        'profile',
        'installed-addons',
        'scale-review',
      )
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'hibi-addon.json'),
        JSON.stringify({
          id: 'scale-review',
          name: 'Scale review',
          description: 'Source edit fixture',
          kind: 'extension',
          apiVersion: 1,
          version: '1.0.0',
          authors: [{ displayName: 'Test' }],
          entry: 'index.js',
        }),
      )
      await writeFile(
        join(directory, '.hibi-install.json'),
        JSON.stringify({
          hash: 'a'.repeat(64),
          files: ['index.js', 'hibi-addon.json'],
          source: 'local',
        }),
      )
      await writeFile(
        join(directory, 'index.js'),
        `export default sdk => ({start(context) {
        window.scaleReview = { context, sdk }
      }});`,
      )
      await writeFile(
        join(root, 'profile', 'addons.json'),
        JSON.stringify({ 'scale-review': true }),
      )
    }
    const app = await electron.launch({
      args: [entry, `--user-data-dir=${join(root, 'profile')}`],
    })
    t.after(async () => {
      await app.close().catch(() => {})
      await rm(root, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    await waitForDocumentEditor(app, page)
    await app.evaluate(({ dialog, ipcMain }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
      dialog.showMessageBox = async () => ({
        response: 0,
        checkboxChecked: false,
      })
      globalThis.scaleSaveDone = new Promise((resolve) => {
        globalThis.scaleSaved = resolve
      })
      globalThis.scaleProbe = {
        open: null,
        save: null,
        maxMessageUnits: 0,
        messages: 0,
      }
      const units = (value) => {
        if (!value || typeof value !== 'object')
          return typeof value === 'string' ? value.length : 0
        if (Array.isArray(value.chunks))
          return value.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
        if (typeof value.markdown === 'string')
          return value.markdown.length + (value.savedMarkdown?.length ?? 0)
        if (Array.isArray(value.changes))
          return value.changes.reduce(
            (sum, change) => sum + change.insert.length,
            0,
          )
        if (value.chunk) return units(value.chunk)
        if (value.document) return units(value.document)
        return value.insert?.length ?? 0
      }
      for (const [channel, invoke] of ipcMain._invokeHandlers) {
        if (
          !channel.startsWith('document:') &&
          channel !== 'bootstrap:document'
        )
          continue
        ipcMain._invokeHandlers.set(channel, async (...args) => {
          const start = performance.now(),
            probe = globalThis.scaleProbe
          probe.maxMessageUnits = Math.max(
            probe.maxMessageUnits,
            ...args.slice(1).map(units),
          )
          try {
            const value = await invoke(...args)
            probe.maxMessageUnits = Math.max(
              probe.maxMessageUnits,
              units(value),
            )
            probe.messages++
            if (channel === 'document:open')
              probe.open = { ms: performance.now() - start, name: value?.name }
            if (channel === 'document:save') {
              probe.save = { ms: performance.now() - start }
              globalThis.scaleSaved(probe.save)
            }
            return value
          } catch (error) {
            if (channel === 'document:save')
              globalThis.scaleSaved({ error: error.message })
            if (channel === 'document:open')
              probe.open = {
                ms: performance.now() - start,
                error: error.message,
              }
            throw error
          }
        })
      }
    }, file)
    await page.evaluate(() => {
      window.scaleRichUnits = 0
      const manager = document.querySelector('.tiptap').editor.markdown,
        prototype = Object.getPrototypeOf(manager),
        parse = prototype.parse
      prototype.parse = function (source) {
        window.scaleRichUnits = Math.max(window.scaleRichUnits, source.length)
        return parse.call(this, source)
      }
    })
    const started = performance.now()
    await clickMenu(app, 'Open…')
    await waitForAsync(app, () => !!globalThis.scaleProbe.open)
    const opened = await app.evaluate(() => globalThis.scaleProbe.open)
    if (opened.error) {
      t.diagnostic(
        JSON.stringify({
          mib: size,
          status: 'refused',
          openMs: performance.now() - started,
          error: opened.error,
        }),
      )
      assert.equal(baseline, true, opened.error)
      return
    }
    await page.waitForFunction((name) => {
      const active = document.querySelector(
        '[role="tab"][aria-selected="true"]',
      )
      const source = document.querySelector(
          '.cm-content[contenteditable="true"]',
        ),
        rich = document.querySelector('.tiptap[contenteditable="true"]')
      return (
        active?.textContent.includes(name) &&
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false' &&
        (source?.closest('[data-source-ready="true"]') || rich)
      )
    }, basename(file))
    const openMs = performance.now() - started
    if (!baseline) {
      assert.equal(
        await page.locator('.cm-content[contenteditable="true"]').count(),
        1,
      )
      assert.ok(
        await page.evaluate(() => window.scaleRichUnits <= 256 * 1024),
        'large opening parsed complete rich source',
      )
    }
    if (!(await page.locator('.cm-content[contenteditable="true"]').count())) {
      await page
        .getByRole('button', { name: 'Source view', exact: true })
        .click()
      await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
    }
    if (!baseline) {
      await page.evaluate(() => {
        window.scaleSourceView =
          document.querySelector('.cm-content').cmTile.root.view
      })
      await page.getByRole('button', { name: 'normal', exact: true }).click()
      const preview = page.locator('.large-markdown-preview')
      await preview.locator('.format-content').waitFor()
      assert.ok(
        (await preview.locator('.format-content').textContent()).length <= 4096,
      )
      assert.equal(
        await page.locator('.tiptap[contenteditable="true"]').count(),
        0,
      )
      await preview
        .getByRole('button', { name: 'Next part', exact: true })
        .click()
      await page.waitForFunction(
        () =>
          Number(
            document
              .querySelector('.large-markdown-preview')
              ?.getAttribute('data-preview-from'),
          ) > 0,
      )
      await preview.locator('.format-content').waitFor()
      assert.ok(
        (await preview.locator('.format-content').textContent()).length <= 4096,
      )
      await preview
        .getByRole('button', { name: 'Previous part', exact: true })
        .click()
      await page.waitForFunction(
        () =>
          document
            .querySelector('.large-markdown-preview')
            ?.getAttribute('data-preview-from') === '0',
      )
      if (size === 2) {
        await page.evaluate(() => {
          const view = window.scaleSourceView
          view.dispatch({
            changes: { from: 0, to: 1, insert: 'Q' },
            userEvent: 'input.type',
          })
          view.dispatch({
            changes: { from: 0, to: 1, insert: '#' },
            userEvent: 'input.type',
          })
          return window.hibi.flushDocumentChanges()
        })
        await preview.locator('.format-content').waitFor()
        await page.waitForFunction(() =>
          document
            .querySelector('.large-markdown-preview .format-content')
            ?.textContent.replace(/^# /, '')
            .startsWith('scale-start'),
        )
      }
      await page
        .getByRole('button', { name: 'Source view', exact: true })
        .click()
      await preview.waitFor({ state: 'detached' })
      assert.equal(
        await page.evaluate(
          () =>
            document.querySelector('.cm-content').cmTile.root.view ===
            window.scaleSourceView,
        ),
        true,
      )
      assert.ok(await page.evaluate(() => window.scaleRichUnits <= 4096))
    }
    if (size === 50 && !baseline) {
      const statuses = await page.evaluate(() => {
        const { context, sdk } = window.scaleReview
        const document = context.editor.getDocument()
        const prototype = sdk.codeMirror.state.Text.prototype
        const original = prototype.toString
        prototype.toString = function () {
          if (this.length > 4096)
            throw new Error('addon edit flattened complete native text')
          return original.call(this)
        }
        try {
          const first = context.editor.applySourceEdits({
            requestId: 'scale:first',
            tabId: document.tabId,
            revision: document.revision,
            contentVersion: document.contentVersion,
            changes: [{ from: 0, to: 1, insert: 'Q', expectedText: '#' }],
          })
          const second = context.editor.applySourceEdits({
            requestId: 'scale:restore',
            tabId: document.tabId,
            revision: document.revision,
            contentVersion: first.contentVersion,
            changes: [{ from: 0, to: 1, insert: '#', expectedText: 'Q' }],
          })
          return [first.status, second.status]
        } finally {
          prototype.toString = original
        }
      })
      assert.deepEqual(statuses, ['applied', 'applied'])
      await page.evaluate(() => window.hibi.flushDocumentChanges())
    }
    const offset = source.startsWith('\uFEFF') ? 1 : 0
    const edit = async (char) => {
      await page.evaluate(
        ({ offset, char }) => {
          const view = document.querySelector('.cm-content').cmTile.root.view
          view.dispatch({
            changes: { from: offset, to: offset + 1, insert: char },
            userEvent: 'input.type',
          })
        },
        { offset, char },
      )
      await page.evaluate(() => window.hibi.flushDocumentChanges())
    }
    await edit('Z')
    const saving = performance.now()
    await clickMenu(app, 'Save')
    const saved = await app.evaluate(() => globalThis.scaleSaveDone)
    assert.equal(saved.error, undefined)
    await page.waitForFunction(
      () =>
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
    )
    const saveMs = performance.now() - saving
    const expected = (char) =>
      `${source.slice(0, offset)}${char}${source.slice(offset + 1)}`
    assert.deepEqual(await readFile(file), Buffer.from(expected('Z')))
    await edit('Y')
    await page.evaluate(() => localStorage.setItem('default-view', 'markdown'))
    const recovering = performance.now()
    await crashAndReload(app)
    const recovered = await live(
      app,
      () =>
        new Promise((resolve) => {
          const ready = () => {
            const content = document.querySelector(
                '.cm-content[contenteditable="true"]',
              ),
              view = content?.cmTile?.root?.view
            if (
              !view ||
              !content.closest('[data-source-ready="true"]') ||
              document.querySelector('.app')?.getAttribute('aria-busy') !==
                'false'
            )
              return
            observer.disconnect()
            resolve({
              prefix: view.state.doc.sliceString(0, 32),
              length: view.state.doc.length,
            })
          }
          const observer = new MutationObserver(ready)
          observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
          })
          ready()
        }),
    )
    const recoveryMs = performance.now() - recovering
    assert.equal(recovered.length, expected('Y').replace(/\r\n?/g, '\n').length)
    assert.equal(
      recovered.prefix,
      expected('Y').replace(/\r\n?/g, '\n').slice(0, 32),
    )
    await live(app, () => {
      const view = document.querySelector('.cm-content').cmTile.root.view,
        offset = view.state.doc.sliceString(0, 1) === '\uFEFF' ? 1 : 0
      view.dispatch({
        changes: { from: offset, to: offset + 1, insert: 'X' },
        userEvent: 'input.type',
      })
    })
    const stats = await app.evaluate(() => globalThis.scaleProbe)
    if (!baseline)
      assert.ok(stats.maxMessageUnits <= 65536, JSON.stringify(stats))
    const closing = performance.now()
    // Renderer recovery can replace Playwright's page; observe the native window.
    await app.evaluate(
      ({ BrowserWindow }) =>
        new Promise((resolve) => {
          const window = BrowserWindow.getAllWindows()[0]
          window.once('closed', () => resolve())
          window.close()
        }),
    )
    const closeMs = performance.now() - closing
    assert.deepEqual(await readFile(file), Buffer.from(expected('X')))
    t.diagnostic(
      JSON.stringify({
        mib: size,
        bytes: Buffer.byteLength(source),
        openMs,
        saveMs,
        recoveryMs,
        closeMs,
        maxMessageUnits: stats.maxMessageUnits,
        messages: stats.messages,
      }),
    )
  })
