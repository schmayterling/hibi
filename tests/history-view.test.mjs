import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  autosaveOff,
  electron,
  openInDocumentEditor,
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

// An addon that hands the test CodeMirror, to make the editor read-only.
async function installReadonlyProbe(profile) {
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
  const openHistory = async (search = 'history') => {
    await clickMenu(app, 'Command palette')
    await page.getByRole('combobox', { name: /search commands/i }).fill(search)
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
  // and redo go on from there. The palette finds History as "version" too.
  history = await openHistory('version')
  await history.getByRole('button', { name: /^all steps$/i }).click()
  const tree = history.getByRole('tree', { name: /all undo steps/i })
  const items = tree.getByRole('treeitem')
  assert.equal(await items.count(), 5)
  // Items holding others say they are expanded, as they always are.
  assert.deepEqual(
    await items.evaluateAll((items) =>
      items.map((item) => [
        item.getAttribute('aria-level'),
        item.getAttribute('aria-current'),
        item.getAttribute('aria-expanded'),
      ]),
    ),
    [
      ['1', null, 'true'],
      ['2', null, 'true'],
      ['3', null, null],
      ['2', null, null],
      ['2', 'true', null],
    ],
  )
  // Left goes to the item holding this one, Right to the first it holds.
  const active = async (index) =>
    (await tree.getAttribute('aria-activedescendant')) ===
    (await items.nth(index).getAttribute('id'))
  await items.nth(3).click()
  for (const [key, to] of [
    ['ArrowLeft', 0],
    ['ArrowRight', 1],
    ['ArrowRight', 2],
    ['ArrowLeft', 1],
  ]) {
    await page.keyboard.press(key)
    assert.ok(await active(to), `${key} to item ${to}`)
  }
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
  await openInDocumentEditor(app, page, async () => {
    await pressShortcut(app, `${mod}+o`)
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      texts.original,
    )
  })
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
  // A few words typed on, then more without a pause, for longer than 5 s:
  // that autosave holds no point, and the next comes less than 3 minutes
  // later, so it isn't listed beside it.
  await editor.press('ControlOrMeta+End')
  await page.keyboard.type(' more')
  await saved(`${replaced} more`)
  const merging = await newest()
  const going = Date.now()
  await page.keyboard.type(' and some words', { delay: 400 })
  await saved(`${replaced} more and some words`)
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
  // More than the 5 s that once kept an autosave listed.
  assert.ok(after.savedAt - merging.savedAt >= 5000)
  // Unless a stall made a pause before typing went on, a point it would hold.
  if (going - merging.savedAt < 2500)
    assert.equal(
      shows(merging),
      false,
      'an autosave holding no point is not listed within 3 minutes of another entry',
    )
  assert.ok(shows(after))
  assert.ok(replacing.savedAt > holding.savedAt)
})

test('the history view leaves out an autosave within 3 minutes of a point it lists', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-history-view-beside-'))
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
  await autosaveOff(app, page)
  const editor = page.getByRole('textbox', { name: /document editor/i })
  await openInDocumentEditor(app, page, async () => {
    await pressShortcut(app, `${mod}+o`)
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      texts.original,
    )
  })
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Document editor"]')
        ?.isContentEditable,
  )
  // Nothing saved, so the only entry near the edit is the text it replaced, a
  // point; main answers with an autosave beside that and one far from it, and
  // a newest one, which always shows, far from them both.
  await replaceRichText(page, editor, texts.first)
  await app.evaluate(({ ipcMain }) => {
    const autosave = (id, ago) => ({
      id,
      hash: id,
      bytes: 1,
      savedAt: Date.now() - ago,
      automatic: true,
    })
    ipcMain.removeHandler('history:list')
    ipcMain.handle('history:list', () => [
      autosave('newest', -10 * 60 * 1000),
      autosave('beside', 1000),
      autosave('apart', 10 * 60 * 1000),
    ])
  })
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
  const listed = await points
    .getByRole('option')
    .evaluateAll((options) => options.map((option) => option.id))
  assert.ok(listed.some((id) => id.startsWith('history-point-')))
  assert.ok(listed.includes('history-version-newest'))
  assert.ok(listed.includes('history-version-apart'))
  assert.ok(!listed.includes('history-version-beside'))
})

