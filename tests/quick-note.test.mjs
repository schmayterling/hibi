import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { electron, showTestWindows, stopElectronTree } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const captureUrl = /\/addon-window\.html$/
const formattedEngines = new WeakMap()

async function captureWindow(app) {
  const deadline = performance.now() + 10000
  for (;;) {
    const page = app.windows().find((item) => captureUrl.test(item.url()))
    if (page) {
      // Test runs never reveal windows themselves, and CI's launcher shows a window
      // only on its first ready-to-show. A kept-alive capture window reopened in CI
      // would stay hidden, and Linux stops painting hidden windows.
      if (showTestWindows)
        await app.evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows())
            if (
              !window.isDestroyed() &&
              window.webContents.getURL().endsWith('/addon-window.html') &&
              !window.isVisible()
            ) {
              window.setFocusable(true)
              window.show()
              window.focus()
            }
        })
      const editor = page.locator(
        formattedEngines.get(app) === 'tiptap'
          ? '.tiptap[contenteditable="true"]'
          : '.hibi-formatted .cm-content[contenteditable="true"]',
      )
      await page
        .getByRole('textbox', { name: 'Document editor', exact: true })
        .and(editor)
        .waitFor({ timeout: 7000 })
      assert.equal(
        await editor.count(),
        1,
        'quick note uses the selected formatted engine',
      )
      return page
    }
    if (performance.now() > deadline)
      throw new Error('The quick note window did not open.')
    await setTimeout(30)
  }
}

async function openCapture(app, page) {
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Quick note: capture')
  await page.getByRole('option', { name: /Quick note: capture/i }).click()
  return captureWindow(app)
}

// The capture window stays alive hidden, so count hides instead of closes.
const trackCaptureHides = (app) =>
  app.evaluate(({ app }) => {
    globalThis.captureHides = 0
    app.on('browser-window-created', (_event, window) => {
      const hide = window.hide.bind(window)
      window.hide = () => {
        globalThis.captureHides++
        return hide()
      }
    })
  })
const captureHides = (app) => app.evaluate(() => globalThis.captureHides)
async function hidden(app, before) {
  while ((await captureHides(app)) <= before) await setTimeout(30)
}

/** Click, or explain why the target never became clickable. */
async function click(locator, what) {
  try {
    await locator.click({ timeout: 15000 })
  } catch (error) {
    const why = await locator
      .evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const top = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + Math.min(rect.height / 2, 12),
        )
        return {
          visibility: document.visibilityState,
          focused: document.hasFocus(),
          rect: [rect.x, rect.y, rect.width, rect.height].map(Math.round),
          inert: !!element.closest('[inert]'),
          coveredBy:
            top && !element.contains(top) ? top.outerHTML.slice(0, 160) : null,
        }
      })
      .catch((reason) => String(reason))
    throw new Error(`${what} is not clickable: ${JSON.stringify(why)}`, {
      cause: error,
    })
  }
}

/** Replace the note with Markdown typed line by line. */
async function writeNote(capture, ...lines) {
  const editor = capture.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await click(editor, 'The capture window editor')
  await capture.keyboard.press('ControlOrMeta+a')
  await capture.keyboard.press('Backspace')
  for (const [index, line] of lines.entries()) {
    if (index) await capture.keyboard.press('Enter')
    await capture.keyboard.type(line)
  }
}

async function until(check) {
  const deadline = performance.now() + 10000
  for (;;) {
    const value = await check()
    if (value) return value
    if (performance.now() > deadline)
      throw new Error(`Condition did not settle: ${check}`)
    await setTimeout(30)
  }
}

/** The full destination path, compared as text so Windows paths need no escaping. */
const destinationTooltip = (capture) =>
  capture
    .locator('.quick-note-meta [data-tooltip]')
    .getAttribute('data-tooltip')

const readDraft = (profile) =>
  readFile(join(profile, 'quick-note-draft.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => null)

const noteText = (capture) =>
  capture
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .evaluate((element) =>
      element.cmTile?.root.view.state.doc.length === 0
        ? ''
        : element.innerText.trim(),
    )

/** A workspace and profile shared by one or more launches, cleaned up together. */
async function harness(t, { draft, draftFile } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-quick-note-'))
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  await mkdir(workspace, { recursive: true })
  await mkdir(profile)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'quick-note': true }),
  )
  if (draft !== undefined)
    await writeFile(
      join(profile, 'quick-note-draft.json'),
      JSON.stringify({ markdown: draft, destination: null }),
    )
  if (draftFile !== undefined)
    await writeFile(join(profile, 'quick-note-draft.json'), draftFile)
  const apps = []
  t.after(async () => {
    // Playwright drops a killed app's handle, so use the child captured at launch.
    for (const { app, child } of apps) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      await app
        .evaluate(({ dialog }) => {
          dialog.showMessageBox = async () => ({ response: 1 })
        })
        .catch(() => {})
      await app.close()
    }
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    workspace,
    profile,
    async launch() {
      const app = await electron.launch({
        args: [resolve('.'), `--user-data-dir=${profile}`],
      })
      apps.push({ app, child: app.process() })
      await trackCaptureHides(app)
      await app.evaluate(({ dialog }, destination) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [destination],
        })
      }, workspace)
      const page = await app.firstWindow()
      await selectFormattedEngine(app, page, t.formattedEngine)
      formattedEngines.set(app, t.formattedEngine)
      await page.getByRole('textbox', { name: /document editor/i }).waitFor()
      await page.evaluate(() => window.hibi.openWorkspace())
      return { app, page }
    },
  }
}

// Hold a named main-process step until `resume(app, name)`.
const pause = (app, name) =>
  app.evaluate((_electron, name) => {
    globalThis.hibiTestPauses ??= {}
    globalThis.hibiTestResume ??= {}
    globalThis.hibiTestPauses[name] = new Promise((resolve) => {
      globalThis.hibiTestResume[name] = resolve
    })
  }, name)
