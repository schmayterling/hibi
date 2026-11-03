import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync, waitForFormattedEditor } from './electron.mjs'
import { pressShortcut, redoKey, replaceRichText } from './keyboard.mjs'
import { renameDocument } from './rename.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function note(t, text = 'original', folder = '') {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-undo-history-'))
  const file = join(profile, folder, 'note.md')
  await mkdir(dirname(file), { recursive: true })
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
        // The window still finishes the save after the file is written, and
        // drops a shortcut that comes meanwhile (cmd+w closing no tab).
        await page.locator('.app[aria-busy="false"]').waitFor()
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
      /** Quits, by default as the Quit menu item does. */
      async quit(how = ({ app }) => app.quit()) {
        const closed = app.waitForEvent('close')
        await app.evaluate(how)
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
  // The editor answers the quit's flush, so quitting needn't wait out its 5 s timeout.
  await first.app.evaluate(
    ({ BrowserWindow }) =>
      new Promise((resolve, reject) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents
        const { ipc } = contents
        const timer = setTimeout(() => {
          ipc.removeHandler('undo-history:flushed')
          reject(new Error('the editor did not answer the flush'))
        }, 4000)
        ipc.handle('undo-history:flushed', (_event, token) => {
          clearTimeout(timer)
          ipc.removeHandler('undo-history:flushed')
          if (token === 'probe') resolve()
          else reject(new Error(`flushed ${token}`))
        })
        contents.send('undo-history:flush', 'probe')
      }),
  )
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

test('a note renamed inside Hibi keeps its undo history under its new name', {
  timeout: 60000,
}, async (t) => {
  const { launch, profile, file } = await note(t)
  const hibi = await launch()
  const { app, page } = hibi
  const folder = join(profile, 'undo-history')
  const named = async (path) =>
    `${createHash('sha256')
      .update(await realpath(path))
      .digest('hex')}.json`
  const kept = (names) =>
    waitForAsync(
      app,
      async (_electron, [folder, names]) => {
        const { readdir } = process.getBuiltinModule('node:fs/promises')
        const kept = await readdir(folder).catch(() => [])
        return kept.sort().join() === names.sort().join()
      },
      [folder, names],
    )
  await hibi.open('original')
  await hibi.edit('first draft')
  await hibi.save('first draft')
  await kept([await named(file)])
  await renameDocument(app, page, 'renamed')
  const renamed = join(profile, 'renamed.md')
  await kept([await named(renamed)])
  await pressShortcut(app, `${mod}+w`)
  await hibi.shows('')
  await app.evaluate(({ dialog }, renamed) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [renamed],
    })
  }, renamed)
  await hibi.open('first draft')
  await hibi.restored()
  await hibi.undo('original')
  assert.deepEqual(await readdir(folder), [await named(renamed)])
})

test('a note Hibi moves to the trash takes its kept undo history, with the steps its closing tab sends', {
  timeout: 60000,
}, async (t) => {
  const { launch, profile, file } = await note(t, 'original', 'notes')
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
  // The next save's steps wait until its tab closes and asks for them.
  await page.evaluate(() => {
    const idle = window.requestIdleCallback
    window.requestIdleCallback = (callback, options) =>
      options?.timeout === 5000 ? 0 : idle(callback, options)
  })
  await hibi.edit('second draft')
  await hibi.save('second draft')
  await app.evaluate(({ dialog, shell }, notes) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [notes],
    })
    shell.trashItem = (path) =>
      process.getBuiltinModule('node:fs/promises').rm(path, { recursive: true })
  }, dirname(file))
  await page.evaluate(() => window.hibi.openWorkspace())
  await page.evaluate(() =>
    window.hibi.workspaceAction({ action: 'delete', path: 'note.md' }),
  )
  await kept(0)
})

