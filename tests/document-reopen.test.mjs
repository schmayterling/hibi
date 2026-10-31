import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  electron,
  waitForAsync,
  waitForDocumentEditor,
  waitForFormattedEditor,
} from './electron.mjs'
import { clickMenu, replaceRichText, splitTab } from './keyboard.mjs'

// Resolves once main has finished the next request on this channel.
async function replied(app, channel) {
  await app.evaluate(({ ipcMain }, channel) => {
    const original = ipcMain._invokeHandlers.get(channel)
    globalThis.reopenReply = new Promise((resolve) => {
      ipcMain._invokeHandlers.set(channel, async (...args) => {
        ipcMain._invokeHandlers.set(channel, original)
        try {
          return await original(...args)
        } finally {
          resolve()
        }
      })
    })
  }, channel)
  return () => app.evaluate(() => globalThis.reopenReply)
}

async function setup(t) {
  await mkdir('.scratch', { recursive: true })
  const root = await mkdtemp(resolve('.scratch/reopen-'))
  const notes = join(root, 'notes')
  const file = join(notes, 'note.md')
  await mkdir(notes)
  await writeFile(file, 'original text\n')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        globalThis.reopenGate?.releaseRead()
        globalThis.reopenGate?.releaseReply()
        globalThis.reopenGate?.restore()
        globalThis.chunkGate?.release()
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await waitForFormattedEditor(app, page)
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog, BrowserWindow }, file) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.setBackgroundThrottling(false)
    globalThis.reopenPrompts = []
    globalThis.reopenChoice = 2
    globalThis.reopenPath = file
    dialog.showMessageBox = async (_window, options) => {
      globalThis.reopenPrompts.push(options)
      return { response: globalThis.reopenChoice }
    }
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [globalThis.reopenPath],
    })
  }, file)
  const read = () => page.evaluate(() => window.hibi.getDocument())
  const idle = () =>
    page.waitForFunction(
      () =>
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
    )
  const open = async () => {
    const done = await replied(app, 'document:open')
    await clickMenu(app, 'Open…')
    await done()
    await idle()
  }
  const select = async (id) => {
    const done = await replied(app, 'document:select-tab')
    await page.locator(`#document-tab-${id}`).click()
    await done()
    await idle()
  }
  const answer = (choice, path = null) =>
    app.evaluate(
      (_electron, [choice, path]) => {
        if (choice !== null) globalThis.reopenChoice = choice
        if (path) globalThis.reopenPath = path
      },
      [choice, path],
    )
  const prompts = () =>
    app.evaluate(() =>
      globalThis.reopenPrompts.splice(0).map((prompt) => prompt.message),
    )
  const state = async () => {
    const { tabId, markdown, dirty, ephemeral } = await read()
    return { tabId, markdown, dirty, ephemeral }
  }
  const type = async (text) => {
    await replaceRichText(
      page,
      page.locator('.rich-pane [aria-label="Document editor"]'),
      text,
    )
    await waitForAsync(
      page,
      async (text) => {
        const current = await window.hibi.getDocument()
        return current.dirty && current.markdown.includes(text)
      },
      text,
    )
    return (await read()).markdown
  }
  const workspace = async () => {
    await answer(2, notes)
    await page
      .getByRole('button', { name: /toggle workspace sidebar/i })
      .click()
    await page
      .getByRole('button', { name: /^open workspace$/i, exact: true })
      .click()
    await page.getByRole('treeitem', { name: /^note\.md/ }).waitFor()
  }
  const content = async (text) => {
    await page.waitForFunction((text) => {
      const editor = document.querySelector(
        '.rich-pane [aria-label="Document editor"]',
      )
      return editor?.textContent.includes(text)
    }, text.trim())
    assert.equal((await read()).markdown, text)
  }
  // Waits for a toast and checks that no toast shows a raw system error.
  const notice = async (text) => {
    await page.locator('.toast').filter({ hasText: text }).first().waitFor()
    const toasts = await page.locator('.toast').allTextContents()
    assert.deepEqual(
      toasts.filter((toast) => /ENOENT|remote method/.test(toast)),
      [],
    )
  }
  await open()
  await content('original text\n')
  return {
    app,
    page,
    notes,
    file,
    read,
    idle,
    open,
    content,
    select,
    answer,
    prompts,
    state,
    type,
    workspace,
    notice,
  }
}

async function gateReadAndReply(app, file) {
  await app.evaluate(async ({ ipcMain }, file) => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const target = await fs.stat(file),
      handle = await fs.open(file, 'r')
    const prototype = Object.getPrototypeOf(handle)
    await handle.close()
    const stat = prototype.stat,
      read = prototype.read
    const handles = new WeakSet()
    let enterRead, releaseRead, enterReply, releaseReply
    const reading = new Promise((resolve) => {
      enterRead = resolve
    })
    const readReady = new Promise((resolve) => {
      releaseRead = resolve
    })
    const replying = new Promise((resolve) => {
      enterReply = resolve
    })
    const replyReady = new Promise((resolve) => {
      releaseReply = resolve
    })
    let blocked = false
    prototype.stat = async function (...args) {
      const info = await stat.apply(this, args)
      if (info.dev === target.dev && info.ino === target.ino) handles.add(this)
      return info
    }
    prototype.read = async function (...args) {
      if (!blocked && handles.has(this)) {
        blocked = true
        enterRead()
        await readReady
      }
      return read.apply(this, args)
    }
    const original = ipcMain._invokeHandlers.get('document:open')
    ipcMain._invokeHandlers.set('document:open', async (...args) => {
      const result = await original(...args)
      enterReply()
      await replyReady
      return result
    })
    globalThis.reopenGate = {
      reading,
      replying,
      releaseRead,
      releaseReply,
      restore() {
        prototype.stat = stat
        prototype.read = read
        ipcMain._invokeHandlers.set('document:open', original)
      },
    }
  }, file)
}

