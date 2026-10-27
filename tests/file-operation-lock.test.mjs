import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu, replaceRichText } from './keyboard.mjs'

async function setup(t, keepAlive = false) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-file-lock-'))
  await writeFile(join(profile, 'addons.json'), '{"quick-note":true}')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  const child = app.process()
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await app.evaluate(async ({ dialog }) => {
        globalThis.fileLockTest?.release?.()
        await new Promise(setImmediate)
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      await app.close()
    }
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine)
  // The editor reports its initial value and schedules an empty draft write.
  // Drain that real writer before injecting draft requests from the test.
  await app.evaluate(({ ipcMain }) => {
    const channel = 'addon-windows:invoke'
    const invoke = ipcMain._invokeHandlers.get(channel)
    const saved = Promise.withResolvers()
    globalThis.initialDraftSaved = saved.promise
    ipcMain._invokeHandlers.set(channel, (...args) => {
      const pending = invoke(...args)
      if (args[1] === 'saveDraft') {
        ipcMain._invokeHandlers.set(channel, invoke)
        pending.then(saved.resolve, saved.reject)
      }
      return pending
    })
  })
  const opened = app.waitForEvent('window')
  await page.evaluate(
    (keepAlive) =>
      window.hibi.openAddonWindow('quick-note', {
        id: 'capture',
        keepAlive,
        show: false,
      }),
    keepAlive,
  )
  const capture = await opened
  await capture
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .waitFor()
  if (t.formattedEngine === 'codemirror')
    await capture
      .locator('.hibi-formatted .cm-content[contenteditable="true"]')
      .waitFor()
  assert.equal(
    await capture
      .locator(
        t.formattedEngine === 'tiptap'
          ? '.tiptap[contenteditable="true"]'
          : '.hibi-formatted .cm-content[contenteditable="true"]',
      )
      .count(),
    1,
    'quick note uses the selected formatted engine',
  )
  assert.deepEqual(await app.evaluate(() => globalThis.initialDraftSaved), {
    keptAs: null,
  })
  await app.evaluate(({ BrowserWindow, ipcMain, dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    const windows = BrowserWindow.getAllWindows()
    const addon = windows.find((window) =>
      window.webContents.getURL().endsWith('/addon-window.html'),
    )
    const main = windows.find((window) => window !== addon)
    globalThis.fileLockTest = {
      results: {},
      pending: {},
      start(key, channel, fromAddon, ...args) {
        const sender = (fromAddon ? addon : main).webContents
        this.pending[key] = Promise.resolve()
          .then(() =>
            ipcMain._invokeHandlers.get(channel)(
              { sender, senderFrame: sender.mainFrame },
              ...args,
            ),
          )
          .then(
            (value) => {
              this.results[key] = { value }
            },
            (error) => {
              this.results[key] = { error: error.message }
            },
          )
      },
    }
  })
  return { app, profile, page, capture }
}

test('core mutations and draft writes wait for a held quick-note draft read', {
  timeout: 30000,
}, async (t) => {
  const { app, profile } = await setup(t)
  await writeFile(
    join(profile, 'quick-note-draft.json'),
    JSON.stringify({ markdown: 'earlier', destination: null }),
  )
  await app.evaluate(async () => {
    const state = globalThis.fileLockTest
    const fs = process.getBuiltinModule('node:fs/promises')
    const read = fs.readFile
    const held = Promise.withResolvers()
    const entered = Promise.withResolvers()
    state.release = held.resolve
    fs.readFile = async (...args) => {
      if (String(args[0]).endsWith('quick-note-draft.json')) {
        fs.readFile = read
        process.getBuiltinModule('node:module').syncBuiltinESMExports()
        entered.resolve()
        await held.promise
      }
      return read(...args)
    }
    process.getBuiltinModule('node:module').syncBuiltinESMExports()
    state.start('read', 'addon-windows:invoke', true, 'openDraft')
    await entered.promise
    state.start(
      'choose',
      'addons:invoke',
      false,
      'quick-note',
      'chooseWorkspace',
    )
    state.start('new', 'document:new', false)
    state.start('write', 'addon-windows:invoke', true, 'saveDraft', {
      markdown: 'newer',
      destination: null,
    })
    await new Promise(setImmediate)
  })
  assert.deepEqual(
    await app.evaluate(() => globalThis.fileLockTest.results),
    {},
    'overlapping requests must wait without refusing or running early',
  )
  const results = await app.evaluate(async () => {
    const state = globalThis.fileLockTest
    state.release()
    await Promise.all(Object.values(state.pending))
    return state.results
  })
  assert.equal(results.read.value.draft.markdown, 'earlier')
  assert.ok(results.new.value)
  assert.deepEqual(results.choose, { value: null })
  assert.deepEqual(results.write, { value: { keptAs: null } })
  assert.equal(
    JSON.parse(await readFile(join(profile, 'quick-note-draft.json'), 'utf8'))
      .markdown,
    'newer',
  )
})

