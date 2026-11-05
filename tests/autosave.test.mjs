import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  electron,
  waitForDocumentEditor,
  waitForFormattedEditor,
} from './electron.mjs'
import { clickMenu, pressShortcut, replaceRichText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('autosave keeps a dirty tab scheduled after focus moves to another tab', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-autosave-tabs-'))
  const a = join(profile, 'a.md')
  const b = join(profile, 'b.md')
  await writeFile(a, 'a')
  await writeFile(b, 'b')
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
  await waitForFormattedEditor(app, page)
  page.setDefaultTimeout(6500)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  await page.locator('[data-status-id="autosave"]').click()
  await page.getByRole('checkbox', { name: /^autosave$/i }).check()
  await page.getByLabel(/^save after$/i).selectOption('1000')
  await page.getByRole('button', { name: /^back to app$/i }).click()
  for (const file of [a, b]) {
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
      file === a ? 'a.md' : 'b.md',
    )
  }
  await page.getByRole('tab', { name: 'a.md' }).click()
  await waitForDocumentEditor(app, page)
  // Hosted windows sometimes never save a.md; record each autosave outcome.
  await app.evaluate(({ ipcMain }) => {
    const outcomes = []
    globalThis.autosaveOutcomes = outcomes
    const handler = ipcMain._invokeHandlers.get('document:autosave')
    ipcMain._invokeHandlers.set('document:autosave', async (...args) => {
      try {
        const result = await handler(...args)
        outcomes.push(result?.status)
        return result
      } catch (error) {
        outcomes.push(String(error).slice(0, 300))
        throw error
      }
    })
  })
  await replaceRichText(page, rich, 'edited a')
  await page.getByRole('tab', { name: 'b.md' }).click()
  const deadline = performance.now() + 7000
  while (
    (await readFile(a, 'utf8')) !== 'edited a' &&
    performance.now() < deadline
  )
    await delay(30)
  const saved = await readFile(a, 'utf8')
  if (saved !== 'edited a')
    console.error(
      'autosave dirty tab:',
      JSON.stringify({
        outcomes: await app.evaluate(() =>
          globalThis.autosaveOutcomes.slice(-10),
        ),
        tabs: await page.evaluate(async () =>
          (await window.hibi.getDocument()).tabs.map(({ name, dirty }) => ({
            name,
            dirty,
          })),
        ),
      }),
    )
  assert.equal(saved, 'edited a')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).name,
    'b.md',
  )
  // Saved in the background, it kept the text it replaced and the text it wrote.
  await page.getByRole('tab', { name: 'a.md' }).click()
  await waitForDocumentEditor(app, page)
  assert.deepEqual(
    (await page.evaluate(() => window.hibi.listVersions())).map(
      ({ automatic }) => automatic ?? false,
    ),
    [true, false],
  )
})

