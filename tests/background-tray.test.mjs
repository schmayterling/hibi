import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  crashAndReload,
  electron,
  stopElectronTree,
  waitForDocumentEditor,
  waitForElectronShutdown,
} from './electron.mjs'
import { clickMenu, replaceRichText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

async function launch(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-background-tray-'))
  const profile = join(root, 'profile')
  const secondaryProcesses = []
  let app, child
  t.after(async () => {
    try {
      for (const { child, closed } of secondaryProcesses) {
        stopElectronTree(child)
        await closed
      }
      if (app && child.exitCode === null && child.signalCode === null) {
        await app.evaluate(async ({ dialog }) => {
          dialog.showMessageBox = async () => ({ response: 1 })
          globalThis.backgroundTestDialogResolve?.({ response: 1 })
          await new Promise((resolve) => setImmediate(resolve))
        })
        await app.close()
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        stopElectronTree(child)
        await exited
      }
      await rm(root, { recursive: true, force: true })
    }
  })
  app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  child = app.process()
  await app.evaluate(({ Tray, dialog }) => {
    globalThis.backgroundTestTray = null
    globalThis.backgroundTestMenu = null
    globalThis.backgroundTestDialogs = []
    const setContextMenu = Tray.prototype.setContextMenu
    Tray.prototype.setContextMenu = function (menu) {
      globalThis.backgroundTestTray = this
      globalThis.backgroundTestMenu = menu
      return setContextMenu.call(this, menu)
    }
    dialog.showMessageBox = async (_window, options) => {
      globalThis.backgroundTestDialogs.push(options)
      return { response: 1 }
    }
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  const id = await app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().startsWith('app://hibi/'),
      ).id,
  )
  await app.evaluate(({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id)
    globalThis.backgroundTestWindow = window
    globalThis.backgroundTestContents = window.webContents
  }, id)
  return { app, child, page, root, profile, id, secondaryProcesses }
}

async function windowState(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const window = globalThis.backgroundTestWindow
    return {
      id: window.id,
      contentsId: window.webContents.id,
      sameWindow: BrowserWindow.fromId(window.id) === window,
      sameContents: window.webContents === globalThis.backgroundTestContents,
      visible: window.isVisible(),
      destroyed: window.isDestroyed(),
    }
  })
}

async function closeMain(app) {
  await app.evaluate(() => globalThis.backgroundTestWindow.close())
}

async function trayClick(app, label) {
  await app.evaluate((_, label) => {
    const item = globalThis.backgroundTestMenu.items.find(
      (item) => item.label.toLowerCase() === label.toLowerCase(),
    )
    if (!item?.enabled) throw new Error(`Tray item unavailable: ${label}`)
    item.click()
  }, label)
}

async function waitVisible(app, visible) {
  await waitForAsync(
    app,
    (_, expected) => globalThis.backgroundTestWindow.isVisible() === expected,
    visible,
  )
}

async function holdDialogs(app) {
  await app.evaluate(({ dialog }) => {
    globalThis.backgroundTestDialogs = []
    dialog.showMessageBox = (window, options) => {
      globalThis.backgroundTestDialogs.push({
        message: options.message,
        buttons: options.buttons,
        windowId: window.id,
        visible: window.isVisible(),
      })
      return new Promise((resolve) => {
        globalThis.backgroundTestDialogResolve = resolve
      })
    }
  })
}

async function answerDialog(app, response) {
  await app.evaluate(async (_, response) => {
    const resolve = globalThis.backgroundTestDialogResolve
    globalThis.backgroundTestDialogResolve = null
    resolve({ response })
    await new Promise((resolve) => setImmediate(resolve))
  }, response)
}

async function assertWindowsQuitAccelerator(app, expected) {
  if (process.platform !== 'win32') return
  assert.equal(
    await app.evaluate(({ Menu }) => {
      const quit = Menu.getApplicationMenu()
        .items.flatMap((item) => item.submenu?.items ?? [])
        .find((item) => item.role === 'quit')
      if (!quit) throw new Error('Quit role unavailable')
      return quit.accelerator ?? null
    }),
    expected,
  )
}