const resume = (app, name) =>
  app.evaluate((_electron, name) => {
    delete globalThis.hibiTestPauses[name]
    globalThis.hibiTestResume[name]()
  }, name)

async function saveCapture(app, capture, name) {
  const before = await captureHides(app)
  await click(
    capture.getByRole('button', { name: 'Save', exact: true }),
    'The capture window Save button',
  )
  await capture.getByRole('status').getByText(`Saved ${name}.`).waitFor()
  await hidden(app, before)
}

// Windows being destroyed have no URL to read; skip them.
const appWindows = (app) =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter(
        (window) => !window.isDestroyed() && !window.webContents.isDestroyed(),
      )
      .map((window) => window.webContents.getURL() ?? '')
      .filter((url) => !url.startsWith('hibi-analysis:')),
  )

// Count every call that could raise or focus the main window.
const watchMainWindow = (app) =>
  app.evaluate(({ BrowserWindow }, showWindows) => {
    const main = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === 'app://hibi/',
    )
    globalThis.mainWindowRaised = 0
    for (const name of [
      'show',
      'showInactive',
      'focus',
      'restore',
      'moveTop',
    ]) {
      const original = main[name].bind(main)
      main[name] = (...args) => {
        globalThis.mainWindowRaised++
        if (showWindows) return original(...args)
      }
    }
  }, showTestWindows)
const mainWindowRaised = (app) =>
  app.evaluate(() => globalThis.mainWindowRaised)