test('autosave preserves later edits, pauses on external changes, and never prompts for unnamed drafts', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-autosave-'))
  const file = join(profile, 'note.md')
  await writeFile(file, 'original')
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
  await waitForFormattedEditor(app, page)
  page.setDefaultTimeout(6500)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  await app.evaluate(({ dialog }, file) => {
    globalThis.dialogsShown = 0
    dialog.showSaveDialog = async () => {
      globalThis.dialogsShown++
      return { canceled: true }
    }
    dialog.showMessageBox = async () => {
      globalThis.dialogsShown++
      return { response: 0 }
    }
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  const pill = page.locator('[data-status-id="autosave"]')
  assert.equal(await pill.innerText(), 'Autosave · save first')
  await pill.click()
  await page.getByRole('checkbox', { name: /^autosave$/i, exact: true }).check()
  await page.getByLabel(/^save after$/i, { exact: true }).selectOption('1000')
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await waitForDocumentEditor(app, page)
  await replaceRichText(page, rich, 'new draft')
  await page.waitForTimeout(1200)
  assert.equal(await app.evaluate(() => globalThis.dialogsShown), 0)
  assert.equal(await pill.innerText(), 'Autosave · save first')
  await replaceRichText(page, rich, '')
  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).canAutosave,
  )
  // Native state can arrive before React replaces the previous tab's editor.
  await page.waitForFunction(() => {
    const editor = document.querySelector('[aria-label="Document editor"]')
    return editor?.isContentEditable && editor.textContent === 'original'
  })
  await app.evaluate(({ ipcMain }) => {
    const save = ipcMain._invokeHandlers.get('document:autosave')
    ipcMain.removeHandler('document:autosave')
    ipcMain.handle('document:autosave', async (...args) => {
      const result = await save(...args)
      globalThis.firstSaved = result.document?.markdown
      await new Promise((resolve) => setTimeout(resolve, 500))
      return result
    })
  })
  await replaceRichText(page, rich, 'first automatic save')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).savedMarkdown ===
      'first automatic save',
  )
  await replaceRichText(page, rich, 'keep typing during save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  await page.waitForFunction(
    () =>
      document.querySelector('[data-status-id="autosave"]').textContent ===
      'Autosave · saved',
  )
  assert.equal(await rich.innerText(), 'keep typing during save')
  assert.equal(await readFile(file, 'utf8'), 'keep typing during save')
  assert.ok((await page.evaluate(() => window.hibi.listVersions())).length >= 3)
  await writeFile(file, 'external edit')
  await replaceRichText(page, rich, 'local edit')
  await page.waitForFunction(
    () =>
      document.querySelector('[data-status-id="autosave"]').textContent ===
      'Autosave · paused',
  )
  assert.equal(await app.evaluate(() => globalThis.dialogsShown), 0)
  assert.equal(await readFile(file, 'utf8'), 'external edit')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).dirty,
    true,
  )
  await replaceRichText(page, rich, 'another local edit')
  await page.waitForTimeout(1200)
  assert.equal(await readFile(file, 'utf8'), 'external edit')
  await clickMenu(app, 'Save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), 'another local edit')
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Document editor"]')
        ?.getAttribute('contenteditable') === 'true',
  )
  await replaceRichText(page, rich, 'autosave resumes')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), 'autosave resumes')
  await page.reload()
  await rich.waitFor()
  await pill.click()
  assert.equal(
    await page
      .getByRole('checkbox', { name: /^autosave$/i, exact: true })
      .isChecked(),
    true,
  )
  assert.equal(
    await page.getByLabel(/^save after$/i, { exact: true }).inputValue(),
    '1000',
  )
})