async function quitFromTray(app, child) {
  const exited = waitForElectronShutdown(child, app.waitForEvent('close'))
  await trayClick(app, 'Quit')
  await exited
  assert.equal(child.exitCode, 0)
}

test('background defaults off and closing retains the platform lifecycle', {
  timeout: 30000,
}, async (t) => {
  const { app, child, page } = await launch(t)
  assert.equal(
    await page.evaluate(() => window.hibi.getBackgroundMode()),
    false,
  )
  assert.equal(await app.evaluate(() => globalThis.backgroundTestTray), null)
  await assertWindowsQuitAccelerator(app, null)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^about$/i }).click()
  const about = page.getByRole('tabpanel', { name: /^about$/i })
  await about.getByRole('heading', { name: /^general$/i }).waitFor()
  const checkbox = about.getByRole('checkbox', {
    name: /keep hibi running in the background/i,
  })
  assert.equal(await checkbox.isChecked(), false)
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await app.evaluate(() => globalThis.backgroundTestWindow.showInactive())
  if (process.platform === 'darwin') {
    const closed = page.waitForEvent('close')
    await closeMain(app)
    await closed
    assert.equal(page.isClosed(), true)
    assert.equal(child.exitCode, null)
    assert.equal(
      await app.evaluate(() => globalThis.backgroundTestWindow.isDestroyed()),
      true,
    )
    assert.equal(await app.evaluate(() => globalThis.backgroundTestTray), null)
  } else {
    const exited = waitForElectronShutdown(child, app.waitForEvent('close'))
    await closeMain(app)
    await exited
    assert.equal(child.exitCode, 0)
  }
})