test('quick note captures to a chosen folder without replacing files', {
  timeout: 45000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-quick-note-'))
  const workspace = join(root, 'workspace')
  const folder = join(workspace, 'Notes')
  const profile = join(root, 'profile')
  await mkdir(folder, { recursive: true })
  await mkdir(profile)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'quick-note': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  await trackCaptureHides(app)
  await app.evaluate(({ dialog }, destination) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [destination],
    })
  }, workspace)
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine)
  formattedEngines.set(app, t.formattedEngine)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page.evaluate(() => window.hibi.openWorkspace())
  await watchMainWindow(app)
  const defaultCapture = await openCapture(app, page)
  await defaultCapture.getByText('workspace', { exact: true }).waitFor()
  const urls = await appWindows(app)
  assert.equal(urls.length, 2)
  assert.equal(urls.filter((url) => captureUrl.test(url)).length, 1)
  assert.equal(await defaultCapture.locator('.editor-toolbar').count(), 1)
  await writeNote(defaultCapture, 'Default thought')
  await saveCapture(app, defaultCapture, 'Quick note.md')
  assert.equal(
    await readFile(join(workspace, 'Quick note.md'), 'utf8'),
    'Default thought',
  )
  assert.equal(await mainWindowRaised(app), 0)
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Quick note settings')
  await page.getByRole('option', { name: /Quick note settings/i }).click()
  await page.getByLabel('Folder', { exact: true }).selectOption('Notes')
  await page.getByLabel('Ask for a title').check()
  await page.getByLabel('Default title').fill('Draft')
  await page.getByLabel('Global shortcut').fill('')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await page
    .getByRole('status')
    .getByText('Quick note settings saved.')
    .waitFor()
  const dialog = await openCapture(app, page)
  // Ask for a title starts the note with the default title as its heading.
  await dialog
    .getByRole('heading', { level: 1, name: 'Draft', exact: true })
    .waitFor()
  await writeNote(dialog, '# Daily', 'First thought')
  await saveCapture(app, dialog, 'Daily.md')
  assert.equal(
    await readFile(join(folder, 'Daily.md'), 'utf8'),
    '# Daily\n\nFirst thought',
  )

  const request = {
    workspaceId: '',
    folder: 'Notes',
    title: 'Daily',
    markdown: 'Second thought',
  }
  const second = await page.evaluate(
    (input) => window.hibi.invokeAddon('quick-note', 'save', input),
    request,
  )
  assert.equal(second.name, 'Daily 2.md')
  assert.equal(
    await readFile(join(folder, 'Daily.md'), 'utf8'),
    '# Daily\n\nFirst thought',
  )
  assert.equal(
    await readFile(join(folder, 'Daily 2.md'), 'utf8'),
    'Second thought',
  )
  await assert.rejects(
    page.evaluate(
      (input) =>
        window.hibi.invokeAddon('quick-note', 'save', {
          ...input,
          folder: '../outside',
        }),
      request,
    ),
    /file or folder name|folder inside/,
  )

  const other = join(root, 'other')
  await mkdir(join(other, 'Inbox'), { recursive: true })
  await app.evaluate(({ dialog }, destination) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [destination],
    })
  }, other)
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Quick note settings')
  await page.getByRole('option', { name: /Quick note settings/i }).click()
  const settings = page.getByRole('tabpanel', { name: 'Quick note' })
  await settings.getByRole('button', { name: 'Choose workspace…' }).click()
  const recent = await page.evaluate(() => window.hibi.getRecentWorkspaces())
  const otherPath = await realpath(other)
  const otherId = recent.find((entry) => entry.path === otherPath)?.id
  assert.ok(otherId)
  await page.waitForFunction(
    (id) => document.querySelector('#quick-note-workspace')?.value === id,
    otherId,
  )
  assert.equal(
    await settings.getByLabel('Workspace', { exact: true }).inputValue(),
    otherId,
  )
  await settings.getByLabel('Folder', { exact: true }).selectOption('Inbox')
  await page.getByRole('button', { name: 'Save settings' }).click()
  const secondDialog = await openCapture(app, page)
  await writeNote(secondDialog, '# Elsewhere', 'Another workspace')
  await saveCapture(app, secondDialog, 'Elsewhere.md')
  assert.equal(
    await readFile(join(other, 'Inbox', 'Elsewhere.md'), 'utf8'),
    '# Elsewhere\n\nAnother workspace',
  )

  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Quick note settings')
  await page.getByRole('option', { name: /Quick note settings/i }).click()
  await page
    .getByRole('tabpanel', { name: 'Quick note' })
    .getByLabel('Workspace', { exact: true })
    .selectOption('')
  await page.getByRole('button', { name: 'Save settings' }).click()
  const currentDialog = await openCapture(app, page)
  const workspacePath = await realpath(workspace)
  await until(
    async () => (await destinationTooltip(currentDialog)) === workspacePath,
  )
  await writeNote(currentDialog, '# Current', 'Saved where the settings point')
  await app.evaluate(({ dialog }, destination) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [destination],
    })
  }, other)
  const switched = await page.evaluate(() => window.hibi.openWorkspace())
  assert.equal(switched?.id, otherId)
  // A note saves to the destination set when it is saved: now the other workspace.
  await saveCapture(app, currentDialog, 'Current.md')
  assert.equal(
    await readFile(join(other, 'Current.md'), 'utf8'),
    '# Current\n\nSaved where the settings point',
  )
  await assert.rejects(readFile(join(workspace, 'Current.md'), 'utf8'), {
    code: 'ENOENT',
  })

  const originalPath = await realpath(workspace)
  const originalId = (
    await page.evaluate(() => window.hibi.getRecentWorkspaces())
  ).find((item) => item.path === originalPath)?.id
  assert.ok(originalId)
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Quick note settings')
  await page.getByRole('option', { name: /Quick note settings/i }).click()
  await page
    .getByRole('tabpanel', { name: 'Quick note' })
    .getByLabel('Workspace', { exact: true })
    .selectOption(originalId)
  await page.getByRole('button', { name: 'Save settings' }).click()
  await page.getByRole('button', { name: 'Back to app' }).click()
  let lastChosen
  for (let number = 0; number < 6; number++) {
    const destination = join(root, `later-${number}`)
    await mkdir(destination)
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, destination)
    lastChosen = await page.evaluate(() =>
      window.hibi.invokeAddon('quick-note', 'chooseWorkspace'),
    )
  }
  assert.equal(
    (await page.evaluate(() => window.hibi.getRecentWorkspaces())).some(
      (item) => item.id === originalId,
    ),
    false,
  )
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Quick note settings')
  await page.getByRole('option', { name: /Quick note settings/i }).click()
  const oldSettings = page.getByRole('tabpanel', { name: 'Quick note' })
  await page.waitForFunction(
    (id) => document.querySelector('#quick-note-workspace')?.value === id,
    originalId,
  )
  assert.equal(
    await oldSettings.getByLabel('Workspace', { exact: true }).inputValue(),
    originalId,
  )
  assert.equal(
    await oldSettings.locator(`option[value="${originalId}"]`).innerText(),
    originalPath,
  )
  await page.getByRole('button', { name: 'Back to app' }).click()
  const oldDialog = await openCapture(app, page)
  await until(
    async () => (await destinationTooltip(oldDialog)) === originalPath,
  )
  await writeNote(oldDialog, '# Older', 'Still selected')
  await saveCapture(app, oldDialog, 'Older.md')
  assert.equal(
    await readFile(join(workspace, 'Older.md'), 'utf8'),
    '# Older\n\nStill selected',
  )

  assert.ok(lastChosen)
  const selected = join(root, 'later-5')
  const moved = join(root, 'moved-later-5')
  const outside = join(root, 'outside')
  await mkdir(outside)
  await rename(selected, moved)
  await symlink(outside, selected, 'junction')
  await assert.rejects(
    page.evaluate(
      (workspaceId) =>
        window.hibi.invokeAddon('quick-note', 'save', {
          workspaceId,
          folder: '',
          title: 'Escape',
          markdown: 'Must stay inside',
        }),
      lastChosen.id,
    ),
    /workspace location changed/i,
  )
  await assert.rejects(readFile(join(outside, 'Escape.md'), 'utf8'), {
    code: 'ENOENT',
  })

  const parent = join(root, 'chosen-parent')
  const nested = join(parent, 'Notes')
  const replacement = join(root, 'replacement-parent')
  await mkdir(nested, { recursive: true })
  await mkdir(join(replacement, 'Notes'), { recursive: true })
  await app.evaluate(({ dialog }, destination) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [destination],
    })
  }, nested)
  const nestedChosen = await page.evaluate(() =>
    window.hibi.invokeAddon('quick-note', 'chooseWorkspace'),
  )
  await rename(parent, join(root, 'moved-chosen-parent'))
  await symlink(replacement, parent, 'junction')
  await assert.rejects(
    page.evaluate(
      (workspaceId) =>
        window.hibi.invokeAddon('quick-note', 'save', {
          workspaceId,
          folder: '',
          title: 'Ancestor escape',
          markdown: 'Must stay inside',
        }),
      nestedChosen.id,
    ),
    /workspace location changed/i,
  )
  await assert.rejects(
    readFile(join(replacement, 'Notes', 'Ancestor escape.md'), 'utf8'),
    { code: 'ENOENT' },
  )
})

