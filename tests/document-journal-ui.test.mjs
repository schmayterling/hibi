import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { crashAndReload, electron, stopElectronTree } from './electron.mjs'
import {
  testFormattedEngines as it,
  selectFormattedEngine,
} from './formatted-engine.mjs'
import { pressShortcut, replaceRichText } from './keyboard.mjs'

it('journal barriers preserve immediate saves, retries, renderer recovery, and native close', {
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
  await selectFormattedEngine(app, page, t.formattedEngine)
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
  await replaceRichText(page, editor(), 'first edit 😀')
  const saved = await page.evaluate(() => window.hibi.saveDocument(true))
  assert.equal(saved.saveReceipt, true)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'first edit 😀',
  )
  assert.equal(saved.contentVersion, 1)
  assert.equal(await readFile(file, 'utf8'), 'first edit 😀')
  await replaceRichText(page, editor(), 'recover this unsaved change')
  await page.evaluate(() => window.hibi.flushDocumentChanges())
  await crashAndReload(app)
  // Playwright keeps crashed targets marked as crashed after Electron reloads them.
  // Inspect the replacement renderer through Electron's live webContents instead.
  const recovered = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`
    new Promise(resolve => {
      const ready = () => {
        const element = document.querySelector('[aria-label="Document editor"][contenteditable="true"]');
        if (!element) { setTimeout(ready, 20); return; }
        resolve({ text: element.textContent });
      }; ready();
    })
  `),
  )
  assert.equal(recovered.text, 'recover this unsaved change')
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`
      const element = document.querySelector('[aria-label="Document editor"]')
      if (element.editor)
        element.editor.commands.setContent('native close must keep this final edit', { contentType: 'markdown' })
      else {
        const view = element.cmTile.root.view
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'native close must keep this final edit' }, userEvent: 'input.type' })
      }
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
  await selectFormattedEngine(app, page, 'tiptap')
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
  assert.equal(recovered.saved.saveReceipt, true)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'x'.repeat(140),
  )
  assert.equal(recovered.recovery.pendingCount, 0)
  assert.ok(
    await app.evaluate(() => globalThis.pressureFixture.verifications > 0),
  )
  assert.equal(await readFile(file, 'utf8'), 'x'.repeat(140))

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
  assert.equal(saved.saveReceipt, true)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    pressure.text,
  )
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
  assert.equal(resumed.saved.saveReceipt, true)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    resumed.text,
  )
  assert.equal(resumed.saved.contentVersion, saved.contentVersion + 1)
})

// Native CM inputs exercise the same preload/main journal without PM command
// transactions. Separate fixtures keep receipt recovery and capacity failures independent.
async function cmPressureFixture(t, loseOldestReceipt = false) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-cm-journal-pressure-'))
  const file = join(profile, 'note.md')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  const watchdog = setTimeout(() => {
    console.error('CM journal pressure fixture exceeded its watchdog')
    stopElectronTree(app.process())
  }, 55000)
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
        if (globalThis.cmPressure) {
          globalThis.cmPressure.block = false
          for (const resolve of globalThis.cmPressure.waiting) resolve()
          globalThis.cmPressure.waiting = []
        }
      })
      .catch(() => {})
    await app.close().catch(() => {})
    clearTimeout(watchdog)
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const rich = await selectFormattedEngine(app, page, 'codemirror')
  await app.evaluate(
    ({ dialog, ipcMain }, { file, loseOldestReceipt }) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
      dialog.showMessageBox = async () => ({ response: 1 })
      const append = ipcMain._invokeHandlers.get('document:append')
      const verify = ipcMain._invokeHandlers.get('document:verify-checkpoint')
      globalThis.cmPressure = { verifications: 0, block: false, waiting: [] }
      ipcMain.removeHandler('document:append')
      ipcMain.handle('document:append', async (...args) => {
        if (globalThis.cmPressure.block)
          await new Promise((resolve) =>
            globalThis.cmPressure.waiting.push(resolve),
          )
        const ack = await append(...args)
        if (loseOldestReceipt && args[1].contentVersion === 1)
          throw new Error('Lost oldest receipt')
        return ack
      })
      ipcMain.removeHandler('document:verify-checkpoint')
      ipcMain.handle('document:verify-checkpoint', (...args) => {
        globalThis.cmPressure.verifications++
        return verify(...args)
      })
    },
    { file, loseOldestReceipt },
  )
  return { app, page, rich, file }
}

test('codemirror J09: native inputs beyond the receipt horizon recover exact accepted text through a checkpoint', {
  timeout: 65000,
}, async (t) => {
  const { app, page, rich, file } = await cmPressureFixture(t, true)
  await rich.focus()
  for (let n = 0; n < 140; n++) await page.keyboard.insertText('x')
  assert.equal(
    await rich.evaluate((element) =>
      element.cmTile.root.view.state.doc.toString(),
    ),
    'x'.repeat(140),
  )
  const recovered = await page.evaluate(async () => {
    await window.hibi.flushDocumentChanges()
    return {
      saved: await window.hibi.saveDocument(true),
      recovery: window.hibi.getDocumentRecoveryState(),
    }
  })
  assert.equal(recovered.saved.contentVersion, 140)
  assert.equal(recovered.saved.saveReceipt, true)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'x'.repeat(140),
  )
  assert.equal(recovered.recovery.pendingCount, 0)
  assert.ok(await app.evaluate(() => globalThis.cmPressure.verifications > 0))
  assert.equal(await readFile(file, 'utf8'), 'x'.repeat(140))
  assert.equal(
    await rich.evaluate((element) => element === document.activeElement),
    true,
  )
})

test('codemirror J07: saturated native input preserves accepted source and history through drain, save and resumed editing', {
  timeout: 65000,
}, async (t) => {
  const { app, page, rich, file } = await cmPressureFixture(t)
  await rich.focus()
  await page.keyboard.insertText('x'.repeat(140))
  const baseline = await page.evaluate(async () => {
    await window.hibi.flushDocumentChanges()
    return window.hibi.saveDocument(true)
  })
  assert.equal(baseline.saveReceipt, true)
  await app.evaluate(() => {
    globalThis.cmPressure.block = true
  })
  await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    const update = view.update.bind(view)
    window.cmPressureObserved = 0
    window.cmPressureAccepted = []
    // Count committed native edits, after admission; rejected input must not update the view.
    view.update = (transactions) => {
      if (transactions.some((transaction) => transaction.docChanged)) {
        window.cmPressureObserved++
        window.cmPressureAccepted.push({
          character: transactions.at(-1).state.doc.sliceString(0, 1),
        })
      }
      return update(transactions)
    }
  })
  for (let n = 0; n < 12; n++) {
    await rich.press('ControlOrMeta+a')
    await page.keyboard.insertText(String.fromCharCode(65 + n).repeat(240000))
  }
  const pressure = await rich.evaluate((element) => ({
    observed: window.cmPressureObserved,
    accepted: window.cmPressureAccepted,
    text: element.cmTile.root.view.state.doc.toString(),
    recovery: window.hibi.getDocumentRecoveryState(),
  }))
  await t.test(
    'admission bounds accepted edits before source, view and history can advance again',
    () => {
      assert.ok(pressure.observed > 0 && pressure.observed < 12)
      assert.match(pressure.recovery.status, /pending|failed/)
      assert.equal(pressure.recovery.pendingCount, pressure.observed)
      assert.ok(pressure.recovery.pendingBytes < 8 * 1024 * 1024)
      assert.ok(pressure.recovery.inFlightBytes < 8 * 1024 * 1024)
      assert.equal(pressure.text.length, 240000)
      assert.equal(pressure.accepted.length, pressure.observed)
      assert.equal(
        pressure.text,
        pressure.accepted.at(-1)?.character.repeat(240000),
      )
    },
  )
  await t.test('the user sees that recovery is full', async () => {
    await page
      .getByText(/Document recovery is full/)
      .first()
      .waitFor()
  })
  // Drain even if an admission or notice assertion failed, so later recovery contracts run.
  await app.evaluate(() => {
    globalThis.cmPressure.block = false
    for (const resolve of globalThis.cmPressure.waiting) resolve()
    globalThis.cmPressure.waiting = []
  })
  const saved = await page.evaluate(async () => {
    await window.hibi.flushDocumentChanges()
    return window.hibi.saveDocument(false)
  })
  await t.test(
    'draining saves exactly the accepted source and content version',
    async () => {
      assert.equal(saved.saveReceipt, true)
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).markdown,
        pressure.text,
      )
      assert.equal(
        saved.contentVersion,
        baseline.contentVersion + pressure.observed,
      )
      assert.equal(await readFile(file, 'utf8'), pressure.text)
      assert.equal(
        await rich.evaluate((element) =>
          element.cmTile.root.view.state.doc.toString(),
        ),
        pressure.text,
      )
      assert.equal(
        await page.evaluate(
          () => window.hibi.getDocumentRecoveryState().pendingCount,
        ),
        0,
      )
    },
  )
  await page.evaluate(() => new Promise(requestAnimationFrame))
  await t.test('recovery restores native editability and focus', async () => {
    assert.equal(await rich.getAttribute('contenteditable'), 'true')
    assert.equal(
      await rich.evaluate((element) => element === document.activeElement),
      true,
    )
  })
  await t.test('native undo and redo retain only accepted source', async () => {
    await pressShortcut(
      app,
      process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
    )
    const undone = await page.evaluate(async () => {
      await window.hibi.flushDocumentChanges()
      return (await window.hibi.getDocument()).markdown
    })
    const previous =
      pressure.accepted.at(-2)?.character.repeat(240000) ?? 'x'.repeat(140)
    assert.equal(
      undone,
      previous,
      'rejected native inputs must not create undo steps',
    )
    await pressShortcut(
      app,
      process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y',
    )
    await page.evaluate(() => window.hibi.flushDocumentChanges())
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      pressure.text,
    )
  })
  await t.test(
    'native editing resumes with the next accepted content version',
    async () => {
      const before = await page.evaluate(() => window.hibi.getDocument())
      await rich.press(
        process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
      )
      await page.keyboard.insertText('z')
      const resumed = await page.evaluate(async () => {
        await window.hibi.flushDocumentChanges()
        return {
          document: await window.hibi.getDocument(),
          saved: await window.hibi.saveDocument(false),
        }
      })
      assert.equal(resumed.document.markdown, `${pressure.text}z`)
      assert.equal(
        await rich.evaluate((element) =>
          element.cmTile.root.view.state.doc.toString(),
        ),
        `${pressure.text}z`,
      )
      assert.equal(resumed.saved.saveReceipt, true)
      assert.equal(resumed.saved.contentVersion, before.contentVersion + 1)
      assert.equal(await readFile(file, 'utf8'), `${pressure.text}z`)
    },
  )
})
