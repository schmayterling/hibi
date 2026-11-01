import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  waitForAsync,
  waitForDocumentEditor,
  waitForFormattedEditor,
} from './electron.mjs'
import {
  clickMenu,
  pressShortcut,
  redoKey,
  replaceRichText,
} from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const texts = {
  original: 'the original text of this note',
  first: 'first version of the draft, written in full.',
  second: 'second version, which undo will replace later.',
  third: 'third version, typed after undoing the second.',
}

test('the history view restores a point as a step undo takes back, and goes to an undone branch', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-history-view-'))
  const file = join(profile, 'note.md')
  await writeFile(file, texts.original)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForFormattedEditor(app, page)
  const editor = page.getByRole('textbox', { name: /document editor/i })
  const shows = (text) =>
    waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
  await pressShortcut(app, `${mod}+o`)
  await shows(texts.original)
  await page.waitForFunction(
    (text) =>
      document.querySelector('[aria-label="Document editor"]')?.textContent ===
      text,
    texts.original,
  )
  for (const text of [texts.first, texts.second]) {
    await replaceRichText(page, editor, text)
    await shows(text)
  }
  await editor.focus()
  await pressShortcut(app, `${mod}+z`)
  await shows(texts.first)
  await replaceRichText(page, editor, texts.third)
  await shows(texts.third)
  const openHistory = async () => {
    await clickMenu(app, 'Command palette')
    await page
      .getByRole('combobox', { name: /search commands/i })
      .fill('history')
    await page
      .getByRole('option')
      .filter({ hasText: /^history/i })
      .first()
      .click()
    const dialog = page.getByRole('dialog', { name: /^history$/i })
    await dialog.waitFor()
    return dialog
  }

  // Points: the text undo replaced is one, and restoring it is a new step.
  let history = await openHistory()
  const points = history.getByRole('listbox', { name: /points to return to/i })
  await points.focus()
  await page.keyboard.press('End')
  assert.equal(
    await points.getAttribute('aria-activedescendant'),
    await points.getByRole('option').last().getAttribute('id'),
  )
  await points
    .getByRole('option')
    .filter({ hasText: /before undo/i })
    .click()
  await page.waitForFunction(
    (text) =>
      document.querySelector(
        '[aria-label="changes from the current text" i] ins',
      )?.textContent === text,
    texts.second,
  )
  await history.getByRole('button', { name: /^restore$/i }).click()
  await history.waitFor({ state: 'hidden' })
  await shows(texts.second)
  await editor.focus()
  await pressShortcut(app, `${mod}+z`)
  await shows(texts.third)
  await page.keyboard.press(redoKey)
  await shows(texts.second)

  // All steps: the undone branch sits a level in, and going to it lets undo
  // and redo go on from there.
  history = await openHistory()
  await history.getByRole('button', { name: /^all steps$/i }).click()
  const tree = history.getByRole('tree', { name: /all undo steps/i })
  const items = tree.getByRole('treeitem')
  assert.equal(await items.count(), 5)
  assert.deepEqual(
    await items.evaluateAll((items) =>
      items.map((item) => [
        item.getAttribute('aria-level'),
        item.getAttribute('aria-current'),
      ]),
    ),
    [
      ['1', null],
      ['2', null],
      ['3', null],
      ['2', null],
      ['2', 'true'],
    ],
  )
  await items.nth(2).click()
  await history.getByRole('button', { name: /^go to step$/i }).click()
  await history.waitFor({ state: 'hidden' })
  await shows(texts.second)
  await editor.focus()
  await pressShortcut(app, `${mod}+z`)
  await shows(texts.first)
  await page.keyboard.press(redoKey)
  await shows(texts.second)
})