test('autosave waits while an input method composes, then saves the committed text', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-autosave-composition-'))
  const file = join(profile, 'note.md')
  await writeFile(file, 'x')
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
  const shows = (text) =>
    waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
  const saves = (text) =>
    waitForAsync(
      app,
      async (_electron, [file, text]) => {
        const { readFile } = process.getBuiltinModule('node:fs/promises')
        return (await readFile(file, 'utf8')) === text
      },
      [file, text],
      { label: `the file holds ${JSON.stringify(text)}` },
    )
  await clickMenu(app, 'Open…')
  await shows('x')
  await page.locator('[data-status-id="autosave"]').click()
  await page.getByRole('checkbox', { name: /^autosave$/i }).check()
  await page.getByLabel(/^save after$/i).selectOption('1000')
  await page.getByRole('button', { name: /^back to app$/i }).click()
  // Each autosave attempt is the async callback of a 1 s timer; keep them so
  // the test can wait for one to finish.
  await page.evaluate(() => {
    const later = window.setTimeout
    window.autosaveRuns = []
    window.setTimeout = (callback, ms, ...rest) =>
      later(
        (...args) => {
          const run = callback(...args)
          if (ms === 1000 && run instanceof Promise)
            window.autosaveRuns.push(run)
          return run
        },
        ms,
        ...rest,
      )
  })
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.focus()
  await rich.press('End')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const compose = async (...texts) => {
    for (const text of texts)
      await cdp.send('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      })
  }
  await compose('n', 'に')
  await shows('xに')
  // The candidate window stays open past the delay: the attempt that comes
  // due writes nothing, since the reading isn't the text.
  await waitForAsync(page, () => window.autosaveRuns.length > 0)
  await page.evaluate(() => Promise.all(window.autosaveRuns))
  assert.equal(await readFile(file, 'utf8'), 'x')
  await compose('にほ', 'にほん')
  await cdp.send('Input.insertText', { text: '日本' })
  await shows('x日本')
  await saves('x日本')
  // The composition is still one undo step.
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  await shows('x')
  await saves('x')
  // Committing the reading as it stands changes no text, and still saves.
  await compose('に')
  await shows('xに')
  await cdp.send('Input.insertText', { text: 'に' })
  await saves('xに')
  // A composition whose field left the page holds autosave no longer: the
  // attempt it held comes due again, with no later edit.
  await page.evaluate(() => {
    const field = document.createElement('textarea')
    field.id = 'composition-field'
    document.body.append(field)
    field.focus()
  })
  await compose('か')
  const held = await page.evaluate(() => window.autosaveRuns.length)
  await rich.evaluate((element) => {
    const { view } = element.cmTile.root
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'y' } })
  })
  await shows('xにy')
  await waitForAsync(page, (held) => window.autosaveRuns.length > held, held)
  await page.evaluate(() => Promise.all(window.autosaveRuns))
  assert.equal(await readFile(file, 'utf8'), 'xに')
  await page.evaluate(() =>
    document.getElementById('composition-field').remove(),
  )
  await saves('xにy')
  // Turned off, autosave keeps no composition listener that saves.
  await page.locator('[data-status-id="autosave"]').click()
  await page.getByRole('checkbox', { name: /^autosave$/i }).uncheck()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await rich.focus()
  await rich.press('End')
  await compose('か')
  await cdp.send('Input.insertText', { text: '火' })
  await shows('xにy火')
  await page.waitForTimeout(1200)
  assert.equal(await readFile(file, 'utf8'), 'xにy')
})

async function openNote(t, text = 'original') {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-autosave-default-'))
  const file = join(profile, 'note.md')
  await writeFile(file, text)
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
  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown === text,
    text,
  )
  await waitForDocumentEditor(app, page)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  const pill = page.locator('[data-status-id="autosave"]')
  return { app, page, rich, pill, file, profile }
}

test('a note nobody set autosave for saves itself, and never over another program’s text', {
  timeout: 60000,
}, async (t) => {
  const { app, page, rich, pill, file } = await openNote(t)
  await pill.getByText('Autosave · saved').waitFor()
  await replaceRichText(page, rich, 'saved by itself')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), 'saved by itself')
  await pill.getByText('Autosave · saved').waitFor()

  await writeFile(file, 'another program wrote this')
  await replaceRichText(page, rich, 'my next words')
  await pill.getByText('Autosave · paused').waitFor()
  assert.equal(await readFile(file, 'utf8'), 'another program wrote this')

  // A note never saved waits for a name, and asks nothing.
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+n' : 'Control+n',
  )
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'untitled.md',
  )
  await replaceRichText(page, rich, 'a draft')
  await pill.getByText('Autosave · save first').waitFor()
})

test('autosave turned off stays off across a launch', {
  timeout: 60000,
}, async (t) => {
  const { app, page, rich, pill, file } = await openNote(t)
  await pill.click()
  const box = page.getByRole('checkbox', { name: /^autosave$/i })
  assert.equal(await box.isChecked(), true)
  await box.uncheck()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page.reload()
  await waitForFormattedEditor(app, page)
  await pill.getByText('Autosave off').waitFor()
  await replaceRichText(page, rich, 'typed and left')
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 3000)))
  assert.equal(await readFile(file, 'utf8'), 'original')
  assert.equal(
    await page.evaluate(async () => (await window.hibi.getDocument()).dirty),
    true,
  )
})