for (const slowChunk of [false, true])
  test(`reopening publishes disk text during file and IPC delays${slowChunk ? ' with a held renderer chunk' : ''}`, {
    timeout: 60000,
  }, async (t) => {
    const { app, page, file, read, idle, content } = await setup(t)
    if (slowChunk) {
      const chunks = JSON.parse(
        await readFile('out/renderer/startup-bundle.json', 'utf8'),
      )
      const module = `src/renderer/src/FormattedEditor.tsx`
      const asset = chunks.find((chunk) => chunk.modules.includes(module)).file
      await app.evaluate(({ app, protocol, net }, asset) => {
        const { join } = process.getBuiltinModule('node:path')
        const { pathToFileURL } = process.getBuiltinModule('node:url')
        let enter, release
        const entered = new Promise((resolve) => {
          enter = resolve
        })
        const ready = new Promise((resolve) => {
          release = resolve
        })
        globalThis.chunkGate = { entered, release }
        protocol.unhandle('app')
        protocol.handle('app', async (request) => {
          const pathname = new URL(request.url).pathname
          if (pathname === `/${asset}`) {
            enter()
            await ready
          }
          return net.fetch(
            pathToFileURL(
              join(
                app.getAppPath(),
                'out/renderer',
                pathname === '/' ? 'index.html' : pathname,
              ),
            ).href,
          )
        })
      }, asset)
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
      await page.reload({ waitUntil: 'commit' })
      await app.evaluate(() => globalThis.chunkGate.entered)
      await page.locator('.titlebar').waitFor()
    }
    const before = await read()
    await writeFile(file, 'external replacement\n')
    await gateReadAndReply(app, file)
    await clickMenu(app, 'Open…')
    await app.evaluate(() => globalThis.reopenGate.reading)
    // This metadata read replaces the active tab's cached snapshot while fs waits.
    assert.equal((await read()).markdown, before.markdown)
    await app.evaluate(() => globalThis.reopenGate.releaseRead())
    await app.evaluate(() => globalThis.reopenGate.replying)
    const duringReply = await read()
    await app.evaluate(() => globalThis.reopenGate.releaseReply())
    await idle()
    t.diagnostic(
      JSON.stringify({
        before: before.revision,
        after: duringReply.revision,
        text: duringReply.markdown,
      }),
    )
    assert.ok(duringReply.revision > before.revision)
    assert.equal(duringReply.markdown, 'external replacement\n')
    if (slowChunk) await app.evaluate(() => globalThis.chunkGate.release())
    await content('external replacement\n')
    assert.equal((await read()).dirty, false)
    assert.equal(await app.evaluate(() => globalThis.reopenPrompts.length), 0)
    assert.equal(await readFile(file, 'utf8'), 'external replacement\n')
    // Include a late renderer turn before inspecting the installed editor again.
    await page.evaluate(() => {
      const until = performance.now() + 250
      while (performance.now() < until) {}
    })
    await content('external replacement\n')
  })

test('Open repeatedly refreshes the active document after external writes', {
  timeout: 120000,
}, async (t) => {
  const { app, page, file, read, idle, content } = await setup(t)
  let previous = await read()
  for (let index = 0; index < 20; index++) {
    const text = `external text ${index}\n`
    await writeFile(file, text)
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async (revision) => (await window.hibi.getDocument()).revision > revision,
      previous.revision,
    )
    await idle()
    await content(text)
    const next = await read()
    assert.equal(next.tabId, previous.tabId)
    assert.ok(next.revision > previous.revision)
    assert.ok(next.contentVersion > previous.contentVersion)
    assert.equal(next.dirty, false)
    previous = next
  }
  assert.equal(await app.evaluate(() => globalThis.reopenPrompts.length), 0)
})