test('the history view lists every save asked for and thins autosaves, keeping one that holds a point', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-history-view-autosave-'))
  const file = join(profile, 'note.md')
  await writeFile(file, texts.original)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForFormattedEditor(app, page)
  const editor = page.getByRole('textbox', { name: /document editor/i })
  const saved = (text) =>
    waitForAsync(
      page,
      async (text) => {
        const document = await window.hibi.getDocument()
        return document.savedMarkdown === text && !document.dirty
      },
      text,
    )
  const newest = async () =>
    (await page.evaluate(() => window.hibi.listVersions()))[0]
  const flags = async () =>
    (await page.evaluate(() => window.hibi.listVersions())).map(
      ({ automatic }) => automatic ?? false,
    )
  await pressShortcut(app, `${mod}+o`)
  await waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown === text,
    texts.original,
  )
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Document editor"]')
        ?.isContentEditable,
  )
  // A save asked for keeps the text it replaced and the text it wrote.
  await replaceRichText(page, editor, texts.first)
  await pressShortcut(app, `${mod}+s`)
  await saved(texts.first)
  assert.deepEqual(await flags(), [false, false])
  await page.locator('[data-status-id="autosave"]').click()
  await page.getByRole('checkbox', { name: /^autosave$/i, exact: true }).check()
  await page.getByLabel(/^save after$/i, { exact: true }).selectOption('1000')
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await waitForDocumentEditor(app, page)
  await replaceRichText(page, editor, texts.second)
  await saved(texts.second)
  assert.deepEqual(await flags(), [true, false, false])
  // Replacing the text right after an autosave: the state before it is not a
  // point while a version holds it, so that version stays listed.
  const holding = await newest()
  const replaced = `${texts.third} ${'and a long paragraph pasted after it. '.repeat(8)}`
  await replaceRichText(page, editor, replaced)
  await saved(replaced)
  const replacing = await newest()
  // A few words typed on: that autosave holds no point, so it merges into the
  // next one when that comes less than 5 s later.
  await editor.press('ControlOrMeta+End')
  await page.keyboard.type(' more')
  await saved(`${replaced} more`)
  const merging = await newest()
  await page.keyboard.type(' words')
  await saved(`${replaced} more words`)
  const after = await newest()
  await clickMenu(app, 'Command palette')
  await page.getByRole('combobox', { name: /search commands/i }).fill('history')
  await page
    .getByRole('option')
    .filter({ hasText: /^history/i })
    .first()
    .click()
  const history = page.getByRole('dialog', { name: /^history$/i })
  await history.waitFor()
  const points = history.getByRole('listbox', { name: /points to return to/i })
  await points.getByRole('option').first().waitFor()
  const listed = new Set(
    await points
      .getByRole('option')
      .evaluateAll((options) => options.map((option) => option.id)),
  )
  const shows = (version) => listed.has(`history-version-${version.id}`)
  assert.ok(shows(holding))
  assert.equal(
    shows(merging),
    after.savedAt - merging.savedAt >= 5000,
    'an autosave holding no point merges into one less than 5 s later',
  )
  assert.ok(shows(after))
  assert.ok(replacing.savedAt > holding.savedAt)
})