test('a resolved Open dialog followed by failed file I/O releases a queued draft write', {
  timeout: 30000,
}, async (t) => {
  const { app, profile } = await setup(t)
  const path = join(profile, 'file-lock-source.md')
  await writeFile(path, '# source')
  await app.evaluate(async ({ dialog }, path) => {
    const state = globalThis.fileLockTest
    const held = Promise.withResolvers()
    const entered = Promise.withResolvers()
    state.release = () => held.reject(new Error('held read failure'))
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    const fs = process.getBuiltinModule('node:fs/promises')
    const read = fs.realpath
    fs.realpath = async (...args) => {
      if (String(args[0]).endsWith('file-lock-source.md')) {
        fs.realpath = read
        process.getBuiltinModule('node:module').syncBuiltinESMExports()
        entered.resolve()
        await held.promise
      }
      return read(...args)
    }
    process.getBuiltinModule('node:module').syncBuiltinESMExports()
    state.start('open', 'document:open', false)
    await entered.promise
    state.start('write', 'addon-windows:invoke', true, 'saveDraft', {
      markdown: 'kept after failure',
      destination: null,
    })
    await new Promise(setImmediate)
  }, path)
  assert.deepEqual(
    await app.evaluate(() => globalThis.fileLockTest.results),
    {},
  )
  const results = await app.evaluate(async () => {
    const state = globalThis.fileLockTest
    state.release()
    await Promise.all(Object.values(state.pending))
    return state.results
  })
  assert.match(results.open.error, /held read failure/)
  assert.deepEqual(results.write, { value: { keptAs: null } })
  assert.equal(
    JSON.parse(await readFile(join(profile, 'quick-note-draft.json'), 'utf8'))
      .markdown,
    'kept after failure',
  )
})