test('quick note shortcut opens one capture window without raising Hibi', {
  timeout: 45000,
}, async (t) => {
  const probe = { phase: 'setup', presses: 0, attempts: 0, lastPress: null }
  t.signal.addEventListener(
    'abort',
    () => {
      try {
        if (probe.phase !== 'complete')
          t.diagnostic(`quick-note-shortcut-abort ${JSON.stringify(probe)}`)
      } catch {}
    },
    { once: true },
  )
  const root = await mkdtemp(join(tmpdir(), 'hibi-quick-note-window-'))
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  await mkdir(workspace, { recursive: true })
  await mkdir(profile)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'quick-note': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  await trackCaptureHides(app)
  await app.evaluate(({ dialog }, destination) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [destination],
    })
  }, workspace)
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine)
  formattedEngines.set(app, t.formattedEngine)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  const workspaceId = (await page.evaluate(() => window.hibi.openWorkspace()))
    .id
  // Record the OS callback so the test can press the shortcut without the OS.
  await app.evaluate(({ globalShortcut }) => {
    globalThis.quickNoteShortcuts = new Map()
    globalShortcut.register = (accelerator, callback) => {
      globalThis.quickNoteShortcuts.set(accelerator, callback)
      return true
    }
    globalShortcut.unregister = (accelerator) =>
      globalThis.quickNoteShortcuts.delete(accelerator)
  })
  const shortcut = 'Control+Alt+Shift+F7'
  await page.evaluate(
    ({ shortcut, workspaceId }) => {
      localStorage.setItem(
        'hibi:quick-note',
        JSON.stringify({ shortcut, workspaceId }),
      )
      window.dispatchEvent(new Event('hibi:quick-note-settings'))
    },
    { shortcut, workspaceId },
  )
  const press = async () => {
    probe.phase = `shortcut-${++probe.presses}`
    for (;;) {
      probe.attempts++
      const pressed = await app.evaluate((_electron, accelerator) => {
        const callback = globalThis.quickNoteShortcuts.get(accelerator)
        callback?.()
        return !!callback
      }, shortcut)
      probe.lastPress = pressed
      if (pressed) {
        probe.phase += '-returned'
        return
      }
      await setTimeout(30)
    }
  }
  await watchMainWindow(app)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === 'app://hibi/')
      .hide(),
  )

  const closeWith = async (capture, key) => {
    probe.phase = `close-${key}`
    const before = await captureHides(app)
    await capture.keyboard.press(key)
    probe.phase = `wait-hidden-${key}`
    await hidden(app, before)
  }

  await press()
  const capture = await captureWindow(app)
  await writeNote(capture, 'Keep this')
  const id = await app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().endsWith('addon-window.html'),
      ).webContents.id,
  )
  await press()
  assert.equal(
    (await appWindows(app)).filter((url) => captureUrl.test(url)).length,
    1,
  )
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().endsWith('addon-window.html'),
        ).webContents.id,
    ),
    id,
  )

  // Escape and Cmd/Ctrl+W hide the window and keep the unsaved note, also on disk.
  await closeWith(capture, 'Escape')
  await until(async () => (await readDraft(profile))?.markdown === 'Keep this')
  await press()
  assert.equal(await noteText(await captureWindow(app)), 'Keep this')
  await closeWith(capture, 'ControlOrMeta+w')

  await press()
  const saving = await captureWindow(app)
  assert.equal(await noteText(saving), 'Keep this')
  const before = await captureHides(app)
  probe.phase = 'save-key'
  await saving.keyboard.press('ControlOrMeta+Enter')
  probe.phase = 'saved-status'
  await saving.getByRole('status').getByText('Saved Quick note.md.').waitFor()
  await hidden(app, before)
  assert.equal(
    await readFile(join(workspace, 'Quick note.md'), 'utf8'),
    'Keep this',
  )
  assert.equal(await mainWindowRaised(app), 0)
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === 'app://hibi/')
        .isVisible(),
    ),
    false,
  )

  // The next capture starts empty.
  await press()
  const empty = await captureWindow(app)
  assert.equal(await noteText(empty), '')
  await closeWith(empty, 'Escape')

  if (process.platform !== 'darwin') {
    probe.phase = 'complete'
    return
  }
  // macOS keeps Hibi and its shortcut running after the last window closes.
  probe.phase = 'main-close'
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === 'app://hibi/')
      .close(),
  )
  probe.phase = 'wait-main-close'
  while ((await appWindows(app)).includes('app://hibi/')) await setTimeout(30)
  await press()
  const windowless = await captureWindow(app)
  await writeNote(windowless, 'No main window')
  await saveCapture(app, windowless, 'Quick note 2.md')
  assert.equal(
    await readFile(join(workspace, 'Quick note 2.md'), 'utf8'),
    'No main window',
  )
  assert.equal((await appWindows(app)).includes('app://hibi/'), false)
  probe.phase = 'complete'
})