test('going to a step or restoring a point shows the change in the editor, and an edit made meanwhile or a read-only editor stops them', {
  timeout: 90000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-history-view-change-'))
  // An addon that hands the test CodeMirror, to make the editor read-only.
  const addon = join(profile, 'installed-addons', 'readonly-probe')
  await mkdir(addon, { recursive: true })
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'readonly-probe',
      name: 'Readonly probe',
      description: 'Public CodeMirror readonly facets',
      kind: 'extension',
      apiVersion: 3,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      capabilities: ['source'],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['index.js', 'hibi-addon.json'],
      source: 'local',
    }),
  )
  await writeFile(
    join(addon, 'index.js'),
    'export default ({ codeMirror }) => ({ start() { window.readonlyCodeMirror = codeMirror } })',
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'readonly-probe': true }),
  )
  // A note far longer than the window, with a paragraph added at its end:
  // long enough to be a point of its own once undone.
  const original = Array.from(
    { length: 80 },
    (_, index) => `paragraph ${index}`,
  ).join('\n\n')
  const added = '\n\nthe last paragraph, added at the end'
  const edited = `${original}${added}`
  const file = join(profile, 'note.md')
  await writeFile(file, original)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForFormattedEditor(app, page)
  await page.waitForFunction(() => !!window.readonlyCodeMirror)
  const editor = page.getByRole('textbox', { name: /document editor/i })
  const markdown = () =>
    page.evaluate(async () => (await window.hibi.getDocument()).markdown)
  const shows = (text) =>
    waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
  await pressShortcut(app, `${mod}+o`)
  await shows(original)
  await page.waitForFunction(
    () => document.querySelector('.rich-pane .cm-content')?.isContentEditable,
  )
  // The test edits through the formatted view, as typing does.
  const edit = (spec) =>
    page.evaluate((spec) => {
      document
        .querySelector('.rich-pane .cm-content')
        .cmTile.root.view.dispatch(spec)
    }, spec)
  // The editor works with its caret and view at the note's top.
  const top = async () => {
    await edit({ selection: { anchor: 0 } })
    await editor.focus()
    await page.evaluate(() => {
      document.querySelector('.rich-pane').scrollTop = 0
    })
  }
  // Where the caret is and whether the view shows it, once it settles.
  const caret = async () => {
    let last = null
    for (let read = 0; read < 20; read++) {
      await page.waitForTimeout(100)
      const now = await page.evaluate(() => {
        const pane = document.querySelector('.rich-pane')
        const { view } = pane.querySelector('.cm-content').cmTile.root
        const bounds = pane.getBoundingClientRect()
        const box = view.coordsAtPos(view.state.selection.main.head)
        return {
          at: view.state.selection.main.head,
          shown:
            !!box &&
            box.top >= bounds.top - 1 &&
            box.bottom <= bounds.bottom + 1,
        }
      })
      if (now.shown && JSON.stringify(now) === JSON.stringify(last)) break
      last = now
    }
    return last
  }
  const openHistory = async () => {
    await clickMenu(app, 'Command palette')
    await page
      .getByRole('combobox', { name: /search commands/i })
      .fill('history')
    await page
      .getByRole('option')
      .filter({ hasText: /^history/i })
      .first()
      .click()
    const dialog = page.getByRole('dialog', { name: /^history$/i })
    await dialog.waitFor()
    return dialog
  }
  await edit({ selection: { anchor: original.length } })
  await edit({
    changes: { from: original.length, insert: added },
    selection: { anchor: edited.length },
    userEvent: 'input.type',
  })
  await shows(edited)

  // Going to the oldest step puts the caret where the edit was taken out, in view.
  await top()
  let history = await openHistory()
  await history.getByRole('button', { name: /^all steps$/i }).click()
  await history.getByRole('treeitem').first().click()
  await history.getByRole('button', { name: /^go to step$/i }).click()
  await history.waitFor({ state: 'hidden' })
  await shows(original)
  assert.deepEqual(await caret(), { at: original.length, shown: true })

  // Restoring the text before that undo puts the caret after it, in view.
  await top()
  history = await openHistory()
  await history
    .getByRole('option')
    .filter({ hasText: /before undo/i })
    .click()
  await history.getByRole('button', { name: /^restore$/i }).click()
  await history.waitFor({ state: 'hidden' })
  await shows(edited)
  assert.deepEqual(await caret(), { at: edited.length, shown: true })

  // An edit made while History is open: restoring then changes nothing.
  await top()
  history = await openHistory()
  await history
    .getByRole('option')
    .filter({ hasText: /oldest kept text/i })
    .click()
  await edit({ changes: { from: 0, insert: '# ' } })
  await shows(`# ${edited}`)
  await history.getByRole('button', { name: /^restore$/i }).click()
  await history
    .getByRole('alert')
    .filter({ hasText: /changed while history was open/i })
    .waitFor()
  assert.equal(await markdown(), `# ${edited}`)
  await history.getByRole('button', { name: /^cancel$/i }).click()
  await history.waitFor({ state: 'hidden' })

  // A read-only editor takes no step, as with its own undo.
  await top()
  history = await openHistory()
  await history.getByRole('button', { name: /^all steps$/i }).click()
  await history.getByRole('treeitem').first().click()
  await page.evaluate(() => {
    const { Compartment, EditorState, Prec, StateEffect } =
      window.readonlyCodeMirror.state
    const { view } = document.querySelector('.rich-pane .cm-content').cmTile
      .root
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        new Compartment().of(Prec.highest(EditorState.readOnly.of(true))),
      ),
    })
  })
  await history.getByRole('button', { name: /^go to step$/i }).click()
  await history
    .getByRole('alert')
    .filter({ hasText: /read-only/i })
    .waitFor()
  assert.equal(await markdown(), `# ${edited}`)
})