test('tray preserves drafts, restores the same renderer and cancels unsafe quits', {
  timeout: 45000,
}, async (t) => {
  const { app, child, page, root, profile, id, secondaryProcesses } =
    await launch(t)
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await replaceRichText(page, rich, 'unsaved tray draft')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'unsaved tray draft',
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^about$/i }).click()
  const checkbox = page.getByRole('checkbox', {
    name: /keep hibi running in the background/i,
  })
  await checkbox.click()
  await waitForAsync(page, async () => window.hibi.getBackgroundMode())
  await assertWindowsQuitAccelerator(app, 'CmdOrCtrl+Q')
  assert.equal(await readFile(join(profile, 'background.json'), 'utf8'), 'true')
  assert.equal(
    await app.evaluate(
      ({ Tray, Menu }) =>
        globalThis.backgroundTestTray instanceof Tray &&
        !globalThis.backgroundTestTray.isDestroyed() &&
        globalThis.backgroundTestMenu instanceof Menu,
    ),
    true,
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await app.evaluate(() => globalThis.backgroundTestWindow.showInactive())
  const original = await windowState(app)
  await closeMain(app)
  await waitVisible(app, false)
  assert.deepEqual(await windowState(app), { ...original, visible: false })
  assert.deepEqual(
    await app.evaluate(() => globalThis.backgroundTestDialogs),
    [],
  )
  assert.equal(await rich.innerText(), 'unsaved tray draft')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).dirty,
    true,
  )
  await trayClick(app, 'Open Hibi')
  await waitVisible(app, true)
  assert.deepEqual(await windowState(app), original)
  assert.equal(await rich.innerText(), 'unsaved tray draft')

  await closeMain(app)
  await trayClick(app, 'Settings')
  await waitVisible(app, true)
  const about = page.getByRole('tabpanel', { name: /^about$/i })
  await about.getByRole('heading', { name: /^general$/i }).waitFor()
  await page.getByRole('tab', { name: /^editor$/i, exact: true }).click()
  await trayClick(app, 'Settings')
  await about.waitFor()
  await trayClick(app, 'Settings')
  await about.waitFor()
  assert.equal(
    await page.getByRole('main', { name: /^settings$/i }).isVisible(),
    true,
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()

  await closeMain(app)
  await waitVisible(app, false)
  const executable = await app.evaluate(() => process.execPath)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const secondary = spawn(
    executable,
    [
      resolve('.'),
      `--user-data-dir=${profile}`,
      '--hibi-test',
      ...child.spawnargs.filter((argument) => argument === '--no-sandbox'),
    ],
    {
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    },
  )
  let secondaryErrors = ''
  secondary.stderr.setEncoding('utf8').on('data', (chunk) => {
    secondaryErrors = (secondaryErrors + chunk).slice(-4096)
  })
  const secondaryClosed = once(secondary, 'close')
  secondaryProcesses.push({ child: secondary, closed: secondaryClosed })
  try {
    await waitForElectronShutdown(secondary, secondaryClosed)
  } catch (error) {
    if (secondaryErrors) t.diagnostic(secondaryErrors)
    throw error
  }
  assert.equal(secondary.exitCode, 0)
  await waitVisible(app, true)
  assert.deepEqual(await windowState(app), original)
  assert.equal(await rich.innerText(), 'unsaved tray draft')

  await holdDialogs(app)
  await closeMain(app)
  await trayClick(app, 'Quit')
  await waitForAsync(app, () => globalThis.backgroundTestDialogs.length === 1)
  assert.deepEqual(
    await app.evaluate(() => globalThis.backgroundTestDialogs[0]),
    {
      message: 'Save changes to untitled.md?',
      buttons: ['Save', 'Don’t save', 'Cancel'],
      windowId: id,
      visible: true,
    },
  )
  assert.equal((await windowState(app)).visible, true)
  await answerDialog(app, 2)
  assert.equal(child.exitCode, null)
  await closeMain(app)
  await waitVisible(app, false)
  assert.equal(
    await app.evaluate(() => globalThis.backgroundTestDialogs.length),
    1,
  )
  assert.equal(await rich.innerText(), 'unsaved tray draft')

  const file = join(root, 'saved.md')
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, file)
  assert.ok(await page.evaluate(() => window.hibi.saveDocument(false)))
  assert.equal(await readFile(file, 'utf8'), 'unsaved tray draft')
  await trayClick(app, 'Open Hibi')
  await replaceRichText(page, rich, 'keep this draft')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'keep this draft',
  )
  await writeFile(file, 'external change')
  await holdDialogs(app)
  await closeMain(app)
  await trayClick(app, 'Quit')
  await waitForAsync(app, () => globalThis.backgroundTestDialogs.length === 1)
  await answerDialog(app, 0)
  await waitForAsync(app, () => globalThis.backgroundTestDialogs.length === 2)
  assert.deepEqual(
    await app.evaluate(() => globalThis.backgroundTestDialogs[1]),
    {
      message: 'This file changed outside Hibi.',
      buttons: ['Replace', 'Cancel'],
      windowId: id,
      visible: true,
    },
  )
  await answerDialog(app, 1)
  assert.equal(await readFile(file, 'utf8'), 'external change')
  const draft = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(draft.markdown, 'keep this draft')
  assert.equal(draft.dirty, true)
  assert.equal(await rich.innerText(), 'keep this draft')
  assert.equal(child.exitCode, null)
  await closeMain(app)
  await waitVisible(app, false)
  assert.deepEqual(await windowState(app), { ...original, visible: false })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  await quitFromTray(app, child)
  assert.equal(await readFile(file, 'utf8'), 'external change')
})

test('a tray click opens the main window on Windows and Linux', {
  timeout: 30000,
}, async (t) => {
  if (process.platform === 'darwin')
    return t.skip('macOS opens the menu on click')
  const { app, child, page } = await launch(t)
  await page.evaluate(() => window.hibi.setBackgroundMode(true))
  await closeMain(app)
  await waitVisible(app, false)
  await app.evaluate(() => globalThis.backgroundTestTray.emit('click'))
  await waitVisible(app, true)
  await quitFromTray(app, child)
})