test('the capture window renders markdown like the main editor', {
  timeout: 45000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-quick-note-parity-'))
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  await mkdir(workspace, { recursive: true })
  await mkdir(profile)
  const note =
    '# Reading list\n\nFind the essay.\n\n- [ ] look up the link\n- [ ] add it to **Reading list**\n'
  await writeFile(join(workspace, 'Reading list.md'), note)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'quick-note': true }),
  )
  // The same Markdown as an unsaved note opens in the capture window.
  await writeFile(
    join(profile, 'quick-note-draft.json'),
    JSON.stringify({ markdown: note, destination: null }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  const focusSessions = []
  t.after(async () => {
    for (const session of focusSessions) await session.detach()
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, destination) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [destination],
    })
  }, workspace)
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine)
  formattedEngines.set(app, t.formattedEngine)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page.evaluate(() => window.hibi.openWorkspace())
  await app.evaluate(
    ({ app }, path) => app.emit('open-file', { preventDefault() {} }, path),
    join(workspace, 'Reading list.md'),
  )
  await page
    .getByRole('heading', { level: 1, name: 'Reading list', exact: true })
    .waitFor()
  // Hosted macOS sometimes measures block markers; record what moves the caret.
  if (t.formattedEngine === 'tiptap')
    await page.evaluate(() => {
      const { editor } = document.querySelector('.tiptap')
      const started = performance.now()
      const log = []
      window.parityLog = log
      const record = (event) => {
        if (log.length === 20) log.shift()
        log.push([
          Math.round(performance.now() - started),
          event,
          editor.state.selection.head,
          editor.isFocused,
          document.hasFocus(),
        ])
      }
      for (const event of ['selectionUpdate', 'focus', 'blur'])
        editor.on(event, () => record(event))
      for (const event of ['focus', 'blur'])
        window.addEventListener(event, () => record(`window ${event}`))
      window.parityEditor = editor
    })
  const capture = await openCapture(app, page)
  if (t.formattedEngine === 'codemirror')
    for (const editor of [page, capture]) {
      const session = await editor.context().newCDPSession(editor)
      focusSessions.push(session)
      await session.send('Emulation.setFocusEmulationEnabled', {
        enabled: true,
      })
    }
  const shape = async (editor) => {
    if (t.formattedEngine === 'codemirror') {
      const root = editor.getByRole('textbox', {
        name: 'Document editor',
        exact: true,
      })
      const paragraph = root.locator('.cm-line', {
        hasText: /^Find the essay\.$/,
      })
      await click(paragraph, 'The first paragraph')
      await root.press('End')
      await waitForAsync(editor, () => {
        const element = document.querySelector('.rich-pane .cm-content')
        const view = element.cmTile.root.view
        const selection = getSelection()
        return (
          document.hasFocus() &&
          document.activeElement === element &&
          view.hasFocus &&
          selection?.isCollapsed &&
          element.contains(selection.focusNode) &&
          view.posAtDOM(selection.focusNode, selection.focusOffset) ===
            view.state.selection.main.head &&
          view.state.selection.main.empty &&
          view.state.selection.main.head ===
            view.state.doc.toString().indexOf('Find the essay.') +
              'Find the essay.'.length
        )
      })
      return {
        shape: await root.evaluate((element) => ({
          headings: element.querySelectorAll('[role="heading"][aria-level="1"]')
            .length,
          tasks: element.querySelectorAll('.hibi-lp-task').length,
          checkboxes: element.querySelectorAll('input[type="checkbox"]').length,
          bold: element.querySelectorAll('.hibi-lp-strong').length,
          markers: [...element.querySelectorAll('.hibi-lp-marker')].filter(
            (marker) => marker.getClientRects().length,
          ).length,
          heading: getComputedStyle(element.querySelector('.hibi-lp-h1'))
            .fontSize,
          text: getComputedStyle(
            [...element.querySelectorAll('.cm-line')].find(
              (line) => line.textContent === 'Find the essay.',
            ),
          ).lineHeight,
        })),
        diagnostic: {},
      }
    }
    const root = editor.locator('.tiptap[contenteditable="true"]')
    // The same plain caret in both: the end of the first paragraph, outside bold.
    await click(root.locator('p').first(), 'The first paragraph')
    await editor.keyboard.press('End')
    // Native caret movement reaches ProseMirror after the DOM selection.
    await waitForAsync(editor, () => {
      const element = document.querySelector('.tiptap[contenteditable="true"]')
      const paragraph = element.querySelector('p')
      const { view } = element.editor
      return (
        view.state.selection.empty &&
        view.state.selection.head ===
          view.posAtDOM(paragraph, paragraph.childNodes.length)
      )
    })
    return root.evaluate((element) => {
      const markers = [...element.querySelectorAll('.markdown-marker')].filter(
        (marker) => marker.getClientRects().length,
      )
      const { selection } = element.editor.state
      return {
        shape: {
          headings: element.querySelectorAll('h1').length,
          tasks: element.querySelectorAll('ul[data-type="taskList"] > li')
            .length,
          checkboxes: element.querySelectorAll('input[type="checkbox"]').length,
          bold: element.querySelectorAll('strong').length,
          markers: markers.length,
          heading: getComputedStyle(element.querySelector('h1')).fontSize,
          text: getComputedStyle(element.querySelector('p')).lineHeight,
        },
        // Read with the marker count so a later caret move cannot hide the cause.
        diagnostic: {
          sameEditor: element.editor === window.parityEditor,
          head: selection.head,
          block: selection.$head.parent.textContent,
          markers: markers.map((marker) => marker.dataset.marker),
          log: window.parityLog?.slice(),
        },
      }
    })
  }
  const { shape: main, diagnostic } = await shape(page)
  if (main.markers)
    console.error('quick note parity:', JSON.stringify(diagnostic))
  assert.deepEqual(main, {
    headings: 1,
    tasks: 2,
    checkboxes: 2,
    bold: 1,
    markers: 0,
    heading: main.heading,
    text: main.text,
  })
  assert.deepEqual((await shape(capture)).shape, main)
})

test('a stalled save keeps what was typed meanwhile', {
  timeout: 45000,
}, async (t) => {
  const h = await harness(t)
  const { app, page } = await h.launch()
  const capture = await openCapture(app, page)
  await writeNote(capture, 'alpha')
  await pause(app, 'quick-note-save')
  await capture.keyboard.press('ControlOrMeta+Enter')
  await capture.getByRole('button', { name: 'Saving…' }).waitFor()
  await capture.keyboard.press('Enter')
  await capture.keyboard.type('beta')
  const before = await captureHides(app)
  await resume(app, 'quick-note-save')
  await capture.getByRole('status').getByText('Saved Quick note.md.').waitFor()
  assert.equal(
    await readFile(join(h.workspace, 'Quick note.md'), 'utf8'),
    'alpha',
  )
  await until(async () => (await noteText(capture)) === 'beta')
  await until(async () => (await readDraft(h.profile))?.markdown === 'beta')
  assert.equal(await captureHides(app), before)
})