test('restoring a saved version shows the change in the editor, and one chosen while a save runs follows it', {
  timeout: 90000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-history-view-version-'))
  // A note far longer than the window, with a paragraph added at its end.
  const original = Array.from(
    { length: 80 },
    (_, index) => `paragraph ${index}`,
  ).join('\n\n')
  const edited = `${original}\n\nthe last paragraph, added at the end`
  const file = join(profile, 'note.md')
  await writeFile(file, original)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.release?.()
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForFormattedEditor(app, page)
  const editor = page.getByRole('textbox', { name: /document editor/i })
  const markdown = () =>
    page.evaluate(async () => (await window.hibi.getDocument()).markdown)
  const shows = (text) =>
    waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
  await pressShortcut(app, `${mod}+o`)
  await shows(original)
  await page.waitForFunction(
    () => document.querySelector('.rich-pane .cm-content')?.isContentEditable,
  )
  // The test edits through the formatted view, as typing does.
  const edit = (spec) =>
    page.evaluate((spec) => {
      document
        .querySelector('.rich-pane .cm-content')
        .cmTile.root.view.dispatch(spec)
    }, spec)
  // The editor works with its caret and view at the note's top.
  const top = async () => {
    await edit({ selection: { anchor: 0 } })
    await editor.focus()
    await page.evaluate(() => {
      document.querySelector('.rich-pane').scrollTop = 0
    })
  }
  // Where the caret is and whether the view shows it, once it settles.
  const caret = async () => {
    let last = null
    for (let read = 0; read < 20; read++) {
      await page.waitForTimeout(100)
      const now = await page.evaluate(() => {
        const pane = document.querySelector('.rich-pane')
        const { view } = pane.querySelector('.cm-content').cmTile.root
        const bounds = pane.getBoundingClientRect()
        const box = view.coordsAtPos(view.state.selection.main.head)
        return {
          at: view.state.selection.main.head,
          shown:
            !!box &&
            box.top >= bounds.top - 1 &&
            box.bottom <= bounds.bottom + 1,
        }
      })
      if (now.shown && JSON.stringify(now) === JSON.stringify(last)) break
      last = now
    }
    return last
  }
  // Restores a saved version of `text` from the History view.
  const restore = async (text) => {
    const [version] = (
      await Promise.all(
        (
          await page.evaluate(() => window.hibi.listVersions())
        ).map(async (version) => ({
          version,
          text: await page.evaluate(
            (id) => window.hibi.previewVersion(id),
            version.id,
          ),
        })),
      )
    ).filter((found) => found.text === text)
    const history = page.getByRole('dialog', { name: /^history$/i })
    await history.waitFor()
    await history.locator(`#history-version-${version.version.id}`).click()
    await history.getByRole('button', { name: /^restore$/i }).click()
    await history.waitFor({ state: 'hidden' })
  }
  const openHistory = async () => {
    await clickMenu(app, 'Command palette')
    await page
      .getByRole('combobox', { name: /search commands/i })
      .fill('history')
    await page
      .getByRole('option')
      .filter({ hasText: /^history/i })
      .first()
      .click()
  }
  await edit({ selection: { anchor: original.length } })
  await edit({
    changes: { from: original.length, insert: edited.slice(original.length) },
    selection: { anchor: edited.length },
    userEvent: 'input.type',
  })
  await shows(edited)
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(
    page,
    async (text) => {
      const document = await window.hibi.getDocument()
      return document.savedMarkdown === text && !document.dirty
    },
    edited,
  )

  // Restoring the text the save replaced puts the caret where the paragraph
  // was taken out, in view.
  await top()
  await openHistory()
  await restore(original)
  await shows(original)
  assert.deepEqual(await caret(), { at: original.length, shown: true })

  // History opened while a save runs, as a shortcut can: the version chosen
  // is restored once the save is done, not dropped.
  await edit({ changes: { from: 0, insert: '# ' } })
  await shows(`# ${original}`)
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const save = handlers.get('document:save')
    globalThis.held = new Promise((entered) => {
      handlers.set('document:save', async (...args) => {
        handlers.set('document:save', save)
        await new Promise((release) => {
          globalThis.release = release
          entered()
        })
        return save(...args)
      })
    })
  })
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held)
  await page.locator('.app[aria-busy="true"]').waitFor()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('app:command', 'history'),
  )
  await restore(edited)
  assert.equal(await markdown(), `# ${original}`)
  await app.evaluate(() => globalThis.release())
  await shows(edited)
})