test('closing a tab waits until its steps are sent, not until they are written', {
  timeout: 60000,
}, async (t) => {
  const { launch, profile } = await note(t)
  const hibi = await launch()
  const { app, page } = hibi
  await hibi.open('original')
  // The save's steps wait until its tab closes and asks for them.
  await page.evaluate(() => {
    const idle = window.requestIdleCallback
    window.requestIdleCallback = (callback, options) =>
      options?.timeout === 5000 ? 0 : idle(callback, options)
  })
  await hibi.edit('first draft')
  await hibi.save('first draft')
  // Writes answer late, as one queued behind another note's long write does.
  await app.evaluate(({ ipcMain }) => {
    const store = ipcMain._invokeHandlers.get('undo-history:store')
    globalThis.writes = Promise.withResolvers()
    ipcMain._invokeHandlers.set('undo-history:store', async (...args) => {
      const result = await store(...args)
      await globalThis.writes.promise
      return result
    })
  })
  const closing = performance.now()
  await pressShortcut(app, `${mod}+w`)
  await hibi.shows('')
  // An editor that doesn't answer holds a closing tab for 5 s.
  const took = performance.now() - closing
  assert.ok(took < 4000, `closing took ${Math.round(took)} ms`)
  await app.evaluate(() => globalThis.writes.resolve())
  // The steps were kept all the same.
  assert.equal((await readdir(join(profile, 'undo-history'))).length, 1)
})

test('a quit after the editor stopped still waits for kept undo history writes', {
  timeout: 60000,
}, async (t) => {
  const { launch, profile, file } = await note(t)
  // The dialog shown when the editor stops answers Quit.
  const hibi = await launch(1)
  const { app } = hibi
  await hibi.open('original')
  // Kept history writes wait until released, as on a slow disk.
  await app.evaluate(() => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const rename = fs.rename
    const held = Promise.withResolvers()
    globalThis.writes = { held: 0, release: held.resolve }
    fs.rename = async (from, to) => {
      if (/undo-history[\\/][0-9a-f]{64}\.json$/.test(to)) {
        globalThis.writes.held++
        await held.promise
      }
      return rename(from, to)
    }
    process.getBuiltinModule('node:module').syncBuiltinESMExports()
  })
  await hibi.edit('first draft')
  await hibi.save('first draft')
  await waitForAsync(app, () => globalThis.writes.held >= 1)
  await hibi.quit(({ BrowserWindow }) => {
    setTimeout(() => globalThis.writes.release(), 1000)
    BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()
  })
  const name = `${createHash('sha256')
    .update(await realpath(file))
    .digest('hex')}.json`
  assert.match(
    await readFile(join(profile, 'undo-history', name), 'utf8'),
    /first draft/,
  )
})

test('a launch lets go of the kept history of a note deleted outside Hibi, and keeps one on a drive that is not mounted', {
  timeout: 120000,
}, async (t) => {
  const { file, profile, launch } = await note(t, 'original', 'notes')
  const away = join(profile, 'drive', 'away.md')
  await mkdir(dirname(away))
  await writeFile(away, 'far away')
  const hibi = await launch()
  await hibi.open('original')
  await hibi.edit('first draft')
  await hibi.save('first draft')
  await hibi.app.evaluate(({ dialog }, away) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [away],
    })
  }, away)
  await hibi.open('far away')
  await hibi.edit('further away')
  await pressShortcut(hibi.app, `${mod}+s`)
  await waitForAsync(
    hibi.page,
    async () => !(await window.hibi.getDocument()).dirty,
  )
  await hibi.page.locator('.app[aria-busy="false"]').waitFor()
  const kept = (path) =>
    `${createHash('sha256').update(path).digest('hex')}.json`
  const deleted = kept(await realpath(file)),
    unmounted = kept(await realpath(away))
  const folder = join(profile, 'undo-history')
  await waitForAsync(
    hibi.app,
    async (_electron, [folder, names]) => {
      const { readdir } = process.getBuiltinModule('node:fs/promises')
      const files = await readdir(folder).catch(() => [])
      return names.every((name) => files.includes(name))
    },
    [folder, [deleted, unmounted]],
  )
  await hibi.quit()
  await writeFile(join(dirname(file), 'other.md'), 'still here')
  await rm(file)
  await rename(dirname(away), `${dirname(away)} unmounted`)
  const started = Date.now()
  await launch()
  // The prune starts 15 s into the launch and looks again 10 s later.
  while (
    (await readdir(folder)).includes(deleted) &&
    Date.now() - started < 90000
  )
    await new Promise((resolve) => setTimeout(resolve, 250))
  assert.ok(Date.now() - started > 15000, 'let go too early')
  assert.deepEqual(await readdir(folder), [unmounted])
})