test('disabling quick note waits for a capture save in flight', {
  timeout: 45000,
}, async (t) => {
  const h = await harness(t)
  const { app, page } = await h.launch()
  const capture = await openCapture(app, page)
  await writeNote(capture, 'alpha')
  await pause(app, 'quick-note-save')
  // Record when the save reaches the pause, which it holds inside the file-operation lock.
  await app.evaluate(() => {
    const held = globalThis.hibiTestPauses['quick-note-save']
    Object.defineProperty(globalThis.hibiTestPauses, 'quick-note-save', {
      configurable: true,
      get() {
        globalThis.quickNoteSaveHeld = true
        return held
      },
    })
  })
  await capture.keyboard.press('ControlOrMeta+Enter')
  await until(() => app.evaluate(() => globalThis.quickNoteSaveHeld))
  const disabling = page.evaluate(() =>
    window.hibi.setAddonEnabled('quick-note', false),
  )
  await resume(app, 'quick-note-save')
  const states = await disabling
  assert.equal(states.find((state) => state.id === 'quick-note').enabled, false)
  assert.equal(
    await readFile(join(h.workspace, 'Quick note.md'), 'utf8'),
    'alpha',
  )
})

test('choosing a quick note workspace waits for a capture save in flight', {
  timeout: 45000,
}, async (t) => {
  const h = await harness(t)
  const { app, page } = await h.launch()
  const destination = join(h.root, 'chosen')
  await mkdir(destination)
  await app.evaluate(({ ipcMain }) => {
    const invoke = ipcMain._invokeHandlers.get('addons:invoke')
    ipcMain.removeHandler('addons:invoke')
    ipcMain.handle('addons:invoke', (...args) => {
      if (args[1] === 'quick-note' && args[2] === 'chooseWorkspace')
        globalThis.quickNoteChoiceRequested = true
      return invoke(...args)
    })
  })
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    })
  }, destination)
  const capture = await openCapture(app, page)
  await writeNote(capture, 'alpha')
  await pause(app, 'quick-note-save')
  await app.evaluate(() => {
    const held = globalThis.hibiTestPauses['quick-note-save']
    Object.defineProperty(globalThis.hibiTestPauses, 'quick-note-save', {
      configurable: true,
      get() {
        globalThis.quickNoteSaveHeld = true
        return held
      },
    })
  })
  await capture.keyboard.press('ControlOrMeta+Enter')
  await until(() => app.evaluate(() => globalThis.quickNoteSaveHeld))
  const choosing = page
    .evaluate(() => window.hibi.invokeAddon('quick-note', 'chooseWorkspace'))
    .then(
      (result) => ({ result }),
      (error) => ({ error }),
    )
  await until(() => app.evaluate(() => globalThis.quickNoteChoiceRequested))
  await resume(app, 'quick-note-save')
  const { result, error } = await choosing
  assert.ifError(error)
  assert.equal(result.path, await realpath(destination))
  assert.equal(
    await readFile(join(h.workspace, 'Quick note.md'), 'utf8'),
    'alpha',
  )
})

test('the unsaved note survives a crash', {
  timeout: 60000,
}, async (t) => {
  const h = await harness(t)
  const first = await h.launch()
  const capture = await openCapture(first.app, first.page)
  await writeNote(capture, 'survive crash')
  await until(
    async () => (await readDraft(h.profile))?.markdown === 'survive crash',
  )
  const child = first.app.process()
  const exited = once(child, 'exit')
  stopElectronTree(child)
  await exited
  const second = await h.launch()
  const again = await openCapture(second.app, second.page)
  assert.equal(await noteText(again), 'survive crash')
})

test('escape closes editor popups before the capture window', {
  timeout: 45000,
}, async (t) => {
  const h = await harness(t)
  const { app, page } = await h.launch()
  const capture = await openCapture(app, page)
  await click(
    capture.getByRole('textbox', { name: 'Document editor', exact: true }),
    'The capture window editor',
  )
  await capture.keyboard.type('/')
  const menu = capture.locator('.slash-menu [role="listbox"]')
  await menu.waitFor()
  const before = await captureHides(app)
  await capture.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  assert.equal(await captureHides(app), before)
  await capture.keyboard.press('Escape')
  await hidden(app, before)
})

test('the file name comes from the first markdown heading', {
  timeout: 45000,
}, async (t) => {
  const h = await harness(t, {
    draft:
      '[ref]: /x "first\n\n```\n# not a heading\n```\n\nintro\n\nMeeting notes\n===\nlast"\n\n[ref]',
  })
  const { app, page } = await h.launch()
  const capture = await openCapture(app, page)
  const before = await captureHides(app)
  await capture.keyboard.press('ControlOrMeta+Enter')
  await capture
    .getByRole('status')
    .getByText('Saved Meeting notes.md.')
    .waitFor()
  await hidden(app, before)
  assert.match(
    await readFile(join(h.workspace, 'Meeting notes.md'), 'utf8'),
    /Meeting notes/,
  )
})