for (const route of ['Open…', 'Finder', 'link', 'explorer'])
  test(`${route} returns to edits and asks before replacing edits whose file changed`, {
    timeout: 120000,
  }, async (t) => {
    const setupState = await setup(t)
    const { app, page, notes, file, read, idle, content } = setupState
    const { select, answer, prompts, state, type, workspace } = setupState
    const note = (await read()).tabId
    // The link sits below the first line, where the formatted view shows it rendered.
    await writeFile(
      join(notes, 'other.md'),
      'other note\n\nsee [note](note.md)\n',
    )
    await workspace()
    const row = (name) => page.getByRole('treeitem', { name })
    const link = page
      .locator('.rich-pane')
      .getByRole('link', { name: 'note', exact: true })
    let done = await replied(app, 'workspace:open-file')
    await row(/^other\.md/).click()
    await done()
    await idle()
    await link.waitFor()
    const other = (await read()).tabId
    const [channel, run] = {
      'Open…': [
        'document:open',
        async () => {
          await answer(null, file)
          await clickMenu(app, 'Open…')
        },
      ],
      Finder: [
        'document:external',
        () =>
          app.evaluate(
            ({ app }, file) =>
              app.emit('open-file', { preventDefault() {} }, file),
            file,
          ),
      ],
      link: ['document:link', () => link.click({ modifiers: ['Shift'] })],
      explorer: ['workspace:open-file', () => row(/^note\.md/).click()],
    }[route]
    const reopen = async (choice) => {
      await select(other)
      assert.deepEqual(await prompts(), [])
      await answer(choice)
      done = await replied(app, channel)
      await run()
      await done()
      await idle()
      return prompts()
    }
    await select(note)
    const draft = await type('local draft')
    // An unchanged file returns to the edits without asking.
    assert.deepEqual(await reopen(2), [])
    assert.deepEqual(await state(), {
      tabId: note,
      markdown: draft,
      dirty: true,
      ephemeral: false,
    })
    // After an outside change it asks like Open…, and Cancel keeps both texts.
    await writeFile(file, 'outside text\n')
    assert.deepEqual(await reopen(2), ['Save changes to note.md?'])
    assert.equal((await read()).tabId, other)
    assert.equal(await readFile(file, 'utf8'), 'outside text\n')
    // That change was reported, so switching to the edits does not ask again.
    await select(note)
    assert.deepEqual(await prompts(), [])
    await content(draft)
    // Don't save shows the file's text.
    assert.deepEqual(await reopen(1), ['Save changes to note.md?'])
    assert.deepEqual(await state(), {
      tabId: note,
      markdown: 'outside text\n',
      dirty: false,
      ephemeral: false,
    })
    await content('outside text\n')
    // Save asks before replacing the outside change, then keeps the edits.
    const saved = await type('saved draft')
    await writeFile(file, 'another outside text\n')
    assert.deepEqual(await reopen(0), [
      'Save changes to note.md?',
      'note.md changed outside Hibi.',
    ])
    assert.deepEqual(await state(), {
      tabId: note,
      markdown: saved,
      dirty: false,
      ephemeral: false,
    })
    assert.equal(await readFile(file, 'utf8'), saved)
    await content(saved)
  })

test('switching to edits whose file changed outside Hibi asks once, by name, to replace it', {
  timeout: 120000,
}, async (t) => {
  const setupState = await setup(t)
  const { notes, file, read, open, content } = setupState
  const { select, answer, prompts, state, type } = setupState
  const note = (await read()).tabId
  await writeFile(join(notes, 'other.md'), 'other note\n')
  await answer(2, join(notes, 'other.md'))
  await open()
  await content('other note\n')
  const other = (await read()).tabId
  await select(note)
  const draft = await type('local draft')
  // Ordinary switches keep the edits without asking.
  await select(other)
  await select(note)
  assert.deepEqual(await prompts(), [])
  // An outside change asks once; Cancel keeps the edits and the file.
  await select(other)
  await writeFile(file, 'outside text\n')
  await answer(1)
  await select(note)
  assert.deepEqual(await prompts(), ['note.md changed outside Hibi.'])
  assert.deepEqual(await state(), {
    tabId: note,
    markdown: draft,
    dirty: true,
    ephemeral: false,
  })
  await content(draft)
  assert.equal(await readFile(file, 'utf8'), 'outside text\n')
  await select(other)
  await select(note)
  assert.deepEqual(await prompts(), [])
  // A later outside change asks again, and Replace saves the edits.
  await select(other)
  await writeFile(file, 'another outside text\n')
  await answer(0)
  await select(note)
  assert.deepEqual(await prompts(), ['note.md changed outside Hibi.'])
  assert.deepEqual(await state(), {
    tabId: note,
    markdown: draft,
    dirty: false,
    ephemeral: false,
  })
  assert.equal(await readFile(file, 'utf8'), draft)
  await content(draft)
  // A clean tab takes outside changes without asking.
  await select(other)
  await writeFile(file, 'final outside text\n')
  await select(note)
  assert.deepEqual(await prompts(), [])
  await content('final outside text\n')
  assert.equal((await read()).dirty, false)
})

test('another outside write while Hibi asks to replace a file asks again', {
  timeout: 120000,
}, async (t) => {
  const setupState = await setup(t)
  const { app, page, notes, file, read, open, content } = setupState
  const { select, answer, prompts, type } = setupState
  const note = (await read()).tabId
  await writeFile(join(notes, 'other.md'), 'other note\n')
  await answer(2, join(notes, 'other.md'))
  await open()
  await content('other note\n')
  const other = (await read()).tabId
  await select(note)
  const draft = await type('local draft')
  await select(other)
  await writeFile(file, 'outside text\n')
  // Another app writes again while the first replace prompt is open.
  await app.evaluate(({ dialog }, file) => {
    const ask = dialog.showMessageBox
    let writes = 1
    dialog.showMessageBox = async (window, options) => {
      if (options.message === 'note.md changed outside Hibi.' && writes-- > 0)
        process
          .getBuiltinModule('node:fs')
          .writeFileSync(file, 'later outside text\n')
      return ask(window, options)
    }
  }, file)
  await answer(0)
  await select(note)
  assert.deepEqual(await prompts(), [
    'note.md changed outside Hibi.',
    'note.md changed outside Hibi.',
  ])
  assert.equal(await readFile(file, 'utf8'), draft)
  // Version history keeps the text that Replace overwrote.
  const versions = await page.evaluate(async () =>
    Promise.all(
      (await window.hibi.listVersions()).map((version) =>
        window.hibi.previewVersion(version.id),
      ),
    ),
  )
  assert.ok(versions.includes('later outside text\n'))
})

