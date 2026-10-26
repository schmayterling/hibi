import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import {
  clickMenu,
  pressShortcut,
  replaceRichText,
  splitTab,
} from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'
import { recordToasts } from './toasts.mjs'
import { uiName } from './ui.mjs'

test('typing stays available and unsaved while a save finishes', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-save-editing-'))
  const file = join(profile, 'note.md')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(profile, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine)
  page.setDefaultTimeout(7000)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, file)
  const idle = () =>
    page.waitForFunction(
      () =>
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
    )
  // Main writes the file before it replies, for example while it records
  // version history. Hold that reply and type in the meantime.
  const saveWhileTyping = async (text) => {
    await app.evaluate(({ ipcMain }) => {
      const save = ipcMain._invokeHandlers.get('document:save')
      ipcMain._invokeHandlers.set('document:save', async (...args) => {
        ipcMain._invokeHandlers.set('document:save', save)
        const released = new Promise((resolve) => {
          globalThis.releaseSave = resolve
        })
        const saved = await save(...args)
        await released
        return saved
      })
    })
    const before = (await page.evaluate(() => window.hibi.getDocument()))
      .markdown
    await pressShortcut(app, `${mod}+s`)
    await waitForAsync(
      page,
      async () => !(await window.hibi.getDocument()).dirty,
    )
    await page.keyboard.type(text)
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown.includes(text),
      text,
    )
    await app.evaluate(() => globalThis.releaseSave())
    await idle()
    // The renderer accepted the save reply and still shows the typed text as unsaved.
    const title = page.locator('.document-title')
    await title.getByText('note.md').waitFor()
    await title.getByRole('status', { name: /unsaved changes/i }).waitFor()
    const current = await page.evaluate(() => window.hibi.getDocument())
    assert.equal(current.dirty, true)
    assert.ok(current.markdown.includes(text))
    assert.equal(await readFile(file, 'utf8'), before)
    await pressShortcut(app, `${mod}+s`)
    await waitForAsync(
      page,
      async () => !(await window.hibi.getDocument()).dirty,
    )
    await idle()
    assert.equal(await readFile(file, 'utf8'), current.markdown)
  }

  await replaceRichText(
    page,
    page.getByRole('textbox', { name: /document editor/i }),
    'first',
  )
  await saveWhileTyping(' second')

  await pressShortcut(app, `${mod}+Shift+]`)
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await source.press('ControlOrMeta+End')
  await saveWhileTyping(' third')
})

test('a save leaves other split panes read-only until it finishes', {
  timeout: 45000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-save-split-'))
  const a = join(root, 'a.md')
  const b = join(root, 'b.md')
  await writeFile(a, 'original a')
  await writeFile(b, 'original b')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.releaseSave?.()
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine)
  page.setDefaultTimeout(7000)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await waitForDocumentEditor(app, page)
  const ids = {}
  for (const [name, file] of [
    ['a.md', a],
    ['b.md', b],
  ]) {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      name,
    )
    ids[name] = (await page.evaluate(() => window.hibi.getDocument())).tabId
  }
  await page.getByRole('tab', { name: 'a.md', exact: true }).click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    ids['a.md'],
  )
  await splitTab(app, page, ids['b.md'])
  const pane = (side, editable) =>
    page.locator(
      `.editor-page[data-side="${side}"] .rich-pane [aria-label="Document editor"]${editable === undefined ? '' : `[contenteditable="${editable}"]`}`,
    )
  await pane('right', true).waitFor()
  await pane('left').click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    ids['a.md'],
  )
  await pane('left', true).waitFor()
  await page.keyboard.type(' edited')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('edited'),
  )
  await app.evaluate(({ ipcMain }) => {
    const save = ipcMain._invokeHandlers.get('document:save')
    ipcMain._invokeHandlers.set('document:save', async (...args) => {
      ipcMain._invokeHandlers.set('document:save', save)
      const released = new Promise((resolve) => {
        globalThis.releaseSave = resolve
      })
      const saved = await save(...args)
      await released
      return saved
    })
  })
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  // Only the document being saved stays editable; focus cannot move to b.md yet.
  await pane('left', true).waitFor()
  await pane('right', false).waitFor()
  await pane('right').click({ force: true })
  await page.keyboard.type(' stranded')
  await app.evaluate(() => globalThis.releaseSave())
  await page.waitForFunction(
    () => document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
  )
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).tabs.every((tab) => !tab.dirty),
  )
  assert.equal(await readFile(b, 'utf8'), 'original b')
  assert.match(await readFile(a, 'utf8'), /edited/)
})