test('tray quick note follows UI registration and opens capture without the main window', {
  timeout: 30000,
}, async (t) => {
  const { app, page } = await launch(t)
  const captureHasHotkey = () =>
    page.evaluate(async () =>
      (await window.hibi.getAddonHotkeys()).some(
        (item) => item.id === 'quick-note.capture',
      ),
    )
  assert.equal(await captureHasHotkey(), false)
  assert.equal(
    await page.evaluate(() => window.hibi.setBackgroundMode(true)),
    true,
  )
  await assertWindowsQuitAccelerator(app, 'CmdOrCtrl+Q')
  assert.equal(
    await app.evaluate(() =>
      globalThis.backgroundTestMenu.items.some(
        (item) => item.label.toLowerCase() === 'new quick note',
      ),
    ),
    false,
  )
  await page.evaluate(() => {
    window.backgroundTestCommands = []
    window.backgroundTestStopCommands = window.hibi.onAddonCommand(
      (command) => {
        window.backgroundTestCommands.push(command)
      },
    )
  })
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i }).click()
  const checkbox = page.locator('#addon-quick-note')
  assert.equal(await checkbox.isChecked(), false)
  await checkbox.click()
  await waitForAsync(app, () =>
    globalThis.backgroundTestMenu.items.some(
      (item) => item.label.toLowerCase() === 'new quick note',
    ),
  )
  assert.equal(await captureHasHotkey(), false)
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await app.evaluate(() => globalThis.backgroundTestWindow.showInactive())
  const original = await windowState(app)
  await closeMain(app)
  await waitVisible(app, false)
  await trayClick(app, 'New quick note')
  await waitForAsync(page, () => window.backgroundTestCommands.length === 1)
  const [command] = await page.evaluate(() => window.backgroundTestCommands)
  assert.equal(command.id, 'quick-note.capture')
  assert.equal(command.source, 'menu')
  assert.equal(await captureHasHotkey(), false)
  assert.equal(typeof command.token, 'string')
  assert.notEqual(command.token, '')
  // The capture opens in its own window and the main window stays hidden.
  await waitForAsync(app, ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((window) =>
      window.webContents.getURL().endsWith('/addon-window.html'),
    ),
  )
  assert.deepEqual(await windowState(app), { ...original, visible: false })
  await trayClick(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i }).click()
  await checkbox.click()
  await waitForAsync(
    app,
    () =>
      !globalThis.backgroundTestMenu.items.some(
        (item) => item.label.toLowerCase() === 'new quick note',
      ),
  )
  assert.equal(await captureHasHotkey(), false)
  assert.equal(await page.evaluate(() => window.hibi.getBackgroundMode()), true)
  await page.evaluate(() => window.backgroundTestStopCommands())
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await waitForDocumentEditor(app, page)
  await t.test(
    'runnable commands preserve native menu identity and hotkey subscribers',
    async () => {
      await app.evaluate(({ Menu }) => {
        globalThis.backgroundTestOriginalMenu = Menu.getApplicationMenu()
      })
      const changes = await page.evaluate(async () => {
        let changes = 0
        const stop = window.hibi.onAddonHotkeysChanged(() => changes++)
        try {
          await window.hibi.registerAddonHotkey({
            id: 'test.runnable',
            label: 'Runnable',
            token: 'runnable-test',
            runnableOnly: true,
          })
          await window.hibi.unregisterAddonHotkey(
            'test.runnable',
            'runnable-test',
          )
          return changes
        } finally {
          stop()
        }
      })
      assert.equal(changes, 0)
      assert.equal(
        await app.evaluate(
          ({ Menu }) =>
            Menu.getApplicationMenu() === globalThis.backgroundTestOriginalMenu,
        ),
        true,
      )
    },
  )
  await t.test('tray Settings survives a renderer reload', async () => {
    await closeMain(app)
    await waitVisible(app, false)
    await app.evaluate(async () => {
      const contents = globalThis.backgroundTestContents
      globalThis.backgroundTestReloadSettings = false
      contents.once('did-start-loading', () => {
        const settings = globalThis.backgroundTestMenu.items.find(
          (item) => item.label.toLowerCase() === 'settings',
        )
        settings.click()
        globalThis.backgroundTestReloadSettings = true
      })
      const loaded = new Promise((resolve) =>
        contents.once('did-finish-load', resolve),
      )
      contents.reload()
      await loaded
    })
    assert.equal(
      await app.evaluate(() => globalThis.backgroundTestReloadSettings),
      true,
    )
    const about = page.getByRole('tabpanel', { name: /^about$/i })
    await about.getByRole('heading', { name: /^general$/i }).waitFor()
    assert.equal(
      await about
        .getByRole('checkbox', {
          name: /keep hibi running in the background/i,
        })
        .isChecked(),
      true,
    )
    assert.deepEqual(await windowState(app), original)
    await trayClick(app, 'Settings')
    await about.waitFor()
  })
  assert.equal(
    await page.evaluate(() => window.hibi.setBackgroundMode(false)),
    false,
  )
  assert.equal(
    await app.evaluate(() => globalThis.backgroundTestTray.isDestroyed()),
    true,
  )
  await assertWindowsQuitAccelerator(app, null)
})