test('a shortcut press from a stale activation opens nothing', {
  timeout: 60000,
}, async (t) => {
  const h = await harness(t)
  const { app, page } = await h.launch()
  await app.evaluate(({ globalShortcut }) => {
    globalThis.quickNoteShortcuts = new Map()
    globalShortcut.register = (accelerator, callback) => {
      globalThis.quickNoteShortcuts.set(accelerator, callback)
      return true
    }
    globalShortcut.unregister = (accelerator) =>
      globalThis.quickNoteShortcuts.delete(accelerator)
    globalThis.shortcutErrors = []
    const error = console.error
    console.error = (...args) => {
      globalThis.shortcutErrors.push(args.map(String).join(' '))
      error(...args)
    }
  })
  const shortcut = 'Control+Alt+Shift+F6'
  const register = async () => {
    await page.evaluate((shortcut) => {
      localStorage.setItem('hibi:quick-note', JSON.stringify({ shortcut }))
      // A change while an earlier registration is in flight must still apply.
      window.dispatchEvent(new Event('hibi:quick-note-settings'))
      window.dispatchEvent(new Event('hibi:quick-note-settings'))
    }, shortcut)
    await until(() =>
      app.evaluate(
        (_electron, accelerator) =>
          globalThis.quickNoteShortcuts.has(accelerator),
        shortcut,
      ),
    )
  }
  const press = () =>
    until(() =>
      app.evaluate((_electron, accelerator) => {
        const callback = globalThis.quickNoteShortcuts.get(accelerator)
        callback?.()
        return !!callback
      }, shortcut),
    )
  const captureWindows = async () =>
    (await appWindows(app)).filter((url) => captureUrl.test(url)).length
  const toggle = (enabled) =>
    page.evaluate(
      (enabled) => window.hibi.setAddonEnabled('quick-note', enabled),
      enabled,
    )
  // Disabled while the native module loads: the press is retired before the handler.
  await register()
  await pause(app, 'global-shortcut-loaded')
  await press()
  await toggle(false)
  await resume(app, 'global-shortcut-loaded')
  for (let check = 0; check < 20; check++) {
    assert.equal(await captureWindows(), 0)
    await setTimeout(50)
  }
  assert.deepEqual(
    await app.evaluate(() =>
      globalThis.shortcutErrors.filter((line) => line.includes('shortcut')),
    ),
    [],
  )
  // Disabled while the handler runs: its window request is refused.
  await toggle(true)
  await register()
  await pause(app, 'global-shortcut-handler')
  await press()
  await toggle(false)
  await resume(app, 'global-shortcut-handler')
  await until(() =>
    app.evaluate(() =>
      globalThis.shortcutErrors.some((line) => line.includes('was disabled')),
    ),
  )
  assert.equal(await captureWindows(), 0)
})

test('an unreadable draft is kept aside and an older one is recovered', {
  timeout: 60000,
}, async (t) => {
  const damaged = await harness(t, { draftFile: '{"markdown": "half' })
  let session = await damaged.launch()
  let capture = await openCapture(session.app, session.page)
  await capture
    .getByRole('alert')
    .getByText(/kept the file as quick-note-draft\.unreadable-\d+\.json/)
    .waitFor()
  const kept = (await readdir(damaged.profile)).find((name) =>
    name.startsWith('quick-note-draft.unreadable-'),
  )
  assert.equal(
    await readFile(join(damaged.profile, kept), 'utf8'),
    '{"markdown": "half',
  )
  await writeNote(capture, 'new note')
  await until(
    async () => (await readDraft(damaged.profile))?.markdown === 'new note',
  )
  assert.equal(
    await readFile(join(damaged.profile, kept), 'utf8'),
    '{"markdown": "half',
  )

  // A draft from before destinations were stored is recovered, not replaced.
  const older = await harness(t, {
    draftFile: JSON.stringify({ markdown: 'recover me' }),
  })
  session = await older.launch()
  capture = await openCapture(session.app, session.page)
  assert.equal(await noteText(capture), 'recover me')
  // The editor's first autosave keeps the recovered text.
  await until(
    async () => (await readDraft(older.profile))?.markdown === 'recover me',
  )
})

test('the window warns while the draft cannot be kept', {
  timeout: 45000,
}, async (t) => {
  const h = await harness(t)
  // A directory where the temporary draft file goes makes every write fail.
  const blocker = join(h.profile, 'quick-note-draft.json.tmp')
  await mkdir(blocker)
  const { app, page } = await h.launch()
  const capture = await openCapture(app, page)
  await writeNote(capture, 'at risk')
  const warning = capture.getByText(/cannot keep this note right now/)
  await warning.waitFor()
  await rm(blocker, { recursive: true })
  await warning.waitFor({ state: 'hidden' })
  assert.equal((await readDraft(h.profile))?.markdown, 'at risk')
})

test('frontmatter does not become the file name', {
  timeout: 45000,
}, async (t) => {
  const h = await harness(t, {
    draft: '---\ntitle: metadata\n---\n\n# Real heading\n\nBody\n',
  })
  const { app, page } = await h.launch()
  const capture = await openCapture(app, page)
  const before = await captureHides(app)
  await capture.keyboard.press('ControlOrMeta+Enter')
  await capture
    .getByRole('status')
    .getByText('Saved Real heading.md.')
    .waitFor()
  await hidden(app, before)
})

test('notes save to the destination currently set', {
  timeout: 60000,
}, async (t) => {
  const h = await harness(t)
  await mkdir(join(h.workspace, 'Inbox'))
  const other = join(h.root, 'other')
  await mkdir(other)
  const { app, page } = await h.launch()
  const setFolder = (folder) =>
    page.evaluate((folder) => {
      localStorage.setItem('hibi:quick-note', JSON.stringify({ folder }))
    }, folder)
  const capture = await openCapture(app, page)
  await capture.getByText('workspace', { exact: true }).waitFor()
  await writeNote(capture, 'first')
  // The footer follows a settings change while the note is open, and so does saving.
  await setFolder('Inbox')
  await capture.getByText('workspace › Inbox', { exact: true }).waitFor()
  await saveCapture(app, capture, 'Quick note.md')
  assert.equal(
    await readFile(join(h.workspace, 'Inbox', 'Quick note.md'), 'utf8'),
    'first',
  )
  // A new note after switching workspaces saves into the new one.
  await setFolder('')
  await app.evaluate(({ dialog }, destination) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [destination],
    })
  }, other)
  await page.evaluate(() => window.hibi.openWorkspace())
  const next = await openCapture(app, page)
  await writeNote(next, 'second')
  await saveCapture(app, next, 'Quick note.md')
  assert.equal(await readFile(join(other, 'Quick note.md'), 'utf8'), 'second')
})