test('opening the planned file of an unsaved draft discards or saves the draft', {
  timeout: 120000,
}, async (t) => {
  const setupState = await setup(t)
  const { app, page, notes, read, idle, open, content } = setupState
  const { select, answer, prompts, state, type, workspace } = setupState
  const note = (await read()).tabId
  await workspace()
  const draft = async (name) => {
    await page
      .getByRole('button', { name: 'New workspace file', exact: true })
      .click()
    const rename = page.getByRole('textbox', {
      name: 'Rename item',
      exact: true,
    })
    await rename.waitFor()
    await rename.fill(`${name}.md`)
    await rename.press('Enter')
    await rename.waitFor({ state: 'hidden' })
    await idle()
    const markdown = await type(`${name} draft`)
    const current = await read()
    assert.deepEqual([current.name, current.ephemeral], [`${name}.md`, true])
    return { tabId: current.tabId, markdown, file: join(notes, `${name}.md`) }
  }
  // Another app creates a file at the draft's planned name. Choosing it in
  // the explorer asks like Open…, and Cancel keeps the draft.
  const first = await draft('first')
  await writeFile(first.file, 'outside first\n')
  await select(note)
  await answer(2, first.file)
  const done = await replied(app, 'workspace:open-file')
  await page.getByRole('treeitem', { name: /^first\.md/ }).click()
  await done()
  await idle()
  assert.deepEqual(await prompts(), ['Save changes to first.md?'])
  assert.equal((await read()).tabId, note)
  // Don't save discards the draft and opens that file in its tab.
  await answer(1)
  await open()
  assert.deepEqual(await prompts(), ['Save changes to first.md?'])
  assert.deepEqual(await state(), {
    tabId: first.tabId,
    markdown: 'outside first\n',
    dirty: false,
    ephemeral: false,
  })
  await content('outside first\n')
  // Save asks before replacing the file, instead of failing because it exists.
  const second = await draft('second')
  await writeFile(second.file, 'outside second\n')
  await answer(0, second.file)
  await open()
  assert.deepEqual(await prompts(), [
    'Save changes to second.md?',
    'second.md changed outside Hibi.',
  ])
  assert.deepEqual(await state(), {
    tabId: second.tabId,
    markdown: second.markdown,
    dirty: false,
    ephemeral: false,
  })
  assert.equal(await readFile(second.file, 'utf8'), second.markdown)
  await content(second.markdown)
})

test('reopening a dirty document prompts before discarding external or local text', {
  timeout: 60000,
}, async (t) => {
  const { app, page, file, read, open, content } = await setup(t)
  const editor = page.locator('.rich-pane [aria-label="Document editor"]')
  await replaceRichText(page, editor, 'local draft')
  await page.waitForFunction(
    async () => (await window.hibi.getDocument()).dirty,
  )
  await writeFile(file, 'external replacement\n')
  const before = await read()
  await open()
  assert.equal(await app.evaluate(() => globalThis.reopenPrompts.length), 1)
  assert.deepEqual(await read(), before)
  await content(before.markdown)
  assert.equal(await readFile(file, 'utf8'), 'external replacement\n')
  await app.evaluate(() => {
    globalThis.reopenChoice = 1
  })
  await open()
  await content('external replacement\n')
  assert.equal((await read()).dirty, false)
  assert.equal(await app.evaluate(() => globalThis.reopenPrompts.length), 2)
  assert.equal(await readFile(file, 'utf8'), 'external replacement\n')

  await replaceRichText(page, editor, 'saved local draft')
  await page.waitForFunction(
    async () => (await window.hibi.getDocument()).dirty,
  )
  await writeFile(file, 'another external replacement\n')
  await app.evaluate(() => {
    globalThis.reopenChoice = 0
  })
  await open()
  const saved = await read()
  await content(saved.markdown)
  assert.equal(saved.markdown.trim(), 'saved local draft')
  assert.equal(saved.dirty, false)
  assert.equal(await readFile(file, 'utf8'), saved.markdown)
  assert.deepEqual(
    await app.evaluate(() =>
      globalThis.reopenPrompts.slice(2).map((prompt) => prompt.message),
    ),
    ['Save changes to note.md?', 'note.md changed outside Hibi.'],
  )
})

test('Cancel on one note still opens the other files from Finder', {
  timeout: 120000,
}, async (t) => {
  const setupState = await setup(t)
  const { app, notes, file, read, idle, content } = setupState
  const { select, answer, prompts, state, type } = setupState
  const note = (await read()).tabId
  const draft = await type('local draft')
  await writeFile(file, 'outside text\n')
  const later = join(notes, 'later.md')
  await writeFile(later, 'later note\n')
  // The note's folder under another name; a junction needs no rights on Windows.
  const linked = join(dirname(notes), 'linked')
  await symlink(notes, linked, 'junction')
  // One request names the note twice and opens the other file, and Cancel
  // answers the note's only prompt.
  await answer(2)
  const done = await replied(app, 'document:external')
  await app.evaluate(
    ({ app }, paths) =>
      app.emit(
        'second-instance',
        {},
        ['electron', 'app', ...paths],
        process.cwd(),
      ),
    [file, join(linked, 'note.md'), later],
  )
  await done()
  await idle()
  assert.deepEqual(await prompts(), ['Save changes to note.md?'])
  await content('later note\n')
  // Cancel kept the note's edits and the outside text.
  await select(note)
  assert.deepEqual(await prompts(), [])
  assert.deepEqual(await state(), {
    tabId: note,
    markdown: draft,
    dirty: true,
    ephemeral: false,
  })
  assert.equal(await readFile(file, 'utf8'), 'outside text\n')
})

