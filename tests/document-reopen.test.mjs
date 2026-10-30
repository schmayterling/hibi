import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu, replaceRichText } from './keyboard.mjs'

async function setup(t) {
  await mkdir('.scratch', { recursive: true })
  const root = await mkdtemp(resolve('.scratch/reopen-'))
  const file = join(root, 'note.md')
  await writeFile(file, 'original text\n')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        globalThis.reopenGate?.releaseRead()
        globalThis.reopenGate?.releaseReply()
        globalThis.reopenGate?.restore()
        globalThis.chunkGate?.release()
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await selectFormattedEngine(app, page, t.formattedEngine)
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog, BrowserWindow }, file) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.setBackgroundThrottling(false)
    globalThis.reopenPrompts = []
    globalThis.reopenChoice = 2
    dialog.showMessageBox = async (_window, options) => {
      globalThis.reopenPrompts.push(options)
      return { response: globalThis.reopenChoice }
    }
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  const read = () => page.evaluate(() => window.hibi.getDocument())
  const idle = () =>
    page.waitForFunction(
      () =>
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
    )
  const open = async () => {
    await clickMenu(app, 'Open…')
    await idle()
  }
  const content = async (text) => {
    await page.waitForFunction((text) => {
      const editor = document.querySelector(
        '.rich-pane [aria-label="Document editor"]',
      )
      return editor?.textContent.includes(text)
    }, text.trim())
    assert.equal((await read()).markdown, text)
  }
  await open()
  await content('original text\n')
  return { app, page, file, read, idle, open, content }
}

async function gateReadAndReply(app, file) {
  await app.evaluate(async ({ ipcMain }, file) => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const target = await fs.stat(file),
      handle = await fs.open(file, 'r')
    const prototype = Object.getPrototypeOf(handle)
    await handle.close()
    const stat = prototype.stat,
      read = prototype.read
    const handles = new WeakSet()
    let enterRead, releaseRead, enterReply, releaseReply
    const reading = new Promise((resolve) => {
      enterRead = resolve
    })
    const readReady = new Promise((resolve) => {
      releaseRead = resolve
    })
    const replying = new Promise((resolve) => {
      enterReply = resolve
    })
    const replyReady = new Promise((resolve) => {
      releaseReply = resolve
    })
    let blocked = false
    prototype.stat = async function (...args) {
      const info = await stat.apply(this, args)
      if (info.dev === target.dev && info.ino === target.ino) handles.add(this)
      return info
    }
    prototype.read = async function (...args) {
      if (!blocked && handles.has(this)) {
        blocked = true
        enterRead()
        await readReady
      }
      return read.apply(this, args)
    }
    const original = ipcMain._invokeHandlers.get('document:open')
    ipcMain._invokeHandlers.set('document:open', async (...args) => {
      const result = await original(...args)
      enterReply()
      await replyReady
      return result
    })
    globalThis.reopenGate = {
      reading,
      replying,
      releaseRead,
      releaseReply,
      restore() {
        prototype.stat = stat
        prototype.read = read
        ipcMain._invokeHandlers.set('document:open', original)
      },
    }
  }, file)
}

for (const slowChunk of [false, true])
  test(`reopening publishes disk text during file and IPC delays${slowChunk ? ' with a held renderer chunk' : ''}`, {
    timeout: 60000,
  }, async (t) => {
    const { app, page, file, read, idle, content } = await setup(t)
    if (slowChunk) {
      const chunks = JSON.parse(
        await readFile('out/renderer/startup-bundle.json', 'utf8'),
      )
      const module = `src/renderer/src/${t.formattedEngine === 'tiptap' ? 'Editor' : 'FormattedEditor'}.tsx`
      const asset = chunks.find((chunk) => chunk.modules.includes(module)).file
      await app.evaluate(({ app, protocol, net }, asset) => {
        const { join } = process.getBuiltinModule('node:path')
        const { pathToFileURL } = process.getBuiltinModule('node:url')
        let enter, release
        const entered = new Promise((resolve) => {
          enter = resolve
        })
        const ready = new Promise((resolve) => {
          release = resolve
        })
        globalThis.chunkGate = { entered, release }
        protocol.unhandle('app')
        protocol.handle('app', async (request) => {
          const pathname = new URL(request.url).pathname
          if (pathname === `/${asset}`) {
            enter()
            await ready
          }
          return net.fetch(
            pathToFileURL(
              join(
                app.getAppPath(),
                'out/renderer',
                pathname === '/' ? 'index.html' : pathname,
              ),
            ).href,
          )
        })
      }, asset)
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
      await page.reload({ waitUntil: 'commit' })
      await app.evaluate(() => globalThis.chunkGate.entered)
      await page.locator('.titlebar').waitFor()
    }
    const before = await read()
    await writeFile(file, 'external replacement\n')
    await gateReadAndReply(app, file)
    await clickMenu(app, 'Open…')
    await app.evaluate(() => globalThis.reopenGate.reading)
    // This metadata read replaces the active tab's cached snapshot while fs waits.
    assert.equal((await read()).markdown, before.markdown)
    await app.evaluate(() => globalThis.reopenGate.releaseRead())
    await app.evaluate(() => globalThis.reopenGate.replying)
    const duringReply = await read()
    await app.evaluate(() => globalThis.reopenGate.releaseReply())
    await idle()
    t.diagnostic(
      JSON.stringify({
        before: before.revision,
        after: duringReply.revision,
        text: duringReply.markdown,
      }),
    )
    assert.ok(duringReply.revision > before.revision)
    assert.equal(duringReply.markdown, 'external replacement\n')
    if (slowChunk) await app.evaluate(() => globalThis.chunkGate.release())
    await content('external replacement\n')
    assert.equal((await read()).dirty, false)
    assert.equal(await app.evaluate(() => globalThis.reopenPrompts.length), 0)
    assert.equal(await readFile(file, 'utf8'), 'external replacement\n')
    // Include a late renderer turn before inspecting the installed editor again.
    await page.evaluate(() => {
      const until = performance.now() + 250
      while (performance.now() < until) {}
    })
    await content('external replacement\n')
  })