test('hidden renderer crash shows recovery and clean tray quit stays hidden', {
  timeout: 30000,
}, async (t) => {
  const { app, child, page, root } = await launch(t)
  assert.equal(
    await page.evaluate(() => window.hibi.setBackgroundMode(true)),
    true,
  )
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await replaceRichText(page, rich, 'recover hidden draft')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'recover hidden draft',
  )
  await app.evaluate(() => {
    const window = globalThis.backgroundTestWindow
    window.showInactive()
    globalThis.backgroundTestCrashShown = false
    // Hidden local test windows emit no show event; record recovery's call.
    for (const name of ['show', 'showInactive']) {
      const show = window[name].bind(window)
      window[name] = () => {
        globalThis.backgroundTestCrashShown = true
        return show()
      }
    }
  })
  const original = await windowState(app)
  await closeMain(app)
  await waitVisible(app, false)
  await crashAndReload(app)
  await waitForAsync(app, () =>
    globalThis.backgroundTestContents.executeJavaScript(
      `!!document.querySelector('.app[aria-busy="false"] #document-editor-panel[aria-busy="false"] .tiptap[contenteditable="true"]')`,
    ),
  )
  await waitVisible(app, true)
  assert.equal(
    await app.evaluate(() => globalThis.backgroundTestCrashShown),
    true,
  )
  assert.deepEqual(await windowState(app), original)
  assert.equal(
    await app.evaluate(() =>
      globalThis.backgroundTestContents.executeJavaScript(
        "document.querySelector('.tiptap').textContent",
      ),
    ),
    'recover hidden draft',
  )
  const recovered = await app.evaluate(() =>
    globalThis.backgroundTestContents.executeJavaScript(
      'window.hibi.getDocument()',
    ),
  )
  assert.equal(recovered.markdown, 'recover hidden draft')
  assert.equal(recovered.dirty, true)
  await app.evaluate(() =>
    globalThis.backgroundTestContents.executeJavaScript(
      `document.querySelector('.tiptap').editor.commands.setContent('<p></p>')`,
    ),
  )
  await waitForAsync(
    app,
    async () =>
      !(
        await globalThis.backgroundTestContents.executeJavaScript(
          'window.hibi.getDocument()',
        )
      ).dirty,
  )
  const visibility = join(root, 'clean-quit-visibility.txt')
  await writeFile(visibility, 'hidden')
  await app.evaluate((_, path) => {
    globalThis.backgroundTestWindow.on('show', () => {
      process.getBuiltinModule('fs').writeFileSync(path, 'shown')
    })
  }, visibility)
  await closeMain(app)
  await waitVisible(app, false)
  await quitFromTray(app, child)
  assert.equal(await readFile(visibility, 'utf8'), 'hidden')
})