test('closing drains capture writes and refuses queued and new main actions', {
  timeout: 30000,
}, async (t) => {
  const { app, profile } = await setup(t)
  await app.evaluate(async ({ BrowserWindow, dialog, ipcMain }) => {
    const state = globalThis.fileLockTest
    const main = BrowserWindow.getAllWindows().find(
      (window) => !window.webContents.getURL().endsWith('/addon-window.html'),
    )
    const first = Promise.withResolvers()
    const entered = Promise.withResolvers()
    const write = Promise.withResolvers()
    const writing = Promise.withResolvers()
    const flushed = Promise.withResolvers()
    state.allowedClose = false
    state.openCalls = 0
    const observeClose = (event) => {
      if (!event.defaultPrevented) {
        state.allowedClose = true
        event.preventDefault()
      }
    }
    main.on('close', observeClose)
    ipcMain.on('document:flushed', (_event, token) => {
      if (token !== 'ready') flushed.resolve()
    })
    state.release = () => {
      first.resolve()
      write.resolve()
      main.off('close', observeClose)
    }
    state.finish = async () => {
      write.resolve()
      await Promise.all(Object.values(state.pending))
      await new Promise(setImmediate)
      main.off('close', observeClose)
      return { results: state.results, openCalls: state.openCalls }
    }
    dialog.showOpenDialog = async () => {
      state.openCalls++
      return { canceled: true, filePaths: [] }
    }
    const fs = process.getBuiltinModule('node:fs/promises')
    const read = fs.readFile
    const writeFile = fs.writeFile
    fs.readFile = async (...args) => {
      if (String(args[0]).endsWith('quick-note-draft.json')) {
        fs.readFile = read
        process.getBuiltinModule('node:module').syncBuiltinESMExports()
        entered.resolve()
        await first.promise
      }
      return read(...args)
    }
    fs.writeFile = async (...args) => {
      if (String(args[0]).endsWith('quick-note-draft.json.tmp')) {
        fs.writeFile = writeFile
        process.getBuiltinModule('node:module').syncBuiltinESMExports()
        writing.resolve()
        await write.promise
      }
      return writeFile(...args)
    }
    process.getBuiltinModule('node:module').syncBuiltinESMExports()
    state.start('read', 'addon-windows:invoke', true, 'openDraft')
    await entered.promise
    state.start('write', 'addon-windows:invoke', true, 'saveDraft', {
      markdown: 'kept before closing',
      destination: null,
    })
    state.start('open', 'document:open', false)
    await new Promise(setImmediate)
    main.close()
    await flushed.promise
    state.start('lateWrite', 'addon-windows:invoke', true, 'saveDraft', {
      markdown: 'kept while closing',
      destination: null,
    })
    state.start('lateMain', 'document:new', false)
    await new Promise(setImmediate)
    first.resolve()
    await writing.promise
    await new Promise(setImmediate)
  })
  let result
  try {
    assert.equal(
      await app.evaluate(() => globalThis.fileLockTest.allowedClose),
      false,
    )
    assert.equal(
      await app.evaluate(() => globalThis.fileLockTest.results.lateWrite),
      undefined,
    )
  } finally {
    result = await app.evaluate(() => globalThis.fileLockTest.finish())
  }
  assert.equal(result.openCalls, 0)
  assert.match(
    result.results.open.error,
    /Another file operation is in progress/,
  )
  assert.match(
    result.results.lateMain.error,
    /Another file operation is in progress/,
  )
  assert.deepEqual(result.results.write, { value: { keptAs: null } })
  assert.deepEqual(result.results.lateWrite, { value: { keptAs: null } })
  await app.close()
  assert.equal(
    JSON.parse(await readFile(join(profile, 'quick-note-draft.json'), 'utf8'))
      .markdown,
    'kept while closing',
  )
})

test('a draft queued before its owner opens a dialog is refused when it opens', {
  timeout: 30000,
}, async (t) => {
  const { app, profile } = await setup(t)
  const path = join(profile, 'changed-outside.md')
  await writeFile(path, 'original')
  await app.evaluate(async ({ dialog }, path) => {
    const state = globalThis.fileLockTest
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    state.start('open', 'document:open', false)
    await state.pending.open
    state.start('edit', 'document:update', false, 'unsaved change')
    await state.pending.edit
  }, path)
  await writeFile(path, 'external change')
  await app.evaluate(async ({ dialog }) => {
    const state = globalThis.fileLockTest
    const reading = Promise.withResolvers()
    const readEntered = Promise.withResolvers()
    const prompted = Promise.withResolvers()
    const dialogEntered = Promise.withResolvers()
    const fs = process.getBuiltinModule('node:fs/promises')
    const realpath = fs.realpath
    fs.realpath = async (...args) => {
      if (String(args[0]).endsWith('changed-outside.md')) {
        fs.realpath = realpath
        process.getBuiltinModule('node:module').syncBuiltinESMExports()
        readEntered.resolve()
        await reading.promise
      }
      return realpath(...args)
    }
    process.getBuiltinModule('node:module').syncBuiltinESMExports()
    dialog.showMessageBox = async () => {
      dialogEntered.resolve()
      await prompted.promise
      return { response: 1 }
    }
    state.release = () => {
      reading.resolve()
      prompted.resolve()
    }
    state.showDialog = async () => {
      reading.resolve()
      await dialogEntered.promise
      await new Promise(setImmediate)
    }
    state.start('save', 'document:save', false, false)
    await readEntered.promise
    state.start('write', 'addon-windows:invoke', true, 'saveDraft', {
      markdown: 'queued before the prompt',
      destination: null,
    })
    await new Promise(setImmediate)
  })
  try {
    assert.equal(
      await app.evaluate(() => globalThis.fileLockTest.results.write),
      undefined,
    )
    await app.evaluate(() => globalThis.fileLockTest.showDialog())
    assert.match(
      await app.evaluate(
        () => globalThis.fileLockTest.results.write?.error ?? '',
      ),
      /Another file operation is in progress/,
    )
  } finally {
    await app.evaluate(async () => {
      const state = globalThis.fileLockTest
      state.release()
      await Promise.all(Object.values(state.pending))
    })
  }
})