test('a note whose save took long rests ten times as long before the next', {
  timeout: 60000,
}, async (t) => {
  const { app, page, rich, file } = await openNote(t)
  // Only an IPC gate can hold a save for an exact amount of page-clock time.
  await app.evaluate(({ ipcMain }) => {
    const save = ipcMain._invokeHandlers.get('document:autosave')
    let first = true
    globalThis.autosaveAttempts = 0
    globalThis.slowAutosaveStarted = new Promise((started) => {
      ipcMain._invokeHandlers.set('document:autosave', async (...args) => {
        globalThis.autosaveAttempts++
        if (first) {
          first = false
          await new Promise((release) => {
            globalThis.releaseSlowAutosave = release
            started()
          })
        }
        return save(...args)
      })
    })
  })
  await page.clock.install()
  await page.clock.pauseAt(Date.now() + 60000)
  const saved = async (text) => {
    const deadline = performance.now() + 5000
    while (performance.now() < deadline) {
      if ((await readFile(file, 'utf8')) === text) return true
      await delay(50)
    }
    return false
  }
  try {
    await replaceRichText(page, rich, 'first')
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).markdown === 'first',
    )
    await page.clock.runFor(2000)
    await app.evaluate(() => globalThis.slowAutosaveStarted)
    await page.clock.runFor(1000)
    await app.evaluate(() => globalThis.releaseSlowAutosave())
    assert.equal(await saved('first'), true)
    await waitForAsync(
      page,
      async () => !(await window.hibi.getDocument()).dirty,
    )
    await replaceRichText(page, rich, 'second')
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).markdown === 'second',
    )
    await page.clock.runFor(9999)
    // Drain earlier renderer IPC before asking whether another write began.
    await page.evaluate(() => window.hibi.getDocument())
    assert.equal(await app.evaluate(() => globalThis.autosaveAttempts), 1)
    assert.equal(await readFile(file, 'utf8'), 'first')
    await page.clock.runFor(1)
    assert.equal(await saved('second'), true)
    assert.equal(await app.evaluate(() => globalThis.autosaveAttempts), 2)
  } finally {
    await app.evaluate(() => globalThis.releaseSlowAutosave?.())
  }
})

test('one key over a whole note reaches the file by itself, and the text it replaced stays reachable', {
  timeout: 60000,
}, async (t) => {
  const original = 'a whole note, selected by accident'
  const { app, page, rich, file } = await openNote(t, original)
  await replaceRichText(page, rich, 'x')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), 'x')
  // Saved versions hold it past a restart.
  const kept = await page.evaluate(async () => {
    const versions = await window.hibi.listVersions()
    return Promise.all(versions.map(({ id }) => window.hibi.previewVersion(id)))
  })
  assert.ok(kept.includes(original), JSON.stringify(kept))
  // And undo takes it straight back in this session.
  await rich.focus()
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  await waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown === text,
    original,
  )
})

test('a read-only note is left alone and says so, until it can be written', {
  timeout: 60000,
}, async (t) => {
  const { page, rich, pill, file } = await openNote(t)
  await chmod(file, 0o444)
  await page.clock.install()
  await replaceRichText(page, rich, 'typed by accident')
  await page.locator('.toast', { hasText: /marked read-only/ }).waitFor()
  await pill.getByText('Autosave · retrying').waitFor()
  assert.equal(await readFile(file, 'utf8'), 'original')
  await chmod(file, 0o644)
  await page.clock.fastForward(30000)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), 'typed by accident')
  await page.locator('.toast').waitFor({ state: 'detached' })
})

