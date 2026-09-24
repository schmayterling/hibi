import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { crashAndReload, electron, stopElectronTree } from './electron.mjs'

test('journal barriers preserve immediate saves, retries, renderer recovery, and native close', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-journal-'))
  const file = join(profile, 'note.md')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const editor = () =>
    page.getByRole('textbox', { name: 'Document editor', exact: true })
  await editor().waitFor()
  await app.evaluate(({ dialog, ipcMain }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    dialog.showMessageBox = async () => ({ response: 0 })
    const append = ipcMain._invokeHandlers.get('document:append')
    ipcMain.removeHandler('document:append')
    ipcMain.handle('document:append', async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 80))
      const result = await append(...args)
      if (!globalThis.lostJournalAck) {
        globalThis.lostJournalAck = true
        throw new Error('Simulated lost acknowledgment')
      }
      return result
    })
  }, file)
  await editor().fill('first edit 😀')
  const saved = await page.evaluate(() => window.hibi.saveDocument(true))
  assert.equal(saved.markdown, 'first edit 😀')
  assert.equal(saved.contentVersion, 1)
  assert.equal(await readFile(file, 'utf8'), saved.markdown)
  await editor().fill('recover this unsaved change')
  await page.evaluate(() => window.hibi.flushDocumentChanges())
  await crashAndReload(app)
  // Playwright keeps crashed targets marked as crashed after Electron reloads them.
  // Inspect the replacement renderer through Electron's live webContents instead.
  const recovered = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`
    new Promise(resolve => {
      const ready = () => {
        const element = document.querySelector('.tiptap[contenteditable="true"]');
        if (!element) { setTimeout(ready, 20); return; }
        resolve({ text: element.textContent });
      }; ready();
    })
  `),
  )
  assert.equal(recovered.text, 'recover this unsaved change')
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`
    document.querySelector('.tiptap').editor.commands.setContent('native close must keep this final edit', { contentType: 'markdown' })
  `),
  )
  const closed = new Promise((resolve) => page.once('close', resolve))
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  )
  await closed
  assert.equal(
    await readFile(file, 'utf8'),
    'native close must keep this final edit',
  )
})

test('J07/J09: native receipt recovery and saturated rich input preserve exact accepted text', {
  timeout: 65000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-journal-pressure-')),
    file = join(profile, 'note.md')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  let stage = 'startup'
  const watchdog = setTimeout(() => {
    console.error(`journal pressure test stalled during ${stage}`)
    stopElectronTree(app.process())
  }, 55000)
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
        if (globalThis.pressureFixture) {
          globalThis.pressureFixture.block = false
          for (const resolve of globalThis.pressureFixture.waiting) resolve()
          globalThis.pressureFixture.waiting = []
        }
      })
      .catch(() => {})
    await app.close().catch(() => {})
    clearTimeout(watchdog)
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .waitFor()
  await app.evaluate(({ dialog, ipcMain }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    const append = ipcMain._invokeHandlers.get('document:append'),
      verify = ipcMain._invokeHandlers.get('document:verify-checkpoint')
    globalThis.pressureFixture = { verifications: 0, block: false, waiting: [] }
    ipcMain.removeHandler('document:append')
    ipcMain.handle('document:append', async (...args) => {
      if (globalThis.pressureFixture.block)
        await new Promise((resolve) =>
          globalThis.pressureFixture.waiting.push(resolve),
        )
      const ack = await append(...args)
      if (args[1].contentVersion === 1) throw new Error('Lost oldest receipt')
      return ack
    })
    ipcMain.removeHandler('document:verify-checkpoint')
    ipcMain.handle('document:verify-checkpoint', (...args) => {
      globalThis.pressureFixture.verifications++
      return verify(...args)
    })
  }, file)
  stage = 'receipt horizon'
  const recovered = await page.evaluate(async () => {
    const editor = document.querySelector('.tiptap').editor
    for (let n = 0; n < 140; n++) editor.commands.insertContent('x')
    await window.hibi.flushDocumentChanges()
    const saved = await window.hibi.saveDocument(true)
    return { saved, recovery: window.hibi.getDocumentRecoveryState() }
  })
  assert.equal(recovered.saved.contentVersion, 140)
  assert.equal(recovered.saved.markdown, 'x'.repeat(140))
  assert.equal(recovered.recovery.pendingCount, 0)
  assert.ok(
    await app.evaluate(() => globalThis.pressureFixture.verifications > 0),
  )
  assert.equal(await readFile(file, 'utf8'), recovered.saved.markdown)

  stage = 'saturation'
  await app.evaluate(() => {
    globalThis.pressureFixture.block = true
  })
  const pressure = await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor
    let observed = 0
    editor.on('beforeTransaction', ({ nextState }) => {
      if (!nextState.doc.eq(editor.state.doc)) observed++
    })
    for (let n = 0; n < 12; n++)
      editor.commands.setContent((n % 2 ? 'A' : 'B').repeat(240000), {
        contentType: 'markdown',
      })
    return {
      observed,
      text: editor.state.doc.textContent,
      recovery: window.hibi.getDocumentRecoveryState(),
    }
  })
  assert.ok(pressure.observed > 0 && pressure.observed < 12)
  assert.match(pressure.recovery.status, /pending|failed/)
  assert.equal(pressure.recovery.pendingCount, pressure.observed)
  assert.ok(pressure.recovery.pendingBytes < 8 * 1024 * 1024)
  assert.ok(pressure.recovery.inFlightBytes < 8 * 1024 * 1024)
  assert.equal(pressure.text.length, 240000)
  await page
    .getByText(/Document recovery is full/)
    .first()
    .waitFor()
  stage = 'drain and save'
  await app.evaluate(() => {
    globalThis.pressureFixture.block = false
    for (const resolve of globalThis.pressureFixture.waiting) resolve()
    globalThis.pressureFixture.waiting = []
  })
  const saved = await page.evaluate(async () => {
    await window.hibi.flushDocumentChanges()
    return window.hibi.saveDocument(false)
  })
  assert.equal(saved.markdown, pressure.text)
  assert.equal(saved.contentVersion, 140 + pressure.observed)
  assert.equal(await readFile(file, 'utf8'), pressure.text)
  const resumed = await page.evaluate(async () => {
    const editor = document.querySelector('.tiptap').editor
    editor.commands.insertContent('z')
    await window.hibi.flushDocumentChanges()
    return {
      text: editor.state.doc.textContent,
      saved: await window.hibi.saveDocument(false),
    }
  })
  assert.equal(resumed.saved.markdown, resumed.text)
  assert.equal(resumed.saved.contentVersion, saved.contentVersion + 1)
})