test('a save ends busy before its workspace refresh, so addon actions run', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-save-addon-'))
  const file = join(profile, 'note.md')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(profile, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.releaseWorkspace?.()
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine)
  page.setDefaultTimeout(7000)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await waitForDocumentEditor(app, page)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.locator('#addon-typst').click()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, file)
  await replaceRichText(
    page,
    page.getByRole('textbox', { name: /document editor/i }),
    'saved first',
  )
  // Hold every workspace read until released, and record whether an addon
  // action reaches main meanwhile.
  await app.evaluate(({ ipcMain }) => {
    const held = new Promise((resolve) => {
      globalThis.releaseWorkspace = resolve
    })
    globalThis.workspaceHeld = true
    globalThis.invokedWhileHeld = false
    const get = ipcMain._invokeHandlers.get('workspace:get')
    ipcMain._invokeHandlers.set('workspace:get', async (...args) => {
      await held
      return get(...args)
    })
    const invoke = ipcMain._invokeHandlers.get('addons:invoke')
    ipcMain._invokeHandlers.set('addons:invoke', (...args) => {
      if (globalThis.workspaceHeld) globalThis.invokedWhileHeld = true
      return invoke(...args)
    })
  })
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  await page.waitForFunction(
    () => document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
  )
  const stopToasts = await recordToasts(page)
  await pressShortcut(app, `${mod}+k`)
  const palette = page.getByRole('dialog', { name: /command palette/i })
  await palette.getByRole('combobox').fill('new typst document')
  await palette
    .getByRole('option')
    .filter({ has: page.getByText(uiName('New Typst document', true)) })
    .first()
    .click()
  await waitForAsync(app, () => globalThis.invokedWhileHeld)
  await app.evaluate(() => {
    globalThis.workspaceHeld = false
    globalThis.releaseWorkspace()
  })
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'untitled.typ',
  )
  assert.deepEqual(
    (await stopToasts()).filter((toast) => /still running/i.test(toast)),
    [],
  )
  assert.match(await readFile(file, 'utf8'), /saved first/)
})