test('text a program writes while autosave fills its copy stays, and autosave pauses', {
  timeout: 60000,
}, async (t) => {
  const { app, page, rich, pill, file } = await openNote(t)
  await app.evaluate((_, file) => {
    const promises = process.getBuiltinModule('node:fs/promises')
    const { writeFileSync } = process.getBuiltinModule('node:fs')
    const { open } = promises
    promises.open = async (...args) => {
      const handle = await open(...args)
      if (/\.note\.md\..*\.tmp$/.test(String(args[0])) && !globalThis.wrote) {
        globalThis.wrote = true
        writeFileSync(file, 'another program wrote this')
      }
      return handle
    }
    process.getBuiltinModule('node:module').syncBuiltinESMExports()
  }, file)
  await replaceRichText(page, rich, 'my words')
  await pill.getByText('Autosave · paused').waitFor()
  assert.equal(await app.evaluate(() => globalThis.wrote), true)
  assert.equal(await readFile(file, 'utf8'), 'another program wrote this')
})

test('a resting note gets its turn while another note is typed in', {
  timeout: 90000,
}, async (t) => {
  const { app, page, rich, file, profile } = await openNote(t, 'slow')
  const quick = join(profile, 'quick.md')
  await writeFile(quick, 'quick')
  const saved = async (path, text) => {
    const deadline = performance.now() + 8000
    while (performance.now() < deadline) {
      if ((await readFile(path, 'utf8')) === text) return true
      await delay(50)
    }
    return false
  }
  await app.evaluate(({ ipcMain, dialog }, quick) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [quick],
    })
    const save = ipcMain._invokeHandlers.get('document:autosave')
    let first = true
    ipcMain._invokeHandlers.set('document:autosave', async (...args) => {
      if (first) {
        first = false
        await new Promise((release) => {
          globalThis.releaseSlow = release
        })
      }
      return save(...args)
    })
  }, quick)
  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'quick.md',
  )
  await waitForDocumentEditor(app, page)
  await page.getByRole('tab', { name: 'note.md' }).click()
  await waitForDocumentEditor(app, page)
  await page.clock.install()
  await page.clock.pauseAt(Date.now() + 60000)
  await replaceRichText(page, rich, 'slow one')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'slow one',
  )
  await page.clock.runFor(2000)
  await waitForAsync(app, () => !!globalThis.releaseSlow)
  await page.clock.runFor(1000)
  await app.evaluate(() => globalThis.releaseSlow())
  assert.equal(await saved(file, 'slow one'), true)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  // Ten seconds of rest from here; the other note keeps saving meanwhile.
  await replaceRichText(page, rich, 'slow two')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'slow two',
  )
  await page.getByRole('tab', { name: 'quick.md' }).click()
  await page.clock.runFor(100)
  await waitForDocumentEditor(app, page)
  for (let turn = 1; turn <= 6; turn++) {
    await replaceRichText(page, rich, `quick ${turn}`)
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      `quick ${turn}`,
    )
    await page.clock.runFor(2500)
    await delay(100)
    await page.clock.runFor(2500)
    assert.equal(await saved(quick, `quick ${turn}`), true)
    if ((await readFile(file, 'utf8')) === 'slow two') return
  }
  assert.fail(`after 30 s: ${await readFile(file, 'utf8')}`)
})

test('an attempt that hung for an hour does not stop autosave for ten', {
  timeout: 60000,
}, async (t) => {
  const { app, page, rich, file } = await openNote(t)
  await app.evaluate(({ ipcMain }) => {
    const save = ipcMain._invokeHandlers.get('document:autosave')
    let first = true
    ipcMain._invokeHandlers.set('document:autosave', async (...args) => {
      if (first) {
        first = false
        await new Promise((release) => {
          globalThis.releaseHung = release
        })
      }
      return save(...args)
    })
  })
  await page.clock.install()
  await page.clock.pauseAt(Date.now() + 60000)
  const typed = async (text) => {
    await replaceRichText(page, rich, text)
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
  }
  await typed('during the hang')
  await page.clock.runFor(2000)
  await waitForAsync(app, () => !!globalThis.releaseHung)
  await page.clock.runFor(60 * 60 * 1000)
  await app.evaluate(() => globalThis.releaseHung())
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  await typed('after the hang')
  await page.clock.runFor(5 * 60 * 1000)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), 'after the hang')
})