for (const change of ['deleted', 'moved'])
  test(`Don't save keeps the edits when the file is ${change} during the prompt`, {
    timeout: 120000,
  }, async (t) => {
    const setupState = await setup(t)
    const { app, notes, file, read, idle, open } = setupState
    const { answer, prompts, state, type, notice } = setupState
    const note = (await read()).tabId
    const draft = await type('local draft')
    await writeFile(file, 'outside text\n')
    const moved = change === 'moved' ? join(notes, 'moved.md') : null
    // Another app moves or deletes the file while Hibi asks.
    await app.evaluate(
      ({ dialog }, [file, moved]) => {
        const ask = dialog.showMessageBox
        dialog.showMessageBox = async (window, options) => {
          dialog.showMessageBox = ask
          const fs = process.getBuiltinModule('node:fs')
          if (moved) fs.renameSync(file, moved)
          else fs.unlinkSync(file)
          return ask(window, options)
        }
      },
      [file, moved],
    )
    await answer(1)
    await open()
    assert.deepEqual(await prompts(), ['Save changes to note.md?'])
    await notice(
      'note.md was moved or deleted outside Hibi. Save to keep this text.',
    )
    assert.deepEqual(await state(), {
      tabId: note,
      markdown: draft,
      dirty: true,
      ephemeral: false,
    })
    // Saving writes the kept edits back after asking.
    await answer(0)
    const done = await replied(app, 'document:save')
    await clickMenu(app, 'Save')
    await done()
    await idle()
    assert.deepEqual(await prompts(), ['note.md changed outside Hibi.'])
    assert.equal(await readFile(file, 'utf8'), draft)
    if (moved) assert.equal(await readFile(moved, 'utf8'), 'outside text\n')
    assert.equal((await read()).dirty, false)
  })

test('switching to a clean tab whose file was deleted keeps its text', {
  timeout: 120000,
}, async (t) => {
  const setupState = await setup(t)
  const { app, notes, file, read, idle, open, content } = setupState
  const { select, answer, prompts, state, notice } = setupState
  const note = (await read()).tabId
  await writeFile(join(notes, 'other.md'), 'other note\n')
  await answer(2, join(notes, 'other.md'))
  await open()
  await content('other note\n')
  await rm(file)
  await select(note)
  assert.deepEqual(await prompts(), [])
  await notice(
    'note.md was moved or deleted outside Hibi. Save to keep this text.',
  )
  assert.deepEqual(await state(), {
    tabId: note,
    markdown: 'original text\n',
    dirty: false,
    ephemeral: false,
  })
  await content('original text\n')
  // Saving writes the text back after asking.
  await answer(0)
  const done = await replied(app, 'document:save')
  await clickMenu(app, 'Save')
  await done()
  await idle()
  assert.deepEqual(await prompts(), ['note.md changed outside Hibi.'])
  assert.equal(await readFile(file, 'utf8'), 'original text\n')
})

test('focusing a split pane asks once to replace edits whose file changed', {
  timeout: 150000,
}, async (t) => {
  const setupState = await setup(t)
  const { app, page, notes, file, read, idle, open, content } = setupState
  const { select, answer, prompts, state, type } = setupState
  const note = (await read()).tabId
  await writeFile(join(notes, 'other.md'), 'other note\n')
  await answer(2, join(notes, 'other.md'))
  await open()
  await content('other note\n')
  const other = (await read()).tabId
  await select(note)
  const draft = await type('local draft')
  await splitTab(app, page, other)
  const active = (id) =>
    waitForAsync(
      page,
      async (id) => (await window.hibi.getDocument()).tabId === id,
      id,
    )
  await active(other)
  await idle()
  const focus = async (side, id) => {
    const done = await replied(app, 'document:focus-tab')
    await page
      .locator(
        `.editor-page[data-side="${side}"] .rich-pane [aria-label="Document editor"]`,
      )
      .click()
    await done()
    await idle()
    await active(id)
  }
  // An outside change asks once; Cancel keeps the edits and the file.
  await writeFile(file, 'outside text\n')
  await answer(1)
  await focus('left', note)
  assert.deepEqual(await prompts(), ['note.md changed outside Hibi.'])
  assert.deepEqual(await state(), {
    tabId: note,
    markdown: draft,
    dirty: true,
    ephemeral: false,
  })
  assert.equal(await readFile(file, 'utf8'), 'outside text\n')
  await focus('right', other)
  await focus('left', note)
  assert.deepEqual(await prompts(), [])
  // A later outside change asks again, and Replace saves the edits.
  await focus('right', other)
  await writeFile(file, 'another outside text\n')
  await answer(0)
  await focus('left', note)
  assert.deepEqual(await prompts(), ['note.md changed outside Hibi.'])
  assert.deepEqual(await state(), {
    tabId: note,
    markdown: draft,
    dirty: false,
    ephemeral: false,
  })
  assert.equal(await readFile(file, 'utf8'), draft)
})