test('capture drafts still open and save after the macOS main window closes', {
  timeout: 30000,
  skip: process.platform !== 'darwin',
}, async (t) => {
  const { app, profile } = await setup(t)
  await app.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(
      (window) => !window.webContents.getURL().endsWith('/addon-window.html'),
    )
    const closed = new Promise((done) => main.once('closed', done))
    main.close()
    await closed
    const state = globalThis.fileLockTest
    state.start('read', 'addon-windows:invoke', true, 'openDraft')
    await state.pending.read
    state.start('write', 'addon-windows:invoke', true, 'saveDraft', {
      markdown: 'kept without a main window',
      destination: null,
    })
    await state.pending.write
  })
  const state = await app.evaluate(({ BrowserWindow }) => ({
    results: globalThis.fileLockTest.results,
    windows: BrowserWindow.getAllWindows().map((window) =>
      window.webContents.getURL(),
    ),
  }))
  assert.equal(state.results.read.error, undefined)
  assert.deepEqual(state.results.write, { value: { keptAs: null } })
  assert.equal(state.windows.length, 1)
  assert.match(state.windows[0], /addon-window\.html$/)
  assert.equal(
    JSON.parse(await readFile(join(profile, 'quick-note-draft.json'), 'utf8'))
      .markdown,
    'kept without a main window',
  )
})

test('capture text typed during the quit confirmation is kept', {
  timeout: 30000,
}, async (t) => {
  const { app, page, capture, profile } = await setup(t, true)
  await replaceRichText(
    page,
    page.getByRole('textbox', { name: 'Document editor', exact: true }),
    'unsaved main draft',
  )
  await app.evaluate(async ({ app, BrowserWindow, dialog, ipcMain }) => {
    const state = globalThis.fileLockTest
    const held = Promise.withResolvers()
    const entered = Promise.withResolvers()
    state.saved = Promise.withResolvers()
    state.release = () => held.resolve({ response: 2 })
    dialog.showMessageBox = async () => {
      entered.resolve()
      return held.promise
    }
    const channel = 'addon-windows:invoke'
    const invoke = ipcMain._invokeHandlers.get(channel)
    ipcMain._invokeHandlers.set(channel, async (...args) => {
      const typedDraft =
        args[1] === 'saveDraft' && args[2]?.markdown === 'typed during quit'
      try {
        const value = await invoke(...args)
        if (typedDraft) state.saved.resolve({ value })
        return value
      } catch (error) {
        if (typedDraft) state.saved.resolve({ error: error.message })
        throw error
      }
    })
    app.quit()
    await entered.promise
    BrowserWindow.getAllWindows()
      .find((window) =>
        window.webContents.getURL().endsWith('/addon-window.html'),
      )
      .showInactive()
  })
  try {
    await replaceRichText(
      capture,
      capture.getByRole('textbox', { name: 'Document editor', exact: true }),
      'typed during quit',
    )
    assert.deepEqual(
      await app.evaluate(() => globalThis.fileLockTest.saved.promise),
      { value: { keptAs: null } },
    )
    assert.equal(
      JSON.parse(await readFile(join(profile, 'quick-note-draft.json'), 'utf8'))
        .markdown,
      'typed during quit',
    )
  } finally {
    await app.evaluate(async ({ dialog }) => {
      globalThis.fileLockTest.release()
      await new Promise(setImmediate)
      dialog.showMessageBox = async () => ({ response: 1 })
    })
  }
  await app.close()
  assert.equal(
    JSON.parse(await readFile(join(profile, 'quick-note-draft.json'), 'utf8'))
      .markdown,
    'typed during quit',
  )
})