for (const outcome of ['saved', 'first-fails', 'both-fail', 'clean']) {
  test(`repeated Save requests coalesce after an in-flight save: ${outcome}`, {
    timeout: 30000,
  }, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-save-follow-up-'))
    const data = join(profile, 'profile')
    const file = join(profile, 'note.md')
    await mkdir(data)
    await writeFile(join(data, 'addons.json'), '{"vim":true}')
    await writeFile(file, 'disk baseline')
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${data}`, file],
    })
    t.after(async () => {
      await app.evaluate(({ dialog }) => {
        globalThis.followSave?.release()
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      await app.close()
      await rm(profile, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    await selectFormattedEngine(app, page, t.formattedEngine)
    page.setDefaultTimeout(7000)
    await waitForDocumentEditor(app, page)
    await page.getByRole('button', { name: 'Source view', exact: true }).click()
    await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
    const source = page.getByRole('textbox', {
      name: 'Markdown editor',
      exact: true,
    })
    await page
      .getByRole('status')
      .filter({ hasText: /vim · normal/i })
      .waitFor()
    const replace = async (text) => {
      await source.pressSequentially('gg0cc')
      await page.keyboard.type(text)
      await source.press('Escape')
      await waitForAsync(
        page,
        async (text) => (await window.hibi.getDocument()).markdown === text,
        text,
      )
    }
    await replace('first snapshot')
    await page.evaluate(() => {
      window.saveCommands = 0
      window.closeRequests = 0
      window.close = () => {
        window.closeRequests++
      }
      window.hibi.onCommand((command) => {
        if (command === 'save') window.saveCommands++
      })
    })
    await app.evaluate(({ ipcMain }, outcome) => {
      const channel = 'document:save'
      const invoke = ipcMain._invokeHandlers.get(channel)
      const held = Promise.withResolvers()
      const state = {
        calls: 0,
        active: 0,
        maxActive: 0,
        entered: false,
        release: held.resolve,
      }
      globalThis.followSave = state
      ipcMain._invokeHandlers.set(channel, async (...args) => {
        const call = ++state.calls
        state.maxActive = Math.max(state.maxActive, ++state.active)
        try {
          if (call === 1) {
            const result = ['saved', 'clean'].includes(outcome)
              ? await invoke(...args)
              : null
            state.entered = true
            await held.promise
            if (['first-fails', 'both-fail'].includes(outcome))
              throw new Error('first save failed')
            return result
          }
          if (outcome === 'both-fail') throw new Error('follow-up save failed')
          return await invoke(...args)
        } finally {
          state.active--
        }
      })
    }, outcome)
    await clickMenu(app, 'Save')
    await waitForAsync(app, () => globalThis.followSave.entered)
    if (outcome !== 'clean') await replace('latest edits')
    await clickMenu(app, 'Save')
    await clickMenu(app, 'Save')
    await pressShortcut(
      app,
      `${process.platform === 'darwin' ? 'Meta' : 'Control'}+s`,
    )
    await waitForAsync(page, () => window.saveCommands === 4)
    // :wq must await the queued result, not merely the acceptance of its request.
    await source.press(':')
    const ex = page.locator('.cm-vim-panel input')
    await ex.fill('wq')
    await ex.press('Enter')
    await page.waitForFunction(
      () =>
        document.querySelector('[data-tooltip="Last Vim command"]')
          ?.textContent === ':wq',
    )
    assert.equal(await page.evaluate(() => window.closeRequests), 0)
    assert.equal(await app.evaluate(() => globalThis.followSave.calls), 1)
    assert.equal(await page.locator('.app').getAttribute('aria-busy'), 'true')
    await app.evaluate(() => globalThis.followSave.release())
    await waitForAsync(
      app,
      (_electron, clean) =>
        globalThis.followSave.calls === (clean ? 1 : 2) &&
        globalThis.followSave.active === 0,
      outcome === 'clean',
    )
    await page.waitForFunction(
      () =>
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
    )
    assert.equal(await app.evaluate(() => globalThis.followSave.maxActive), 1)
    if (outcome === 'both-fail') {
      await page
        .locator('.toast-copy')
        .filter({ hasText: 'follow-up save failed' })
        .waitFor()
      assert.equal(await page.evaluate(() => window.closeRequests), 0)
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).dirty,
        true,
      )
      assert.equal(await readFile(file, 'utf8'), 'disk baseline')
    } else {
      await waitForAsync(page, () => window.closeRequests === 1)
      await waitForAsync(
        page,
        async () => !(await window.hibi.getDocument()).dirty,
      )
      assert.equal(
        await readFile(file, 'utf8'),
        outcome === 'clean' ? 'first snapshot' : 'latest edits',
      )
    }
    assert.equal(
      await app.evaluate(() => globalThis.followSave.calls),
      outcome === 'clean' ? 1 : 2,
    )
  })
}

for (const canceled of [true, false]) {
  test(`repeated Save during an untitled save dialog does not repeat it: ${canceled ? 'cancel' : 'confirm'}`, {
    timeout: 30000,
  }, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-save-dialog-'))
    const file = join(profile, 'note.md')
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(profile, 'profile')}`],
    })
    t.after(async () => {
      await app.evaluate(({ dialog }) => {
        globalThis.saveDialog?.release()
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      await app.close()
      await rm(profile, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    await selectFormattedEngine(app, page, t.formattedEngine)
    page.setDefaultTimeout(7000)
    await waitForDocumentEditor(app, page)
    await replaceRichText(
      page,
      page.getByRole('textbox', { name: 'Document editor', exact: true }),
      'new note',
    )
    await page.evaluate(() => {
      window.saveCommands = 0
      window.hibi.onCommand((command) => {
        if (command === 'save') window.saveCommands++
      })
    })
    await app.evaluate(
      ({ dialog, ipcMain }, { file, canceled }) => {
        const held = Promise.withResolvers()
        const state = {
          dialogs: 0,
          calls: 0,
          settled: 0,
          release: held.resolve,
        }
        globalThis.saveDialog = state
        dialog.showSaveDialog = async () => {
          state.dialogs++
          await held.promise
          return { canceled, filePath: file }
        }
        const save = ipcMain._invokeHandlers.get('document:save')
        ipcMain._invokeHandlers.set('document:save', async (...args) => {
          state.calls++
          try {
            return await save(...args)
          } finally {
            state.settled++
          }
        })
      },
      { file, canceled },
    )
    await clickMenu(app, 'Save')
    await waitForAsync(app, () => globalThis.saveDialog.dialogs === 1)
    await clickMenu(app, 'Save')
    await clickMenu(app, 'Save')
    await waitForAsync(page, () => window.saveCommands === 3)
    await app.evaluate(() => globalThis.saveDialog.release())
    await waitForAsync(app, () => globalThis.saveDialog.settled >= 1)
    await page.waitForFunction(
      () =>
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
    )
    assert.deepEqual(
      await app.evaluate(() => ({
        dialogs: globalThis.saveDialog.dialogs,
        calls: globalThis.saveDialog.calls,
      })),
      { dialogs: 1, calls: 1 },
    )
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).dirty,
      canceled,
    )
    if (canceled)
      await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' })
    else assert.equal(await readFile(file, 'utf8'), 'new note')
  })
}