test('the history view lists as a point a text no saved version holds: after Save As, a first save, a Replace and a failed version', {
  timeout: 120000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-history-view-kept-'))
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
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForFormattedEditor(app, page)
  await autosaveOff(app, page)
  const editor = page.getByRole('textbox', { name: /document editor/i })
  const shows = (text) =>
    waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
  const open = async (name, text) => {
    const file = join(profile, name)
    if (text !== undefined) await writeFile(file, text)
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await openInDocumentEditor(app, page, async () => {
      await pressShortcut(app, `${mod}+o`)
      await waitForAsync(
        page,
        async (name) => (await window.hibi.getDocument()).name === name,
        name,
      )
    })
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Document editor"]')
          ?.isContentEditable,
    )
  }
  const edit = async (text) => {
    await replaceRichText(page, editor, text)
    await shows(text)
  }
  const save = async (keys = `${mod}+s`) => {
    await pressShortcut(app, keys)
    await waitForAsync(
      page,
      async () => !(await window.hibi.getDocument()).dirty,
    )
    await page.locator('.app[aria-busy="false"]').waitFor()
  }
  const saveAs = async (name) => {
    await app.evaluate(
      ({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      },
      join(profile, name),
    )
    await save(`${mod}+Shift+s`)
  }
  // What the list says of each entry, past its time, once versions are in.
  const list = async () => {
    await editor.focus()
    await clickMenu(app, 'Command palette')
    await page
      .getByRole('combobox', { name: /search commands/i })
      .fill('history')
    await page
      .getByRole('option')
      .filter({ hasText: /^history/i })
      .first()
      .click()
    const history = page.getByRole('dialog', { name: /^history$/i })
    await history.waitFor()
    const entries = history
      .getByRole('listbox', { name: /points to return to/i })
      .getByRole('option')
    await entries
      .filter({ hasText: /saved version/i })
      .first()
      .waitFor()
    const labels = (await entries.allTextContents()).map((text) =>
      text.replace(/^[^·]*· /, ''),
    )
    await page.keyboard.press('Escape')
    await history.waitFor({ state: 'hidden' })
    return labels
  }
  const oldest = (labels) => labels.some((label) => /^oldest/i.test(label))

  const undoReady = () =>
    page.waitForFunction(
      () =>
        document.querySelector(
          '[aria-label="Editor toolbar"] button[aria-label="Undo"]',
        )?.disabled === false,
    )

  // A save that keeps both texts lists the one it replaced as that version.
  await open('saved.md', 'the text this note opened with, kept by the save')
  await edit('the text of a save that keeps both, well past a few characters')
  await save()
  assert.ok(!oldest(await list()), 'after a save')

  // So does a save at the prompt closing a tab, also once the note is reopened.
  await open(
    'prompted.md',
    'the text this note opened with, kept at the prompt',
  )
  await edit('the text saved at the closing prompt, well past a few characters')
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 })
  })
  await pressShortcut(app, `${mod}+w`)
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name !== 'prompted.md',
  )
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  await open('prompted.md')
  await undoReady()
  await edit('typed after reopening the note, well past a few characters')
  assert.ok(!oldest(await list()), 'after a save at the prompt')

  // Save As keeps no copy of the text before it at the new path, also once
  // the note is reopened.
  await open('moved.md', 'the text before it was saved under a new name')
  await edit('the text written under the new name, well past a few characters')
  await saveAs('new-name.md')
  assert.ok(oldest(await list()), 'after Save As')
  await pressShortcut(app, `${mod}+w`)
  await waitForAsync(page, async () => {
    const document = await window.hibi.getDocument()
    return document.name !== 'new-name.md'
  })
  await open('new-name.md')
  await undoReady()
  await edit('typed after reopening the note, well past a few characters')
  assert.ok(oldest(await list()), 'after reopening what Save As wrote')

  // A note's first save has no earlier text to keep.
  await openInDocumentEditor(app, page, async () => {
    await pressShortcut(app, `${mod}+n`)
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).name === 'untitled.md',
    )
  })
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Document editor"]')
        ?.isContentEditable,
  )
  await edit('the first words of a new note, well past a few characters')
  await saveAs('first-save.md')
  assert.ok(!oldest(await list()), 'after a first save')
  // All steps still goes back to its empty start.
  await editor.focus()
  await clickMenu(app, 'Command palette')
  await page.getByRole('combobox', { name: /search commands/i }).fill('history')
  await page
    .getByRole('option')
    .filter({ hasText: /^history/i })
    .first()
    .click()
  const history = page.getByRole('dialog', { name: /^history$/i })
  await history.getByRole('button', { name: /^all steps$/i }).click()
  await history
    .getByRole('treeitem')
    .filter({ hasText: /oldest kept text/i })
    .click()
  await history.getByRole('button', { name: /^go to step$/i }).click()
  await history.waitFor({ state: 'hidden' })
  await shows('')

  // Replacing a file another app changed keeps that app's text, not the text
  // this note opened with.
  await open('outside.md', 'the text this note opened with, before the rest')
  await edit('the text saved over the other app, well past a few characters')
  await writeFile(join(profile, 'outside.md'), 'what another app wrote there')
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 })
  })
  await save()
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  assert.ok(oldest(await list()), 'after Replace')

  // A save whose version couldn't be written holds no version: the state it
  // wrote is a point before the large edit that follows it.
  await open('failed.md', 'the text this note opened with, kept by the save')
  await edit('the text of the save that keeps its versions, past a few')
  await save()
  await app.evaluate(
    (_, history) => {
      const fs = process.getBuiltinModule('node:fs/promises')
      const { syncBuiltinESMExports } = process.getBuiltinModule('node:module')
      const open = fs.open
      fs.open = async (...args) => {
        if (args[1] === 'wx' && String(args[0]).startsWith(history))
          throw Object.assign(new Error('ENOSPC: no space left on device'), {
            code: 'ENOSPC',
          })
        return open(...args)
      }
      globalThis.restoreHistoryFailure = () => {
        fs.open = open
        syncBuiltinESMExports()
      }
      syncBuiltinESMExports()
    },
    join(profile, 'history'),
  )
  await edit('the text of the save that keeps no version, past a few')
  await save()
  await app.evaluate(() => globalThis.restoreHistoryFailure())
  await edit(`pasted over it. ${'and a long paragraph after it. '.repeat(10)}`)
  assert.ok(
    (await list()).some((label) => /^before a large edit/i.test(label)),
    'after a failed version',
  )
})