test('a link to the note itself, its explorer row and dropping it check for outside changes', {
  timeout: 150000,
}, async (t) => {
  const setupState = await setup(t)
  const { app, page, file, read, idle, open } = setupState
  const { answer, prompts, state, workspace, notice } = setupState
  const note = (await read()).tabId
  // The links sit below the first line, where the formatted view shows them rendered.
  const links = '\n\nsee [self](note.md) and [gone](gone.md)\n'
  await writeFile(file, `original text${links}`)
  await open()
  await workspace()
  const editor = page.locator('.rich-pane [aria-label="Document editor"]')
  const link = (name) => editor.getByRole('link', { name, exact: true })
  await link('self').waitFor()
  const routes = {
    self: ['document:link', () => link('self').click({ modifiers: ['Shift'] })],
    gone: ['document:link', () => link('gone').click({ modifiers: ['Shift'] })],
    row: [
      'workspace:open-file',
      () => page.getByRole('treeitem', { name: /^note\.md/ }).click(),
    ],
    drop: [
      'media:open-dropped',
      async () => {
        const cdp = await page.context().newCDPSession(page)
        for (const type of ['dragEnter', 'dragOver', 'drop'])
          await cdp.send('Input.dispatchDragEvent', {
            type,
            x: 600,
            y: 300,
            data: { items: [], files: [file], dragOperationsMask: 1 },
          })
        await cdp.detach()
      },
    ],
  }
  const reopen = async (route, choice = 2) => {
    await answer(choice)
    const [channel, run] = routes[route]
    const done = await replied(app, channel)
    await run()
    await done()
    await idle()
    return prompts()
  }
  // Typing on the first line keeps both links rendered.
  await editor.getByText('original text').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' edited')
  await waitForAsync(page, async () => {
    const current = await window.hibi.getDocument()
    return current.dirty && current.markdown.includes(' edited')
  })
  const draft = (await read()).markdown
  // An unchanged file keeps the edits and their undo history without asking.
  assert.deepEqual(await reopen('self'), [])
  assert.deepEqual(await reopen('row'), [])
  assert.deepEqual(await reopen('drop'), [])
  assert.deepEqual(await state(), {
    tabId: note,
    markdown: draft,
    dirty: true,
    ephemeral: false,
  })
  await editor.getByText('original text edited').click()
  await page.keyboard.press('ControlOrMeta+z')
  await waitForAsync(
    page,
    async () => !(await window.hibi.getDocument()).markdown.includes(' edited'),
  )
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await waitForAsync(
    page,
    async (draft) => (await window.hibi.getDocument()).markdown === draft,
    draft,
  )
  // After an outside change each asks like any reopen, and Cancel keeps the edits.
  await writeFile(file, `outside text${links}`)
  assert.deepEqual(await reopen('self'), ['Save changes to note.md?'])
  assert.deepEqual(await reopen('row'), ['Save changes to note.md?'])
  assert.deepEqual(await reopen('drop'), ['Save changes to note.md?'])
  assert.deepEqual(await state(), {
    tabId: note,
    markdown: draft,
    dirty: true,
    ephemeral: false,
  })
  // Don't save shows the file's text.
  assert.deepEqual(await reopen('self', 1), ['Save changes to note.md?'])
  assert.deepEqual(await state(), {
    tabId: note,
    markdown: `outside text${links}`,
    dirty: false,
    ephemeral: false,
  })
  // A clean note takes a later outside change without asking.
  await writeFile(file, `dropped text${links}`)
  assert.deepEqual(await reopen('drop'), [])
  await editor.getByText('dropped text').waitFor()
  await writeFile(file, `final text${links}`)
  assert.deepEqual(await reopen('row'), [])
  await editor.getByText('final text').waitFor()
  assert.equal((await read()).markdown, `final text${links}`)
  // A missing link target and a deleted note get plain messages.
  await reopen('gone')
  await notice('Could not find gone.md.')
  await rm(file)
  assert.deepEqual(await reopen('self'), [])
  await notice(
    'note.md was moved or deleted outside Hibi. Save to keep this text.',
  )
  assert.deepEqual(await state(), {
    tabId: note,
    markdown: `final text${links}`,
    dirty: false,
    ephemeral: false,
  })
})

test('closing a tab checks the tab shown next for outside changes', {
  timeout: 150000,
}, async (t) => {
  const setupState = await setup(t)
  const { app, page, notes, file, read, idle, open, content } = setupState
  const { answer, prompts, state, type } = setupState
  const note = (await read()).tabId
  const close = async () => {
    const done = await replied(app, 'document:close-tab')
    await page.getByRole('button', { name: /^close other\.md$/i }).click()
    await done()
    await idle()
    return prompts()
  }
  await writeFile(join(notes, 'other.md'), 'other note\n')
  await answer(2, join(notes, 'other.md'))
  await open()
  await content('other note\n')
  // A clean tab shows its file's latest text, as a tab switch does.
  await writeFile(file, 'outside text\n')
  assert.deepEqual(await close(), [])
  assert.deepEqual(await state(), {
    tabId: note,
    markdown: 'outside text\n',
    dirty: false,
    ephemeral: false,
  })
  await content('outside text\n')
  // Edits whose file changed ask once; Cancel keeps the edits and the file.
  const draft = await type('local draft')
  await open()
  await content('other note\n')
  await writeFile(file, 'another outside text\n')
  await answer(1)
  assert.deepEqual(await close(), ['note.md changed outside Hibi.'])
  assert.deepEqual(await state(), {
    tabId: note,
    markdown: draft,
    dirty: true,
    ephemeral: false,
  })
  await content(draft)
  assert.equal(await readFile(file, 'utf8'), 'another outside text\n')
})