test('held Open and quick-note folder dialogs refuse overlapping draft writes', {
  timeout: 30000,
}, async (t) => {
  const { app } = await setup(t)
  for (const fromAddon of [false, true]) {
    await app.evaluate(async ({ dialog }, fromAddon) => {
      const state = globalThis.fileLockTest
      state.results = {}
      state.pending = {}
      const held = Promise.withResolvers()
      const entered = Promise.withResolvers()
      state.release = held.resolve
      dialog.showOpenDialog = async () => {
        entered.resolve()
        await held.promise
        return { canceled: true, filePaths: [] }
      }
      if (fromAddon)
        state.start('dialog', 'addon-windows:invoke', true, 'chooseWorkspace')
      else state.start('dialog', 'document:open', false)
      await entered.promise
      state.start('write', 'addon-windows:invoke', true, 'saveDraft', {
        markdown: 'waiting for user',
        destination: null,
      })
      await new Promise(setImmediate)
    }, fromAddon)
    try {
      assert.match(
        await app.evaluate(
          () => globalThis.fileLockTest.results.write?.error ?? '',
        ),
        /Another file operation is in progress/,
      )
    } finally {
      await app.evaluate(async () => {
        const state = globalThis.fileLockTest
        state.release()
        await Promise.all(Object.values(state.pending))
      })
    }
  }
})

test('opening and quitting an untouched capture preserves the previous draft', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-capture-mount-'))
  const markdown = 'draft from the previous session'
  const draftPath = join(profile, 'quick-note-draft.json')
  await writeFile(join(profile, 'addons.json'), '{"quick-note":true}')
  await writeFile(draftPath, JSON.stringify({ markdown }))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  const child = app.process()
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine)
  await app.evaluate(({ ipcMain }) => {
    const channel = 'addon-windows:invoke'
    const invoke = ipcMain._invokeHandlers.get(channel)
    const saved = Promise.withResolvers()
    globalThis.captureMount = { events: [], saved: saved.promise }
    ipcMain._invokeHandlers.set(channel, async (...args) => {
      const method = args[1]
      if (!['openDraft', 'saveDraft'].includes(method)) return invoke(...args)
      const events = globalThis.captureMount.events
      events.push([method, 'start', args[2]?.markdown ?? null])
      const value = await invoke(...args)
      events.push([method, 'done', value])
      if (method === 'saveDraft') saved.resolve({ input: args[2], value })
      return value
    })
  })
  const opened = app.waitForEvent('window')
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Quick note: capture')
  await page.getByRole('option', { name: /Quick note: capture/i }).click()
  const capture = await opened
  const editor = capture.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await editor.waitFor()
  assert.equal(
    await capture
      .locator(
        t.formattedEngine === 'tiptap'
          ? '.tiptap[contenteditable="true"]'
          : '.hibi-formatted .cm-content[contenteditable="true"]',
      )
      .count(),
    1,
    'quick note uses the selected formatted engine',
  )
  assert.equal(await editor.textContent(), markdown)
  const saved = await app.evaluate(() => globalThis.captureMount.saved)
  assert.deepEqual(saved, { input: { markdown }, value: { keptAs: null } })
  const events = await app.evaluate(() => globalThis.captureMount.events)
  t.diagnostic(`capture mount: ${JSON.stringify(events)}`)
  assert.deepEqual(events.slice(0, 2), [
    ['openDraft', 'start', null],
    ['openDraft', 'done', { status: 'ready', draft: { markdown } }],
  ])
  assert.deepEqual(events[2], ['saveDraft', 'start', markdown])
  await app.close()
  assert.equal(JSON.parse(await readFile(draftPath, 'utf8')).markdown, markdown)
})