test('Open repeatedly refreshes the active document after external writes', {
  timeout: 120000,
}, async (t) => {
  const { app, page, file, read, idle, content } = await setup(t)
  let previous = await read()
  for (let index = 0; index < 20; index++) {
    const text = `external text ${index}\n`
    await writeFile(file, text)
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async (revision) => (await window.hibi.getDocument()).revision > revision,
      previous.revision,
    )
    await idle()
    await content(text)
    const next = await read()
    assert.equal(next.tabId, previous.tabId)
    assert.ok(next.revision > previous.revision)
    assert.ok(next.contentVersion > previous.contentVersion)
    assert.equal(next.dirty, false)
    previous = next
  }
  assert.equal(await app.evaluate(() => globalThis.reopenPrompts.length), 0)
})

test('following a link to a dirty tab keeps its edits without prompting', {
  timeout: 60000,
}, async (t) => {
  const { app, page, file, read, open } = await setup(t)
  const first = await read()
  await replaceRichText(
    page,
    page.locator('.rich-pane [aria-label="Document editor"]'),
    'retained draft',
  )
  await page.waitForFunction(
    async () => (await window.hibi.getDocument()).dirty,
  )
  const draft = await read()
  await writeFile(file, 'external replacement\n')
  const other = join(dirname(file), 'other.md')
  await writeFile(other, 'other note\n')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, other)
  await open()
  const current = await read()
  const retained = await page.evaluate(
    (revision) => window.hibi.openDocumentLink('note.md', revision),
    current.revision,
  )
  assert.equal(retained.tabId, first.tabId)
  assert.equal(retained.markdown, draft.markdown)
  assert.equal(retained.dirty, true)
  assert.equal(await app.evaluate(() => globalThis.reopenPrompts.length), 0)
  assert.equal(await readFile(file, 'utf8'), 'external replacement\n')
})

test('reopening a dirty document prompts before discarding external or local text', {
  timeout: 60000,
}, async (t) => {
  const { app, page, file, read, open, content } = await setup(t)
  const editor = page.locator('.rich-pane [aria-label="Document editor"]')
  await replaceRichText(page, editor, 'local draft')
  await page.waitForFunction(
    async () => (await window.hibi.getDocument()).dirty,
  )
  await writeFile(file, 'external replacement\n')
  const before = await read()
  await open()
  assert.equal(await app.evaluate(() => globalThis.reopenPrompts.length), 1)
  assert.deepEqual(await read(), before)
  await content(before.markdown)
  assert.equal(await readFile(file, 'utf8'), 'external replacement\n')
  await app.evaluate(() => {
    globalThis.reopenChoice = 1
  })
  await open()
  await content('external replacement\n')
  assert.equal((await read()).dirty, false)
  assert.equal(await app.evaluate(() => globalThis.reopenPrompts.length), 2)
  assert.equal(await readFile(file, 'utf8'), 'external replacement\n')

  await replaceRichText(page, editor, 'saved local draft')
  await page.waitForFunction(
    async () => (await window.hibi.getDocument()).dirty,
  )
  await writeFile(file, 'another external replacement\n')
  await app.evaluate(() => {
    globalThis.reopenChoice = 0
  })
  await open()
  const saved = await read()
  await content(saved.markdown)
  assert.equal(saved.markdown.trim(), 'saved local draft')
  assert.equal(saved.dirty, false)
  assert.equal(await readFile(file, 'utf8'), saved.markdown)
  assert.deepEqual(
    await app.evaluate(() =>
      globalThis.reopenPrompts.slice(2).map((prompt) => prompt.message),
    ),
    ['Save changes to note.md?', 'This file changed outside Hibi.'],
  )
})
