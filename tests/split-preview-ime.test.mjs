import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('native source IME survives split preview catch-up and keeps one undo group', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-split-ime-'))
  const addon = join(profile, 'installed-addons', 'ime-fixture')
  const file = join(profile, 'ime.md')
  const original = 'before 😀\r\n\r\nmiddle end\r\n\r\nomega'
  await mkdir(addon, { recursive: true })
  await writeFile(file, original)
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'ime-fixture',
      name: 'IME fixture',
      description: 'Native IME regression',
      kind: 'extension',
      apiVersion: 2,
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
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(addon, 'index.js'),
    `export default sdk => ({ start(context) {
    const fixture = window.imeFixture = { sdk, context, updates: [], events: [] };
    context.editor.onDocumentChange(document => fixture.updates.push({
      source: document.markdown,
      rich: window.document.querySelector('.tiptap')?.editor?.state.doc.textContent,
    }));
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend'])
      document.addEventListener(type, event => fixture.events.push({
        type, data: event.data, trusted: event.isTrusted,
      }), true);
  }});`,
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'ime-fixture': true }),
  )
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
  page.setDefaultTimeout(6000)
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(() => window.imeFixture)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  // Hosted Windows failures of the wait below found the renderer unresponsive.
  // An enabled debugger lets a late pause interrupt a busy script for a stack.
  const debug = await page.context().newCDPSession(page)
  await debug.send('Debugger.enable')
  await page.evaluate(() => {
    window.imeOpen = { startedAt: performance.now() }
    const observer = new MutationObserver(() => {
      if (
        document.querySelector('.tiptap')?.editor?.state.doc.lastChild
          ?.textContent === 'omega'
      ) {
        window.imeOpen.readyAt = performance.now()
        observer.disconnect()
      }
    })
    observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    })
  })
  await clickMenu(app, 'Open…')
  await page
    .waitForFunction(() => {
      if (window.imeOpen) window.imeOpen.waitStartedAt ??= performance.now()
      return (
        document.querySelector('.tiptap')?.editor?.state.doc.lastChild
          ?.textContent === 'omega'
      )
    })
    .catch(async (error) => {
      const bounded = (request, timeout = 2000) =>
        Promise.race([
          request().catch((cause) => ({ failed: String(cause).slice(0, 120) })),
          new Promise((resolve) =>
            setTimeout(() => resolve({ unavailable: true }), timeout).unref(),
          ),
        ])
      // Cumulative cpu seconds tell a busy renderer from a blocked one.
      const cpu = () =>
        app.evaluate(({ app, BrowserWindow }) => {
          const pid =
            BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()
          const metric = app.getAppMetrics().find((entry) => entry.pid === pid)
          return [Math.round(performance.now()), metric?.cpu.cumulativeCPUUsage]
        })
      try {
        const frame = await bounded(
          () =>
            page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => resolve(true)),
                ),
            ),
          500,
        )
        const before = await cpu()
        const paused = new Promise((resolve) =>
          debug.once('Debugger.paused', resolve),
        )
        const stack = await bounded(async () => {
          await debug.send('Debugger.pause')
          const { callFrames } = await paused
          return callFrames
            .slice(0, 10)
            .map(
              ({ functionName, url, location }) =>
                `${functionName || '(anonymous)'} ${url.split('/').pop()}:${location.lineNumber + 1}:${location.columnNumber + 1}`,
            )
        })
        await debug.detach().catch(() => {})
        console.error(
          'ime open:',
          JSON.stringify({
            cpu: [before, await cpu()],
            frame,
            stack,
            dom: await bounded(() =>
              page.evaluate(() => ({
                lastChild:
                  document.querySelector('.tiptap')?.editor?.state.doc.lastChild
                    ?.textContent,
                busy: document.querySelector('.app')?.getAttribute('aria-busy'),
                visibility: document.visibilityState,
                open: window.imeOpen,
                dialogs: document.querySelectorAll('dialog[open]').length,
                toasts: [...document.querySelectorAll('.toast-copy')]
                  .slice(0, 3)
                  .map((toast) => toast.textContent?.slice(0, 120)),
              })),
            ),
          }),
        )
      } catch {}
      throw error
    })
  await debug.detach()
  await page.getByRole('button', { name: /^side-by-side$/i }).click()
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.editor?.isEditable === false,
  )
  await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    const view = window.imeFixture.sdk.codeMirror.view.EditorView.findFromDOM(
      document.querySelector('.cm-content'),
    )
    window.imeFixture.view = view
    view.dispatch({
      selection: { anchor: view.state.doc.toString().indexOf('end') },
    })
    view.focus()
    window.imeFixture.updates = []
    window.imeFixture.events = []
  })
  const cdp = await page.context().newCDPSession(page)
  const compose = (
    text,
    selectionStart = text.length,
    selectionEnd = selectionStart,
  ) =>
    cdp.send('Input.imeSetComposition', {
      text,
      selectionStart,
      selectionEnd,
    })
  const expectSource = (text) =>
    page.waitForFunction(
      (text) =>
        window.imeFixture.context.editor.getDocument().markdown === text,
      text,
    )
  await compose('に')
  await expectSource(original.replace('middle end', 'middle にend'))
  assert.equal(
    await page.evaluate(() => window.imeFixture.view.composing),
    true,
  )
  // Real candidate deliberation crosses both preview quiet time and the typing
  // history timeout. No fake composition flags, DOM events, or renderer clock.
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.deepEqual(
    await page.evaluate(() => ({
      composing: window.imeFixture.view.composing,
      sourceFocused: window.imeFixture.view.hasFocus,
      caughtUp: document
        .querySelector('.tiptap')
        .editor.state.doc.textContent.includes('に'),
    })),
    { composing: true, sourceFocused: true, caughtUp: true },
  )
  await compose('日本')
  await expectSource(original.replace('middle end', 'middle 日本end'))
  await page.evaluate(() => {
    window.imeFixture.beforeSelection = window.imeFixture.view.state.doc
  })
  await compose('日本', 0, 1)
  await page.waitForFunction(
    () => !window.imeFixture.view.state.selection.main.empty,
  )
  assert.deepEqual(
    await page.evaluate(() => ({
      unchanged:
        window.imeFixture.view.state.doc === window.imeFixture.beforeSelection,
      composing: window.imeFixture.view.composing,
      source: window.imeFixture.context.editor.getDocument().markdown,
    })),
    {
      unchanged: true,
      composing: true,
      source: original.replace('middle end', 'middle 日本end'),
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 600))
  await compose('日本語')
  await expectSource(original.replace('middle end', 'middle 日本語end'))
  await cdp.send('Input.insertText', { text: '日本語😀' })
  const committed = original.replace('middle end', 'middle 日本語😀end')
  await expectSource(committed)
  await page.waitForFunction(() => !window.imeFixture.view.composing)
  const input = await page.evaluate(() => ({
    events: window.imeFixture.events,
    pending: window.imeFixture.updates.some(
      (update) =>
        update.source.includes('日本語😀') && !update.rich.includes('日本語😀'),
    ),
    text: window.imeFixture.view.state.doc.toString(),
  }))
  assert.equal(
    input.pending,
    true,
    'composition commits before its formatted preview',
  )
  assert.equal(input.text, committed.replace(/\r\n/g, '\n'))
  assert.equal(
    input.events.filter((event) => event.type === 'compositionstart').length,
    1,
  )
  assert.equal(
    input.events.filter((event) => event.type === 'compositionend').length,
    1,
  )
  // Chromium's CDP commit emits an untrusted compositionend, even though the
  // candidate updates travel through its native IME input handler.
  assert.ok(
    input.events
      .filter((event) => event.type !== 'compositionend')
      .every((event) => event.trusted),
    JSON.stringify(input.events),
  )
  assert.equal(
    input.events.find((event) => event.type === 'compositionend').data,
    '日本語😀',
  )
  const saved = await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(saved.saveReceipt, true)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    committed,
  )
  assert.equal(await readFile(file, 'utf8'), committed)
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .focus()
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector('.tiptap')
        .editor.state.doc.textContent.includes('日本語😀'),
    ),
    true,
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await expectSource(committed)
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await source.focus()
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`,
  )
  await page.waitForFunction(
    () =>
      !window.imeFixture.context.editor
        .getDocument()
        .markdown.includes('日本語😀'),
  )
  assert.equal(
    await page.evaluate(
      () => window.imeFixture.context.editor.getDocument().markdown,
    ),
    original,
    'one undo removes the whole composition, including earlier candidates',
  )
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+z`,
  )
  await expectSource(committed)

  // A new composition starts a new group even when it follows immediately.
  await compose('試')
  await cdp.send('Input.insertText', { text: '試' })
  const second = committed.replace('日本語😀end', '日本語😀試end')
  await expectSource(second)
  await compose('字')
  await cdp.send('Input.insertText', { text: '字' })
  await expectSource(committed.replace('日本語😀end', '日本語😀試字end'))
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`,
  )
  await expectSource(second)
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`,
  )
  await expectSource(committed)

  await compose('選')
  await cdp.send('Input.insertText', { text: '選' })
  const selected = committed.replace('日本語😀end', '日本語😀選end')
  await expectSource(selected)
  await page.waitForFunction(() => !window.imeFixture.view.composing)
  await source.press('ArrowLeft')
  await cdp.send('Input.insertText', { text: 'z' })
  await expectSource(committed.replace('日本語😀end', '日本語😀z選end'))
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`,
  )
  await expectSource(selected)
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`,
  )
  await expectSource(committed)

  // Exercise native rich composition in normal view; split remains read-only.
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.editor?.isEditable,
  )
  const richFile = join(profile, 'rich-ime.md')
  const richOriginal = 'rich omega'
  await writeFile(richFile, richOriginal)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, richFile)
  assert.equal(
    await page.evaluate(() =>
      window.imeFixture.context.editor.runCommand('open'),
    ),
    true,
    'second file opens before rich IME editing',
  )
  await expectSource(richOriginal)
  await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.view.focus()
  })
  await compose('か')
  await expectSource(`${richOriginal}か`)
  await new Promise((resolve) => setTimeout(resolve, 600))
  await compose('漢')
  await expectSource(`${richOriginal}漢`)
  await new Promise((resolve) => setTimeout(resolve, 600))
  await compose('漢字')
  await expectSource(`${richOriginal}漢字`)
  await cdp.send('Input.insertText', { text: '漢字😀' })
  await expectSource(`${richOriginal}漢字😀`)
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`,
  )
  await page.waitForFunction(
    () =>
      !window.imeFixture.context.editor
        .getDocument()
        .markdown.includes('漢字😀'),
  )
  assert.equal(
    await page.evaluate(
      () => window.imeFixture.context.editor.getDocument().markdown,
    ),
    richOriginal,
    'one rich undo removes the whole composition across candidate pauses',
  )
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+z`,
  )
  await expectSource(`${richOriginal}漢字😀`)
  await compose('試')
  await cdp.send('Input.insertText', { text: '試' })
  await expectSource(`${richOriginal}漢字😀試`)
  await compose('字')
  await cdp.send('Input.insertText', { text: '字' })
  await expectSource(`${richOriginal}漢字😀試字`)
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`,
  )
  await expectSource(`${richOriginal}漢字😀試`)
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`,
  )
  await expectSource(`${richOriginal}漢字😀`)
})