test('closing a tab still shows the next tab when its file cannot be read', {
  timeout: 150000,
}, async (t) => {
  const setupState = await setup(t)
  const { app, page, notes, file, read, idle, open, content } = setupState
  const { answer, prompts, state, notice } = setupState
  const note = (await read()).tabId
  await writeFile(join(notes, 'other.md'), 'other note\n')
  await answer(2, join(notes, 'other.md'))
  await open()
  await content('other note\n')
  // Another app puts a folder where the next tab's file was.
  await rm(file)
  await mkdir(file)
  const done = await replied(app, 'document:close-tab')
  await page.getByRole('button', { name: /^close other\.md$/i }).click()
  await done()
  await idle()
  await notice('Choose a text file, not a folder or device.')
  assert.deepEqual(await prompts(), [])
  assert.deepEqual(await state(), {
    tabId: note,
    markdown: 'original text\n',
    dirty: false,
    ephemeral: false,
  })
  await content('original text\n')
})

test('a tab that changes while Hibi asks about the next tab stays open and says why', {
  timeout: 150000,
}, async (t) => {
  const setupState = await setup(t)
  const { app, page, notes, file, read, idle, open, content } = setupState
  const { select, answer, prompts, state, type, notice } = setupState
  const note = (await read()).tabId
  await writeFile(join(notes, 'other.md'), 'other note\n')
  await answer(2, join(notes, 'other.md'))
  await open()
  await content('other note\n')
  const other = (await read()).tabId
  await select(note)
  await type('local draft')
  await select(other)
  await writeFile(file, 'outside text\n')
  // The next tab's prompt waits for an answer, then Cancel keeps both texts.
  await app.evaluate(({ dialog }) => {
    const asked = Promise.withResolvers()
    const answered = Promise.withResolvers()
    dialog.showMessageBox = async (_window, options) => {
      globalThis.reopenPrompts.push(options)
      asked.resolve()
      await answered.promise
      return { response: 1 }
    }
    globalThis.closePrompt = {
      asked: asked.promise,
      cancel: answered.resolve,
    }
  })
  const done = await replied(app, 'document:close-tab')
  await page.getByRole('button', { name: /^close other\.md$/i }).click()
  await app.evaluate(() => globalThis.closePrompt.asked)
  // The closing tab changes meanwhile, as a late keystroke or an addon can.
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({
      changes: {
        from: view.state.doc.length,
        insert: ' typed while closing',
      },
    })
  })
  // Requests send pending edits first, so main has the change after this.
  await page.evaluate(() => window.hibi.getDocument())
  await app.evaluate(() => globalThis.closePrompt.cancel())
  await done()
  await idle()
  await notice(
    'The tab for other.md stayed open because it changed while Hibi was closing it.',
  )
  assert.deepEqual(await prompts(), ['note.md changed outside Hibi.'])
  const after = await state()
  assert.equal(after.tabId, other)
  assert.match(after.markdown, /typed while closing/)
  assert.equal(after.dirty, true)
  assert.equal(await readFile(file, 'utf8'), 'outside text\n')
})

test('a link to a heading of another note or the note itself moves to the heading', {
  timeout: 150000,
}, async (t) => {
  const setupState = await setup(t)
  const { app, page, notes, file, read, idle, open, select } = setupState
  const { prompts } = setupState
  const note = (await read()).tabId
  // Both headings sit far below the links, out of view.
  const filler = Array.from(
    { length: 120 },
    (_, index) => `filler paragraph ${index}\n\n`,
  ).join('')
  const self = `original text\n\nsee [down](note.md#far-away) and [there](other.md#far-away)\n\n${filler}## Far away\n\nend\n`
  const other = `other note\n\n${filler}## Far away\n\nother end\n`
  await writeFile(file, self)
  await writeFile(join(notes, 'other.md'), other)
  await open()
  const editor = page.locator('.rich-pane [aria-label="Document editor"]')
  const follow = async (name) => {
    const done = await replied(app, 'document:link')
    await editor
      .getByRole('link', { name, exact: true })
      .click({ modifiers: ['Shift'] })
    await done()
    await idle()
    assert.deepEqual(await prompts(), [])
  }
  // The caret moves to the heading's text, and the heading is in view.
  const atHeading = async (markdown) => {
    const from = markdown.indexOf('## Far away') + 3
    await waitForAsync(
      page,
      (from) =>
        document.querySelector('.rich-pane .cm-content').cmTile.root.view.state
          .selection.main.head === from,
      from,
    )
    assert.equal(
      await editor.evaluate((element, from) => {
        const caret = element.cmTile.root.view.coordsAtPos(from)
        const pane = element.closest('.rich-pane').getBoundingClientRect()
        return (
          !!caret &&
          caret.top >= pane.top - 1 &&
          caret.bottom <= pane.bottom + 1
        )
      }, from),
      true,
    )
    assert.equal((await read()).markdown, markdown)
  }
  await follow('there')
  await atHeading(other)
  await select(note)
  await follow('down')
  assert.equal((await read()).tabId, note)
  await atHeading(self)
})

