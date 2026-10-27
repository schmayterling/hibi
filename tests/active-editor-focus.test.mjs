import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut, splitTab } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'
import { openRename } from './rename.mjs'

for (const engine of ['tiptap', 'codemirror']) {
  for (const [mode, pane] of [
    ['normal', 'rich'],
    ['markdown', 'source'],
    ['side-by-side', 'rich'],
    ['side-by-side', 'source'],
  ]) {
    if (engine === 'tiptap' && mode === 'side-by-side' && pane === 'rich')
      continue // The legacy split preview is read-only.
    test(`${engine}: app actions restore the visible ${mode} ${pane} editor`, {
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
        ({ engine, mode }) => {
          localStorage.setItem('hibi:formatted-engine', engine)
          localStorage.setItem('default-view', mode)
        },
        { engine, mode },
      )
      await page.reload()
      await waitForDocumentEditor(app, page, {
        name: mode === 'normal' ? 'Document editor' : 'Markdown editor',
      })
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
      let selector =
        pane === 'source'
          ? '.source-pane .cm-content'
          : engine === 'codemirror'
            ? '.rich-pane .cm-content'
            : '.rich-pane .tiptap'
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
            panes: Array.from(
              document.querySelectorAll('.cm-content, .tiptap'),
            ).map((element) => ({
              pane: element.closest('section')?.className,
              editable: element.getAttribute('contenteditable'),
              visible: element.checkVisibility({ visibilityProperty: true }),
            })),
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
        await page
          .getByRole('combobox', { name: /search commands/i })
          .fill(label)
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
        '.editor-page[data-active="true"] :is(.tiptap,.cm-content)[contenteditable="true"]:not([inert] *)'
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
}

for (const engine of ['tiptap', 'codemirror']) {
  test(`${engine}: app actions preserve the active document and editing pane after tab switches`, {
    timeout: 60000,
  }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'hibi-active-split-focus-'))
    const files = [join(root, 'left.md'), join(root, 'right.md')]
    const texts = ['left needle text', 'right needle text']
    for (let i = 0; i < files.length; i++) await writeFile(files[i], texts[i])
    const app = await electron.launch({
      args: [
        resolve('.'),
        `--user-data-dir=${join(root, 'profile')}`,
        files[0],
      ],
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
    await page.evaluate((engine) => {
      localStorage.setItem('hibi:formatted-engine', engine)
      localStorage.setItem('default-view', 'side-by-side')
    }, engine)
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
    ].filter(([, pane]) => engine === 'codemirror' || pane === 'source')) {
      await page.getByRole('tab', { name: `${side}.md`, exact: true }).click()
      await waitForAsync(
        page,
        async ({ id, side }) =>
          (await window.hibi.getDocument()).tabId === id &&
          document.querySelector('.app').getAttribute('aria-busy') ===
            'false' &&
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
      await page.keyboard.press('Escape')
      await focused()
      await page.keyboard.insertText('x')
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
      ['right', engine === 'codemirror' ? 'rich' : 'source', right],
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
        (selector) =>
          document.activeElement === document.querySelector(selector),
        `.editor-page[data-side="${side}"] .${pane}-pane .cm-content`,
      )
    }
  })
}

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
    localStorage.setItem('hibi:formatted-engine', 'codemirror')
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