for (const [pane, mode] of [
  ['source', 'side-by-side'],
  ['rich', 'side-by-side'],
  ['rich', 'normal'],
]) {
  test(`codemirror: native ${pane} IME in ${mode} survives catch-up, save, selection and undo`, {
    timeout: 45000,
  }, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-cm-split-ime-'))
    const file = join(profile, 'ime.md')
    const original = 'before 😀\r\n\r\nmiddle end\r\n\r\nomega'
    await writeFile(file, original)
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`, file],
    })
    t.after(async () => {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      await app.close()
      await rm(profile, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(7000)
    await selectFormattedEngine(app, page, 'codemirror')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    if (mode === 'side-by-side') {
      await page
        .getByRole('button', { name: /^side-by-side$/i, exact: true })
        .click()
      await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
      // Accepted difference: the codemirror split pane stays editable.
      assert.equal(
        await page
          .getByRole('textbox', { name: 'Document editor', exact: true })
          .evaluate((element) => element.isContentEditable),
        true,
      )
      assert.equal(
        await page
          .getByRole('textbox', { name: 'Markdown editor', exact: true })
          .evaluate((element) => element.isContentEditable),
        true,
      )
    }
    const input = page.locator(`.${pane}-pane .cm-content`)
    const offset = original.replaceAll('\r\n', '\n').indexOf('end')
    await input.evaluate((element, offset) => {
      const view = element.cmTile.root.view
      window.cmIme = { view, events: [] }
      for (const type of [
        'compositionstart',
        'compositionupdate',
        'compositionend',
      ])
        element.addEventListener(
          type,
          (event) =>
            window.cmIme.events.push({
              type,
              data: event.data,
              trusted: event.isTrusted,
            }),
          true,
        )
      view.dispatch({ selection: { anchor: offset } })
      view.focus()
    }, offset)
    const compose = (
      text,
      selectionStart = text.length,
      selectionEnd = selectionStart,
    ) =>
      cdp.send('Input.imeSetComposition', {
        text,
        selectionStart,
        selectionEnd,
      })
    const expectSource = (text) =>
      waitForAsync(
        page,
        async (text) => (await window.hibi.getDocument()).markdown === text,
        text,
      )
    const candidate = (text) =>
      original.replace('middle end', `middle ${text}end`)
    const caughtUp = async (text) => {
      assert.equal(
        await page.evaluate((text) => {
          const view = window.cmIme.view
          return (
            view.composing &&
            view.hasFocus &&
            document
              .querySelector('.rich-pane .cm-content')
              .textContent.includes(text)
          )
        }, text),
        true,
      )
    }
    await compose('に')
    await expectSource(candidate('に'))
    // Real candidate pauses cross the typing-history timeout.
    await new Promise((resolve) => setTimeout(resolve, 600))
    await caughtUp('に')
    await compose('日本')
    await expectSource(candidate('日本'))
    await input.evaluate(() => {
      window.cmIme.beforeSelection = window.cmIme.view.state.doc
    })
    await compose('日本', 0, 1)
    await page.waitForFunction(
      () => !window.cmIme.view.state.selection.main.empty,
    )
    assert.deepEqual(
      await input.evaluate(() => {
        const f = window.cmIme
        return {
          unchanged: f.view.state.doc === f.beforeSelection,
          composing: f.view.composing,
          anchor: f.view.state.selection.main.anchor,
          head: f.view.state.selection.main.head,
        }
      }),
      { unchanged: true, composing: true, anchor: offset, head: offset + 1 },
    )
    await expectSource(candidate('日本'))
    await new Promise((resolve) => setTimeout(resolve, 600))
    await compose('日本語')
    await expectSource(candidate('日本語'))
    await cdp.send('Input.insertText', { text: '日本語😀' })
    const committed = candidate('日本語😀')
    await expectSource(committed)
    await page.waitForFunction(() => !window.cmIme.view.composing)
    const events = await page.evaluate(() => window.cmIme.events)
    assert.equal(
      events.filter((event) => event.type === 'compositionstart').length,
      1,
    )
    assert.equal(
      events.filter((event) => event.type === 'compositionend').length,
      1,
    )
    assert.ok(
      events
        .filter((event) => event.type !== 'compositionend')
        .every((event) => event.trusted),
      JSON.stringify(events),
    )
    assert.equal(
      events.find((event) => event.type === 'compositionend').data,
      '日本語😀',
    )
    assert.equal(
      await input.evaluate((element) =>
        element.cmTile.root.view.state.doc.toString(),
      ),
      committed.replaceAll('\r\n', '\n'),
    )
    assert.equal(
      await input.evaluate(
        (element) => element.cmTile.root.view.state.selection.main.head,
      ),
      offset + '日本語😀'.length,
    )
    const saved = await page.evaluate(() => window.hibi.saveDocument(false))
    assert.equal(saved.saveReceipt, true)
    assert.equal(await readFile(file, 'utf8'), committed)
    if (mode === 'side-by-side') {
      await page
        .getByRole('textbox', { name: 'Document editor', exact: true })
        .focus()
      await page
        .locator('.rich-pane .cm-content .cm-line', { hasText: '日本語😀' })
        .waitFor()
    }
    await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
    await expectSource(committed)
    if (mode === 'side-by-side') {
      await page
        .getByRole('button', { name: /^side-by-side$/i, exact: true })
        .click()
      await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
    }
    await input.focus()
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await pressShortcut(app, `${mod}+z`)
    await expectSource(original)
    assert.deepEqual(
      await input.evaluate((element) => {
        const { anchor, head } = element.cmTile.root.view.state.selection.main
        return { anchor, head }
      }),
      { anchor: offset, head: offset },
    )
    await pressShortcut(app, `${mod}+Shift+z`)
    await expectSource(committed)
    await compose('試')
    await cdp.send('Input.insertText', { text: '試' })
    const second = candidate('日本語😀試')
    await expectSource(second)
    await compose('字')
    await cdp.send('Input.insertText', { text: '字' })
    await expectSource(candidate('日本語😀試字'))
    await pressShortcut(app, `${mod}+z`)
    await expectSource(second)
    await pressShortcut(app, `${mod}+z`)
    await expectSource(committed)
    await compose('選')
    await cdp.send('Input.insertText', { text: '選' })
    const selected = candidate('日本語😀選')
    await expectSource(selected)
    await page.waitForFunction(() => !window.cmIme.view.composing)
    await input.press('ArrowLeft')
    await cdp.send('Input.insertText', { text: 'z' })
    await expectSource(candidate('日本語😀z選'))
    await pressShortcut(app, `${mod}+z`)
    await expectSource(selected)
    await pressShortcut(app, `${mod}+z`)
    await expectSource(committed)
    await cdp.detach()
  })
}
