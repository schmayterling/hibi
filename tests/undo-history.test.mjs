import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync, waitForFormattedEditor } from './electron.mjs'
import { pressShortcut, redoKey, replaceRichText } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function note(t, text = 'original') {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-undo-history-'))
  const file = join(profile, 'note.md')
  await writeFile(file, text)
  const apps = [],
    quit = new WeakSet()
  t.after(async () => {
    for (const app of apps) if (!quit.has(app)) await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  /** One launch over the profile; save prompts answer `response`. */
  async function launch(response = 1) {
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    apps.push(app)
    await app.evaluate(
      ({ dialog }, { file, response }) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        })
        dialog.showMessageBox = async () => ({ response })
      },
      { file, response },
    )
    const page = await app.firstWindow()
    page.setDefaultTimeout(8000)
    await waitForFormattedEditor(app, page)
    const shows = (text) =>
      waitForAsync(
        page,
        async (text) => (await window.hibi.getDocument()).markdown === text,
        text,
      )
    const editor = page.getByRole('textbox', { name: /document editor/i })
    const button = (name) =>
      `[aria-label="Editor toolbar"] button[aria-label="${name}"]`
    return {
      app,
      page,
      shows,
      async open(text) {
        await pressShortcut(app, `${mod}+o`)
        await shows(text)
        await page.waitForFunction(
          (text) =>
            document.querySelector('[aria-label="Document editor"]')
              ?.textContent === text,
          text,
        )
      },
      async edit(text) {
        await replaceRichText(page, editor, text)
        await shows(text)
      },
      async save(text) {
        await pressShortcut(app, `${mod}+s`)
        await waitForAsync(
          page,
          async () => !(await window.hibi.getDocument()).dirty,
        )
        assert.equal(await readFile(file, 'utf8'), text)
      },
      /** Waits until the kept steps reach the reopened note; whether redo has any. */
      async restored() {
        await page.waitForFunction(
          (selector) => document.querySelector(selector)?.disabled === false,
          button('Undo'),
        )
        return !(await page.$eval(button('Redo'), (redo) => redo.disabled))
      },
      async undo(text) {
        await editor.focus()
        await pressShortcut(app, `${mod}+z`)
        await shows(text)
      },
      async redo(text) {
        await editor.focus()
        await page.keyboard.press(redoKey)
        await shows(text)
      },
      async quit() {
        const closed = app.waitForEvent('close')
        await app.evaluate(({ app }) => app.quit())
        await closed
        quit.add(app)
      },
    }
  }
  return { file, profile, launch }
}

test('a note reopened after its tab closed undoes the edits saved before', {
  timeout: 60000,
}, async (t) => {
  const { launch } = await note(t)
  const hibi = await launch()
  await hibi.open('original')
  await hibi.edit('first draft')
  await hibi.save('first draft')
  await hibi.edit('second draft')
  await hibi.save('second draft')
  await pressShortcut(hibi.app, `${mod}+w`)
  await hibi.shows('')
  await hibi.open('second draft')
  assert.equal(await hibi.restored(), false)
  await hibi.undo('first draft')
  await hibi.undo('original')
  await hibi.redo('first draft')
  await hibi.redo('second draft')
})

test('restarting keeps undo, with a save made at the quit prompt', {
  timeout: 90000,
}, async (t) => {
  const { launch } = await note(t)
  // Every quit prompt answers Save.
  const first = await launch(0)
  await first.open('original')
  await first.edit('saved while quitting')
  await first.quit()
  const second = await launch()
  await second.open('saved while quitting')
  await second.restored()
  await second.undo('original')
  await second.redo('saved while quitting')
})

test("Don't save leaves no trace of the discarded text in kept history", {
  timeout: 90000,
}, async (t) => {
  const { launch, profile } = await note(t)
  const first = await launch()
  await first.open('original')
  await first.edit('kept draft')
  await first.save('kept draft')
  await first.edit('SECRET-DISCARD draft')
  // The quit prompt answers Don't save.
  await first.quit()
  const folder = join(profile, 'undo-history')
  const kept = await Promise.all(
    (await readdir(folder)).map((name) => readFile(join(folder, name), 'utf8')),
  )
  assert.equal(kept.length, 1)
  assert.match(kept[0], /kept draft/)
  assert.doesNotMatch(kept[0], /SECRET-DISCARD/)
  const second = await launch()
  await second.open('kept draft')
  // Nothing discarded comes back as redo either.
  assert.equal(await second.restored(), false)
  await second.undo('original')
  await second.redo('kept draft')
})

test('clearing undo history forgets open and kept steps, and keeping it can be turned off', {
  timeout: 90000,
}, async (t) => {
  const { launch, profile } = await note(t)
  const hibi = await launch()
  const { app, page } = hibi
  const folder = join(profile, 'undo-history')
  const kept = (count) =>
    waitForAsync(
      app,
      async (_electron, [folder, count]) => {
        const { readdir } = process.getBuiltinModule('node:fs/promises')
        return (await readdir(folder).catch(() => [])).length === count
      },
      [folder, count],
    )
  await hibi.open('original')
  await hibi.edit('first draft')
  await hibi.save('first draft')
  await kept(1)
  await page.locator('[data-status-id="autosave"]').click()
  // The row names its button.
  await page.getByRole('button', { name: /^clear undo history$/i }).click()
  await page
    .getByRole('dialog', { name: /^clear undo history\?$/i })
    .getByRole('button', { name: 'Clear', exact: true })
    .click()
  await kept(0)
  await page
    .getByRole('checkbox', { name: /^keep undo history after closing$/i })
    .uncheck()
  await waitForAsync(
    page,
    async () => !(await window.hibi.getKeepUndoHistory()),
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()
  // The open note forgot its steps too.
  await page.waitForFunction(
    () =>
      document.querySelector(
        '[aria-label="Editor toolbar"] button[aria-label="Undo"]',
      )?.disabled === true,
  )
  await hibi.edit('second draft')
  await hibi.save('second draft')
  // Closing the tab sends any history a save left; none is kept now.
  await pressShortcut(app, `${mod}+w`)
  await hibi.shows('')
  await kept(0)
  assert.deepEqual(
    JSON.parse(
      await readFile(join(profile, 'undo-history-settings.json'), 'utf8'),
    ),
    { keep: false },
  )
})
