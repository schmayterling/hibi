import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut, splitTab } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'
import { openRename } from './rename.mjs'

for (const [mode, pane] of [
  ['normal', 'rich'],
  ['markdown', 'source'],
  ['side-by-side', 'rich'],
  ['side-by-side', 'source'],
]) {
  test(`app actions restore the visible ${mode} ${pane} editor`, {
    timeout: 60000,
  }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'hibi-active-editor-focus-'))
    const file = join(root, 'note.md')
    const text = 'alpha beta'
    await writeFile(file, text)
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`, file],
    })
    t.after(async () => {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      await app.close()
      await rm(root, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(7000)
    await waitForDocumentEditor(app, page)
    await page.evaluate(
      (mode) => localStorage.setItem('default-view', mode),
      mode,
    )
    await page.reload()
    await waitForDocumentEditor(app, page, {
      name: mode === 'normal' ? 'Document editor' : 'Markdown editor',
    })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    let selector =
      pane === 'source' ? '.source-pane .cm-content' : '.rich-pane .cm-content'
    await page.locator(selector).focus()
    if (pane === 'source') {
      await page.locator(selector).evaluate((element) => {
        const view = element.cmTile.root.view
        view.dispatch({ selection: { anchor: 2, head: 4 } })
      })
    }
    const focused = async (step) => {
      try {
        await waitForAsync(
          page,
          (selector) =>
            document.activeElement?.matches(selector) &&
            document.activeElement.checkVisibility({
              visibilityProperty: true,
            }),
          selector,
        )
      } catch (error) {
        const actual = await page.evaluate(() => ({
          active: document.activeElement?.outerHTML.slice(0, 350),
          panes: Array.from(document.querySelectorAll('.cm-content')).map(
            (element) => ({
              pane: element.closest('section')?.className,
              editable: element.getAttribute('contenteditable'),
              visible: element.checkVisibility({ visibilityProperty: true }),
            }),
          ),
        }))
        throw new Error(`${step}: ${JSON.stringify(actual)}`, {
          cause: error,
        })
      }
    }
    await clickMenu(app, 'Settings')
    await page.getByRole('button', { name: /^back to app$/i }).click()
    await focused('settings')
    if (pane === 'source')
      assert.equal(await page.evaluate(() => getSelection().toString()), 'ph')
    const choose = async (label) => {
      await clickMenu(app, 'Command palette')
      await page.getByRole('combobox', { name: /search commands/i }).fill(label)
      await page.getByRole('option').first().click()
      await page
        .getByRole('combobox', { name: /search commands/i })
        .waitFor({ state: 'hidden' })
    }
    await choose('Enter zen mode')
    await waitForAsync(
      page,
      () => document.querySelector('.app').dataset.zen === 'true',
    )
    await focused('zen enter')
    await page
      .getByRole('button', { name: 'Exit zen mode', exact: true })
      .click()
    await focused('zen exit')
    await clickMenu(app, 'Command palette')
    await page.keyboard.press('Escape')
    await focused('palette close')
    await pressShortcut(
      app,
      process.platform === 'darwin' ? 'Meta+f' : 'Control+f',
    )
    const find = page.getByRole('textbox', { name: 'Find in document' })
    await find.fill('beta')
    await find.press('Escape')
    await focused('find close')
    await choose('Import into workspace')
    const dialog = page.getByRole('dialog', { name: 'Import into workspace' })
    await dialog.waitFor()
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await focused('dialog close')
    const rename = await openRename(app, page)
    await rename.press('Escape')
    await focused('rename cancel')
    const name = await openRename(app, page)
    await name.fill('renamed.md')
    await name.press('Enter')
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).name === 'renamed.md',
    )
    await focused('rename commit')
    await page.keyboard.insertText('x')
    await waitForAsync(
      page,
      async (original) =>
        (await window.hibi.getDocument()).markdown !== original,
      text,
    )
    await page.keyboard.press('ControlOrMeta+z')
    await waitForAsync(
      page,
      async (original) =>
        (await window.hibi.getDocument()).markdown === original,
      text,
    )
    await clickMenu(app, 'Close tab')
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).tabs.length === 0,
    )
    selector =
      '.editor-page[data-active="true"] .cm-content[contenteditable="true"]:not([inert] *)'
    await focused('last tab close')
    await page.getByRole('button', { name: 'Dismiss this screen' }).click()
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).tabs.length === 1,
    )
    await focused('start writing')
    await page.keyboard.insertText('new note')
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).markdown === 'new note',
    )
  })
}

test(`app actions preserve the active document and editing pane after tab switches`, {
  timeout: 60000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-active-split-focus-'))
  const files = [join(root, 'left.md'), join(root, 'right.md')]
  const texts = ['left needle text', 'right needle text']
  for (let i = 0; i < files.length; i++) await writeFile(files[i], texts[i])
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`, files[0]],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('default-view', 'side-by-side'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const left = (await page.evaluate(() => window.hibi.getDocument())).tabId
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    })
  }, files[1])
  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'right.md',
  )
  const right = (await page.evaluate(() => window.hibi.getDocument())).tabId
  await page.getByRole('tab', { name: 'left.md', exact: true }).click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    left,
  )
  await splitTab(app, page, right)
  await page
    .locator('.editor-page[data-side="right"] .source-pane .cm-content')
    .waitFor()
  const choose = async (label) => {
    await clickMenu(app, 'Command palette')
    await page.getByRole('combobox', { name: /search commands/i }).fill(label)
    await page.getByRole('option').first().click()
    await page
      .getByRole('dialog', { name: 'Command palette' })
      .waitFor({ state: 'hidden' })
  }
  for (const [side, pane, id, text] of [
    ['right', 'source', right, texts[1]],
    ['left', 'rich', left, texts[0]],
    ['right', 'rich', right, texts[1]],
    ['left', 'source', left, texts[0]],
  ]) {
    await page.getByRole('tab', { name: `${side}.md`, exact: true }).click()
    await waitForAsync(
      page,
      async ({ id, side }) =>
        (await window.hibi.getDocument()).tabId === id &&
        document.querySelector('.app').getAttribute('aria-busy') === 'false' &&
        !!document.querySelector(
          `.editor-page[data-side="${side}"][data-active="true"] .editor-panes[data-source-ready="true"]`,
        ),
      { id, side },
    )
    const selector = `.editor-page[data-side="${side}"] .${pane}-pane .cm-content`
    const editor = page.locator(selector)
    await editor.focus()
    await editor.evaluate((element) => {
      element.cmTile.root.view.dispatch({ selection: { anchor: 2, head: 4 } })
    })
    const focused = () =>
      waitForAsync(
        page,
        (selector) =>
          document.activeElement === document.querySelector(selector),
        selector,
      )
    await clickMenu(app, 'Settings')
    await page.getByRole('button', { name: /^back to app$/i }).click()
    await focused()
    assert.deepEqual(
      await editor.evaluate((element) => {
        const { anchor, head } = element.cmTile.root.view.state.selection.main
        return { anchor, head }
      }),
      { anchor: 2, head: 4 },
    )
    await choose('Enter zen mode')
    await focused()
    await page
      .getByRole('button', { name: 'Exit zen mode', exact: true })
      .click()
    await focused()
    await clickMenu(app, 'Command palette')
    // A busy renderer can run typing queued behind the closing dialog
    // before CodeMirror's own selection repair; type as focus returns.
    await page.evaluate(() => {
      const dialog = document.querySelector('dialog.command-palette')
      dialog.close = function () {
        delete this.close
        this.close()
        document.execCommand('insertText', false, 'x')
      }
    })
    await page.keyboard.press('Escape')
    await focused()
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      `${text.slice(0, 2)}x${text.slice(4)}`,
    )
    await page.keyboard.press('ControlOrMeta+z')
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
  }
  // Selecting a tab need not focus its editor; restore that page's own pane.
  for (const [side, pane, id] of [
    ['right', 'rich', right],
    ['left', 'source', left],
  ]) {
    await page.getByRole('tab', { name: `${side}.md`, exact: true }).click()
    await waitForAsync(
      page,
      async (id) => (await window.hibi.getDocument()).tabId === id,
      id,
    )
    await clickMenu(app, 'Settings')
    await page.getByRole('button', { name: /^back to app$/i }).click()
    await waitForAsync(
      page,
      (selector) => document.activeElement === document.querySelector(selector),
      `.editor-page[data-side="${side}"] .${pane}-pane .cm-content`,
    )
  }
})