test('going to a step or restoring a point shows the change in the editor, and an edit made meanwhile or a read-only editor stops them', {
  timeout: 90000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-history-view-change-'))
  await installReadonlyProbe(profile)
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
  await autosaveOff(app, page)
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
  await openInDocumentEditor(app, page, async () => {
    await pressShortcut(app, `${mod}+o`)
    await shows(original)
  })
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
  // Where the caret is and whether the view shows it, once it reaches
  // `expected`: the view scrolls to it at a later measure.
  const caret = async (expected) => {
    let now
    await waitForAsync({ evaluate: (predicate) => predicate() }, async () => {
      now = await page.evaluate(() => {
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
      return JSON.stringify(now) === JSON.stringify(expected)
    }).catch(() => {})
    return now
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
  assert.deepEqual(await caret({ at: original.length, shown: true }), {
    at: original.length,
    shown: true,
  })

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
  assert.deepEqual(await caret({ at: edited.length, shown: true }), {
    at: edited.length,
    shown: true,
  })

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

test('restoring a saved version shows the change in the editor, one chosen while a save runs follows it in its tab, and a read-only editor stops it', {
  timeout: 90000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-history-view-version-'))
  await installReadonlyProbe(profile)
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
  await autosaveOff(app, page)
  const editor = page.getByRole('textbox', { name: /document editor/i })
  const markdown = () =>
    page.evaluate(async () => (await window.hibi.getDocument()).markdown)
  const shows = (text) =>
    waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
  await openInDocumentEditor(app, page, async () => {
    await pressShortcut(app, `${mod}+o`)
    await shows(original)
  })
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
  // Where the caret is and whether the view shows it, once it reaches
  // `expected`: the view scrolls to it at a later measure.
  const caret = async (expected) => {
    let now
    await waitForAsync({ evaluate: (predicate) => predicate() }, async () => {
      now = await page.evaluate(() => {
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
      return JSON.stringify(now) === JSON.stringify(expected)
    }).catch(() => {})
    return now
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
  assert.deepEqual(await caret({ at: original.length, shown: true }), {
    at: original.length,
    shown: true,
  })

  // A save held on its way to main keeps the app busy.
  const holdSave = async () => {
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
  }
  const historyDuringSave = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send(
        'app:command',
        'history',
      ),
    )

  // The version chosen while a save runs is restored once the save is done,
  // not dropped, and the editor shows its change.
  await edit({ changes: { from: 0, insert: '# ' } })
  await shows(`# ${original}`)
  await holdSave()
  await historyDuringSave()
  await restore(edited)
  assert.equal(await markdown(), `# ${original}`)
  await app.evaluate(() => globalThis.release())
  await shows(edited)
  assert.deepEqual(await caret({ at: edited.length, shown: true }), {
    at: edited.length,
    shown: true,
  })

  // A tab chosen before it goes first: the version isn't restored in that one.
  const other = join(profile, 'other.md')
  await writeFile(other, 'the other note')
  await app.evaluate(({ dialog }, other) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [other],
    })
  }, other)
  await pressShortcut(app, `${mod}+o`)
  await shows('the other note')
  await page.getByRole('tab', { name: 'note.md', exact: true }).click()
  await shows(edited)
  await holdSave()
  await page
    .getByRole('tab', { name: 'other.md', exact: true })
    .click({ force: true })
  await historyDuringSave()
  await restore(original)
  await app.evaluate(() => globalThis.release())
  await shows('the other note')
  await page.getByText(/the version wasn.t restored/i).waitFor()
  assert.equal(await markdown(), 'the other note')
  await page.getByRole('tab', { name: 'note.md', exact: true }).click()
  await shows(edited)

  // A note with CRLF line ends: the editor's positions are not the text's, and
  // the caret goes to the editor's.
  const windows = join(profile, 'windows.md')
  const lines = 'the first line\r\n\r\nthe second line'
  const linesEdited = `${lines} and more words after it`
  await writeFile(windows, lines)
  await app.evaluate(({ dialog }, windows) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [windows],
    })
  }, windows)
  await openInDocumentEditor(app, page, async () => {
    await pressShortcut(app, `${mod}+o`)
    await shows(lines)
  })
  await page.waitForFunction(
    () => document.querySelector('.rich-pane .cm-content')?.isContentEditable,
  )
  const inEditor = lines.replaceAll('\r\n', '\n').length
  await edit({
    changes: { from: inEditor, insert: linesEdited.slice(lines.length) },
    userEvent: 'input.type',
  })
  await shows(linesEdited)
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(
    page,
    async (text) => {
      const document = await window.hibi.getDocument()
      return document.savedMarkdown === text && !document.dirty
    },
    linesEdited,
  )
  await top()
  await openHistory()
  await restore(lines)
  await shows(lines)
  assert.deepEqual(await caret({ at: inEditor, shown: true }), {
    at: inEditor,
    shown: true,
  })
  await openInDocumentEditor(app, page, async () => {
    await page.getByRole('tab', { name: 'note.md', exact: true }).click()
    await shows(edited)
  })

  // A read-only editor takes no edit, as with its own undo.
  await page.waitForFunction(() => !!window.readonlyCodeMirror)
  await page.waitForFunction(
    () => document.querySelector('.rich-pane .cm-content')?.isContentEditable,
  )
  await top()
  await openHistory()
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
  await restore(original)
  await page.getByText(/the editor is read-only right now/i).waitFor()
  assert.equal(await markdown(), edited)
})

test('a saved version stays out of a note gone to while its text is read, and one chosen while another tab closes is restored', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-history-view-reading-'))
  const original = 'the first note, as written'
  const edited = `${original} and edited`
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
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForFormattedEditor(app, page)
  const shows = (text) =>
    waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
  const open = async (name, text) => {
    const file = join(profile, name)
    await writeFile(file, text)
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await openInDocumentEditor(app, page, async () => {
      await pressShortcut(app, `${mod}+o`)
      await shows(text)
    })
    await page.waitForFunction(
      () => document.querySelector('.rich-pane .cm-content')?.isContentEditable,
    )
  }
  await open('other.md', 'the other note')
  await open('note.md', original)
  await page.evaluate((insert) => {
    const { view } = document.querySelector('.rich-pane .cm-content').cmTile
      .root
    view.dispatch({
      changes: { from: view.state.doc.length, insert },
      userEvent: 'input.type',
    })
  }, edited.slice(original.length))
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
  // Chooses the version of the first text, with its preview shown.
  const choose = async () => {
    const history = page.getByRole('dialog', { name: /^history$/i })
    await history.waitFor()
    const id = await page.evaluate(async (text) => {
      for (const { id } of await window.hibi.listVersions())
        if ((await window.hibi.previewVersion(id)) === text) return id
    }, original)
    await history.locator(`#history-version-${id}`).click()
    await history.locator('section pre').waitFor()
    return history
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
  // Holds the next call on a channel; with `after`, its reply on the way back.
  const hold = (channels, after) =>
    app.evaluate(
      ({ ipcMain }, { channels, after }) => {
        const handlers = ipcMain._invokeHandlers
        globalThis.held = new Promise((entered) => {
          for (const channel of channels) {
            const handler = handlers.get(channel)
            handlers.set(channel, async (...args) => {
              handlers.set(channel, handler)
              const reply = after ? await handler(...args) : null
              await new Promise((release) => {
                globalThis.release = release
                entered()
              })
              return after ? reply : handler(...args)
            })
          }
        })
      },
      { channels, after },
    )

  // The text comes back after the user has gone to the other note: that note
  // keeps its text, the first keeps its own, and the user hears why.
  await openHistory()
  const history = await choose()
  await hold(['history:preview'], true)
  await history.getByRole('button', { name: /^restore$/i }).click()
  await history.waitFor({ state: 'hidden' })
  await app.evaluate(() => globalThis.held)
  await page.getByRole('tab', { name: 'other.md', exact: true }).click()
  await shows('the other note')
  await app.evaluate(() => globalThis.release())
  await page.getByText(/the version wasn.t restored/i).waitFor()
  assert.equal(
    await page.evaluate(async () => (await window.hibi.getDocument()).markdown),
    'the other note',
  )
  await openInDocumentEditor(app, page, async () => {
    await page.getByRole('tab', { name: 'note.md', exact: true }).click()
    await shows(edited)
  })
  await page.waitForFunction(
    () => document.querySelector('.rich-pane .cm-content')?.isContentEditable,
  )

  // A file operation other than a save disables the editor until the app has
  // rendered its end: that is no read-only editor to the waiting version.
  await hold(['document:close-tab', 'document:close-tabs'], false)
  await page
    .getByRole('button', { name: 'Close other.md' })
    .click({ force: true })
  await page.locator('.app[aria-busy="true"]').waitFor()
  await app.evaluate(() => globalThis.held)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('app:command', 'history'),
  )
  const during = await choose()
  await during.getByRole('button', { name: /^restore$/i }).click()
  await during.waitFor({ state: 'hidden' })
  await app.evaluate(() => globalThis.release())
  await shows(original)
})