test('a refused draft write warns over the recovery notice and retries', {
  timeout: 60000,
}, async (t) => {
  const original = '{"markdown": "half'
  const h = await harness(t, { draftFile: original })
  const { app, page } = await h.launch()
  // Moving the unreadable draft aside fails until the test lets it through.
  await app.evaluate(() => {
    const blocked = Promise.reject(new Error('blocked'))
    blocked.catch(() => {})
    globalThis.hibiTestPauses = { 'quick-note-keep-aside': blocked }
  })
  const capture = await openCapture(app, page)
  await capture
    .getByRole('alert')
    .getByText(/left the file unchanged/)
    .waitFor()
  await writeNote(capture, 'newer')
  const warning = capture.getByText(/cannot keep this note right now/)
  await warning.waitFor()
  assert.equal(
    await readFile(join(h.profile, 'quick-note-draft.json'), 'utf8'),
    original,
  )
  await app.evaluate(() => {
    delete globalThis.hibiTestPauses['quick-note-keep-aside']
  })
  await warning.waitFor({ state: 'hidden' })
  await until(async () => (await readDraft(h.profile))?.markdown === 'newer')
  const kept = (await readdir(h.profile)).find((name) =>
    name.startsWith('quick-note-draft.unreadable-'),
  )
  assert.equal(await readFile(join(h.profile, kept), 'utf8'), original)
  // The notice now names the kept file instead of saying notes are not kept.
  await capture
    .getByRole('alert')
    .getByText(`kept the file as ${kept} in its app data folder`, {
      exact: false,
    })
    .waitFor()
  assert.equal(await capture.getByText(/left the file unchanged/).count(), 0)
})

test('a draft from the previous version is imported once', {
  timeout: 60000,
}, async (t) => {
  const h = await harness(t)
  // The first writes fail, so the import must survive until one succeeds.
  const blocker = join(h.profile, 'quick-note-draft.json.tmp')
  await mkdir(blocker)
  const first = await h.launch()
  await first.page.evaluate(() => {
    localStorage.setItem(
      'hibi:quick-note-draft',
      JSON.stringify({ markdown: 'legacy note' }),
    )
  })
  const capture = await openCapture(first.app, first.page)
  assert.equal(await noteText(capture), 'legacy note')
  const warning = capture.getByText(/cannot keep this note right now/)
  await warning.waitFor()
  assert.notEqual(
    await first.page.evaluate(() =>
      localStorage.getItem('hibi:quick-note-draft'),
    ),
    null,
  )
  await rm(blocker, { recursive: true })
  await warning.waitFor({ state: 'hidden' })
  await until(
    async () => (await readDraft(h.profile))?.markdown === 'legacy note',
  )
  await until(() =>
    first.page.evaluate(
      () => localStorage.getItem('hibi:quick-note-draft') === null,
    ),
  )
  await saveCapture(first.app, capture, 'Quick note.md')
  await first.app.close()
  // After the note is saved, a restart does not bring the old text back.
  const second = await h.launch()
  const again = await openCapture(second.app, second.page)
  assert.equal(await noteText(again), '')
})

test('a native draft retires a stale draft from the previous version', {
  timeout: 60000,
}, async (t) => {
  const h = await harness(t, { draft: 'native note' })
  const first = await h.launch()
  const legacyDraft = () =>
    first.page.evaluate(() => localStorage.getItem('hibi:quick-note-draft'))
  await first.page.evaluate(() => {
    localStorage.setItem(
      'hibi:quick-note-draft',
      JSON.stringify({ markdown: 'stale legacy' }),
    )
  })
  const capture = await openCapture(first.app, first.page)
  assert.equal(await noteText(capture), 'native note')
  await until(async () => (await legacyDraft()) === null)
  await saveCapture(first.app, capture, 'Quick note.md')
  await first.app.close()
  // The saved note's empty draft does not let the old text return.
  const second = await h.launch()
  const again = await openCapture(second.app, second.page)
  assert.equal(await noteText(again), '')
})

test('a slow destination lookup does not replace a newer footer', {
  timeout: 45000,
}, async (t) => {
  const h = await harness(t)
  await mkdir(join(h.workspace, 'Inbox'))
  const { app, page } = await h.launch()
  const capture = await openCapture(app, page)
  await capture.getByText('workspace', { exact: true }).waitFor()
  // Hold only the next lookup, which still reads the old folder.
  await app.evaluate(() => {
    globalThis.hibiTestPauses ??= {}
    globalThis.destinationHeld = new Promise((resolve) => {
      globalThis.releaseDestination = resolve
    })
    Object.defineProperty(globalThis.hibiTestPauses, 'quick-note-destination', {
      configurable: true,
      get() {
        delete this['quick-note-destination']
        globalThis.destinationHolding = true
        return globalThis.destinationHeld
      },
    })
  })
  await capture.evaluate(() => window.dispatchEvent(new Event('focus')))
  await until(() => app.evaluate(() => globalThis.destinationHolding))
  await page.evaluate(() => {
    localStorage.setItem('hibi:quick-note', JSON.stringify({ folder: 'Inbox' }))
  })
  await capture.getByText('workspace › Inbox', { exact: true }).waitFor()
  await capture.evaluate(() => {
    const footer = document.querySelector('.quick-note-bar')
    window.footerTexts = []
    new MutationObserver(() =>
      window.footerTexts.push(
        footer.querySelector('.quick-note-meta')?.textContent,
      ),
    ).observe(footer, { subtree: true, childList: true, characterData: true })
  })
  await app.evaluate(() => globalThis.releaseDestination())
  await app.evaluate(() => {})
  // Saving sends its lookup after the held reply, so that reply has arrived by then.
  await writeNote(capture, 'inbox note')
  await saveCapture(app, capture, 'Quick note.md')
  assert.equal(
    await readFile(join(h.workspace, 'Inbox', 'Quick note.md'), 'utf8'),
    'inbox note',
  )
  assert.ok(
    !(await capture.evaluate(() => window.footerTexts)).includes('workspace'),
  )
})