test('a missing Finder file and a moved note folder get plain messages', {
  timeout: 150000,
}, async (t) => {
  const setupState = await setup(t)
  const { app, page, notes, read, idle } = setupState
  const { prompts, state, type, notice } = setupState
  const note = (await read()).tabId
  // A missing file from Finder is named once.
  let done = await replied(app, 'document:external')
  await app.evaluate(
    ({ app }, path) =>
      app.emit('second-instance', {}, ['electron', 'app', path], process.cwd()),
    join(notes, 'gone.md'),
  )
  await done()
  await idle()
  await notice('Could not find gone.md.')
  assert.deepEqual(
    (await page.locator('.toast').allTextContents()).filter((toast) =>
      toast.includes('gone.md:'),
    ),
    [],
  )
  // Saving after another app moves the note's folder keeps the edits and says why.
  const draft = await type('local draft')
  await rename(notes, join(dirname(notes), 'moved'))
  done = await replied(app, 'document:save')
  await clickMenu(app, 'Save')
  await done()
  await idle()
  await notice(
    'The folder for note.md was moved or deleted outside Hibi. Use Save as to keep this text.',
  )
  assert.deepEqual(await prompts(), [])
  assert.deepEqual(await state(), {
    tabId: note,
    markdown: draft,
    dirty: true,
    ephemeral: false,
  })
})

test('a pane checks its file under the file-operation lock, so an autosave meanwhile is skipped', {
  timeout: 150000,
}, async (t) => {
  const setupState = await setup(t)
  const { app, page, notes, file, read, idle, open, content } = setupState
  const { select, answer, prompts, state, type } = setupState
  const note = (await read()).tabId
  await writeFile(join(notes, 'other.md'), 'other note\n')
  await answer(2, join(notes, 'other.md'))
  await open()
  await content('other note\n')
  const other = (await read()).tabId
  await select(note)
  const draft = await type('local draft')
  const { revision } = await read()
  await splitTab(app, page, other)
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    other,
  )
  await idle()
  assert.deepEqual(await prompts(), [])
  // Focusing the note's pane reads its changed file; hold that read.
  await writeFile(file, 'outside text\n')
  await gateReadAndReply(app, file)
  await answer(1)
  const focused = await replied(app, 'document:focus-tab')
  await page
    .locator(
      '.editor-page[data-side="left"] .rich-pane [aria-label="Document editor"]',
    )
    .click()
  await app.evaluate(() => globalThis.reopenGate.reading)
  // An autosave meanwhile is skipped, as it is during other file operations.
  const autosave = page.evaluate(
    ([id, revision]) => window.hibi.autosaveDocument(id, revision),
    [note, revision],
  )
  const early = await Promise.race([autosave, delay(10000, 'still waiting')])
  await app.evaluate(() => globalThis.reopenGate.releaseRead())
  await focused()
  await idle()
  assert.deepEqual(early, { status: 'skipped', document: null })
  assert.deepEqual(await prompts(), ['note.md changed outside Hibi.'])
  assert.deepEqual(await state(), {
    tabId: note,
    markdown: draft,
    dirty: true,
    ephemeral: false,
  })
  assert.equal(await readFile(file, 'utf8'), 'outside text\n')
})

test('clicking a split pane while the window waits to close does not change which note Save writes', {
  timeout: 150000,
}, async (t) => {
  const setupState = await setup(t)
  const { app, page, notes, file, read, idle, open, content } = setupState
  const { select, answer, prompts, type } = setupState
  const note = (await read()).tabId
  await writeFile(join(notes, 'other.md'), 'other note\n')
  await answer(2, join(notes, 'other.md'))
  await open()
  await content('other note\n')
  const other = (await read()).tabId
  const otherDraft = await type('other draft')
  await select(note)
  await type('local draft')
  const { revision } = await read()
  await splitTab(app, page, other)
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    other,
  )
  await idle()
  await prompts()
  // An autosave of note.md holds the file-operation lock while its read waits.
  await gateReadAndReply(app, file)
  const autosave = page.evaluate(
    ([id, revision]) => window.hibi.autosaveDocument(id, revision),
    [note, revision],
  )
  await app.evaluate(() => globalThis.reopenGate.reading)
  // The close asks about other.md and waits for Save. A pane click that
  // reaches main while the close waits runs once that prompt is open.
  await app.evaluate(({ dialog, ipcMain }) => {
    const asked = Promise.withResolvers()
    const answered = Promise.withResolvers()
    const focusing = Promise.withResolvers()
    const focused = Promise.withResolvers()
    dialog.showMessageBox = async (_window, options) => {
      globalThis.reopenPrompts.push(options)
      asked.resolve()
      await answered.promise
      return { response: 0 }
    }
    const channel = 'document:focus-tab'
    const original = ipcMain._invokeHandlers.get(channel)
    ipcMain._invokeHandlers.set(channel, async (...args) => {
      ipcMain._invokeHandlers.set(channel, original)
      focusing.resolve()
      await asked.promise
      try {
        return await original(...args)
      } finally {
        focused.resolve()
      }
    })
    globalThis.closeRace = {
      focusing: focusing.promise,
      focused: focused.promise,
      save: answered.resolve,
    }
  })
  await app.evaluate(
    ({ BrowserWindow }) =>
      new Promise((resolve) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.once('close', () => resolve())
        window.close()
      }),
  )
  await page
    .locator(
      '.editor-page[data-side="left"] .rich-pane [aria-label="Document editor"]',
    )
    .click()
  await app.evaluate(() => globalThis.closeRace.focusing)
  await app.evaluate(() => globalThis.reopenGate.releaseRead())
  assert.equal((await autosave).status, 'saved')
  await app.evaluate(() => globalThis.closeRace.focused)
  assert.deepEqual(await prompts(), ['Save changes to other.md?'])
  const closed = new Promise((resolve) => page.once('close', resolve))
  await app.evaluate(() => globalThis.closeRace.save())
  await closed
  assert.equal(await readFile(join(notes, 'other.md'), 'utf8'), otherDraft)
})