test('finishing a file operation preserves newer settings input focus', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-busy-focus-'))
  const file = join(root, 'note.md')
  await writeFile(file, 'alpha beta')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`, file],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.releaseFocusRename?.()
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await waitForDocumentEditor(app, page)
  await page.evaluate(() => {
    localStorage.setItem('default-view', 'markdown')
  })
  await page.reload()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.getByRole('textbox', { name: 'Markdown editor' }).focus()
  await app.evaluate(({ ipcMain }) => {
    const rename = ipcMain._invokeHandlers.get('document:rename')
    if (!rename) throw new Error('Document rename handler is unavailable.')
    const held = Promise.withResolvers()
    globalThis.releaseFocusRename = held.resolve
    ipcMain.removeHandler('document:rename')
    ipcMain.handle('document:rename', async (...args) => {
      await held.promise
      return rename(...args)
    })
  })
  const name = await openRename(app, page)
  await name.fill('renamed.md')
  await name.press('Enter')
  await waitForAsync(
    page,
    () => document.querySelector('.app').getAttribute('aria-busy') === 'true',
  )
  await clickMenu(app, 'Settings')
  const newer = page.getByRole('textbox', { name: 'Search settings' })
  await newer.fill('keep this input')
  await app.evaluate(() => globalThis.releaseFocusRename())
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'renamed.md',
  )
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
  })
  assert.equal(
    await newer.evaluate((element) => document.activeElement === element),
    true,
  )
  assert.equal(await newer.inputValue(), 'keep this input')
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await waitForAsync(
    page,
    () =>
      document.activeElement?.getAttribute('aria-label') === 'Markdown editor',
  )
})

test('settings opened while a restored version, file, tab or new note opens stay open when it finishes', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-busy-settings-'))
  const folder = join(root, 'workspace')
  await mkdir(folder)
  await writeFile(join(folder, 'one.md'), 'first note')
  await writeFile(join(folder, 'two.md'), 'second note')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.releaseHeldOpen?.()
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    })
  }, folder)
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+o`,
  )
  const tree = page.getByRole('tree', { name: /workspace files/i })
  await tree.getByRole('treeitem', { name: 'one.md', exact: true }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'one.md',
  )
  // Settings opened while an open waits on the main process outlive it.
  for (const [channel, start, name, dirty = null] of [
    [
      'history:restore',
      async () => {
        // A saved change makes a version to restore from the history dialog.
        const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
        await page
          .locator('.rich-pane .cm-content, .source-pane .cm-content')
          .first()
          .click()
        await page.keyboard.press(`${mod}+End`)
        await page.keyboard.type(' more')
        await pressShortcut(app, `${mod}+s`)
        await waitForAsync(
          page,
          async () => (await window.hibi.listVersions()).length > 0,
        )
        await pressShortcut(app, `${mod}+k`)
        await page
          .getByRole('combobox', { name: /search commands/i })
          .fill('version history')
        await page.getByRole('option').first().waitFor()
        await page.keyboard.press('Enter')
        const history = page.getByRole('dialog', { name: /^version history$/i })
        await history
          .getByRole('navigation', { name: /saved versions/i })
          .getByRole('button')
          .last()
          .click()
        await history
          .getByRole('button', { name: /restore to editor/i })
          .click()
      },
      'one.md',
      // The restored version is an unsaved change.
      true,
    ],
    [
      'workspace:open-file',
      () => tree.getByRole('treeitem', { name: 'two.md', exact: true }).click(),
      'two.md',
    ],
    [
      'document:select-tab',
      () => page.getByRole('tab', { name: 'one.md', exact: true }).click(),
      'one.md',
    ],
    ['document:new', () => clickMenu(app, 'New'), 'untitled.md'],
  ]) {
    await page.locator('.app[aria-busy="false"]').waitFor()
    await app.evaluate(({ ipcMain }, channel) => {
      const handler = ipcMain._invokeHandlers.get(channel)
      if (!handler) throw new Error(`${channel} is unavailable.`)
      const held = Promise.withResolvers()
      globalThis.releaseHeldOpen = held.resolve
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args) => {
        await held.promise
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, handler)
        return handler(...args)
      })
    }, channel)
    await start()
    await page.locator('.app[aria-busy="true"]').waitFor()
    await clickMenu(app, 'Settings')
    await app.evaluate(() => globalThis.releaseHeldOpen())
    await waitForAsync(
      page,
      async ([name, dirty]) => {
        const note = await window.hibi.getDocument()
        return note.name === name && (dirty === null || note.dirty === dirty)
      },
      [name, dirty],
    )
    await page.locator('.app[aria-busy="false"]').waitFor()
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
    })
    assert.equal(
      await page.locator('.app').getAttribute('data-screen'),
      'settings',
      `${channel} closed settings`,
    )
    await page.getByRole('button', { name: /^back to app$/i }).click()
    await page.locator('.app[data-screen="editor"]').waitFor()
  }
})
