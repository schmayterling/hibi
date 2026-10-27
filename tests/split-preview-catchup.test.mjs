import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('read-only split preview preserves catch-up, save, selection and normal-view editing', {
  timeout: 50000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-split-catchup-'))
  const folder = join(profile, 'installed-addons', 'split-fixture')
  const file = join(profile, 'split.md')
  const original = '# title\n\nalpha **bold** content\n\nomega'
  await mkdir(folder, { recursive: true })
  await writeFile(file, original)
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'split-fixture',
      name: 'Split fixture',
      description: 'Split preview regression fixture',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      capabilities: ['rich', 'source'],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(folder, 'index.js'),
    `export default sdk => ({ start(context) {
      window.splitFixture = { sdk, context, enableRich() {
        return context.editor.registerRich({ id: 'legacy', attach(editor) {
          window.splitLegacyEditor = editor;
          return () => { window.splitLegacyEditor = null; };
        }});
      }};
    }});`,
  )
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'split-fixture': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  let clockInstalled = false
  t.after(async () => {
    if (clockInstalled) await page.clock.resume()
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await rich.waitFor()
  await page.waitForFunction(() => window.splitFixture)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await clickMenu(app, 'Open…')
  await page.waitForFunction(
    () =>
      document.querySelector('.tiptap')?.editor?.state.doc.lastChild
        ?.textContent === 'omega',
  )
  await page.getByRole('button', { name: /^side-by-side$/i }).click()
  await page.waitForFunction(
    () =>
      document.querySelector('.cm-content')?.isContentEditable &&
      document.querySelector('.tiptap')?.editor?.isEditable === false,
  )
  await rich.evaluate((element) => {
    const editor = element.editor
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  })
  await source.focus()

  // Paused renderer timers make pending-preview assertions independent of IPC
  // or filesystem speed. Native save IPC and synchronous editor dispatch still run.
  const clockStart = Date.now()
  await page.clock.install({ time: clockStart })
  clockInstalled = true
  await page.clock.pauseAt(clockStart + 1000)
  const typeSource = (text, at = 'end') =>
    page.evaluate(
      ({ text, at }) => {
        const { sdk, context } = window.splitFixture
        const view = sdk.codeMirror.view.EditorView.findFromDOM(
          document.querySelector('.cm-content'),
        )
        if (!view.hasFocus) throw new Error('source must own input')
        const from = at === 'start' ? 0 : view.state.doc.length
        view.dispatch({
          changes: { from, insert: text },
          selection: { anchor: from + text.length },
          annotations:
            sdk.codeMirror.state.Transaction.userEvent.of('input.type'),
        })
        return {
          source: context.editor.getDocument().markdown,
          rich: document.querySelector('.tiptap').editor.state.doc.textContent,
        }
      },
      { text, at },
    )
  const expectSource = (text) =>
    waitForAsync(
      page,
      (text) =>
        window.splitFixture.context.editor.getDocument().markdown === text,
      text,
    )

  const first = `${original} source`
  const pending = await typeSource(' source')
  assert.equal(pending.source, first)
  assert.ok(pending.rich.endsWith('omega'))
  const saved = await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(saved.saveReceipt, true)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    first,
  )
  assert.equal(await readFile(file, 'utf8'), first)
  assert.equal(
    await rich.evaluate((element) => element.editor.state.doc.textContent),
    pending.rich,
  )
  await page.clock.runFor(201)
  assert.equal(
    await rich.evaluate(
      (element) => element.editor.state.doc.lastChild.textContent,
    ),
    'omega source',
  )

  // A source insertion before an inactive rich range must move both ends of
  // its bookmark, rather than resetting selection to the document start.
  const selectBookmark = () =>
    rich.evaluate((element) => {
      const editor = element.editor
      let position
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text.startsWith('omega')) position = pos
      })
      if (position === undefined) throw new Error('missing bookmark text')
      editor.commands.setTextSelection({ from: position + 1, to: position + 4 })
      return {
        anchor: editor.state.selection.anchor,
        head: editor.state.selection.head,
      }
    })
  const selection = () =>
    rich.evaluate((element) => ({
      anchor: element.editor.state.selection.anchor,
      head: element.editor.state.selection.head,
    }))
  const bookmark = await selectBookmark()
  await source.focus()
  const prefixed = `preface\n\n${first}`
  const beforeCatchup = await typeSource('preface\n\n', 'start')
  assert.equal(beforeCatchup.source, prefixed)
  assert.ok(!beforeCatchup.rich.startsWith('preface'))
  await page.clock.runFor(201)
  assert.deepEqual(await selection(), {
    anchor: bookmark.anchor + 9,
    head: bookmark.head + 9,
  })

  // Replacing the split synchronization effect with the normal-view effect
  // must carry a pending range bookmark into the immediate visible catch-up.
  const modeBookmark = await selectBookmark()
  await source.focus()
  const modePrefix = 'visible\n\n'
  const visibleSource = `${modePrefix}${prefixed}`
  const beforeNormal = await typeSource(modePrefix, 'start')
  assert.equal(beforeNormal.source, visibleSource)
  assert.ok(!beforeNormal.rich.startsWith('visible'))
  await page
    .getByRole('button', { name: /^normal$/i, exact: true })
    .evaluate((button) => button.click())
  await page.clock.runFor(1)
  await waitForAsync(page, () => {
    const editor = document.querySelector('.tiptap')?.editor
    return (
      editor?.isEditable &&
      editor.state.doc.firstChild.textContent === 'visible'
    )
  })
  await expectSource(visibleSource)
  assert.deepEqual(await selection(), {
    anchor: modeBookmark.anchor + modePrefix.length,
    head: modeBookmark.head + modePrefix.length,
  })
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .evaluate((button) => button.click())
  await page.clock.runFor(1)
  await waitForAsync(
    page,
    () =>
      document.querySelector('.cm-content')?.isContentEditable &&
      document.querySelector('.tiptap')?.editor?.isEditable === false,
  )

  // Read-only rich focus still flushes the preview before selection and copy.
  await rich.evaluate((element) => {
    const editor = element.editor
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  })
  await source.focus()
  const sourceBeforeRichKey = `${visibleSource} later`
  const beforeFocus = await typeSource(' later')
  assert.equal(beforeFocus.source, sourceBeforeRichKey)
  assert.ok(!beforeFocus.rich.endsWith('later'))
  await rich.focus()
  assert.equal(
    await rich.evaluate(
      (element) => element.editor.state.doc.lastChild.textContent,
    ),
    'omega source later',
  )
  await selectBookmark()
  const readOnly = await rich.evaluate((element) => {
    const editor = element.editor
    const before = editor.state.doc
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let text = walker.nextNode()
    while (text && !text.textContent.startsWith('omega'))
      text = walker.nextNode()
    if (!text) throw new Error('missing preview selection text')
    const range = document.createRange()
    range.setStart(text, 1)
    range.setEnd(text, 4)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    const clipboardData = new DataTransfer()
    element.dispatchEvent(
      new ClipboardEvent('copy', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    )
    editor.view.dispatch(editor.state.tr.insertText(' blocked'))
    return {
      editable: editor.isEditable,
      contentEditable: element.isContentEditable,
      selected: window.getSelection()?.toString(),
      copied: clipboardData.getData('text/plain'),
      unchanged: editor.state.doc === before,
      source: window.splitFixture.context.editor.getDocument().markdown,
    }
  })
  assert.deepEqual(readOnly, {
    editable: false,
    contentEditable: false,
    selected: 'meg',
    copied: 'meg',
    unchanged: true,
    source: sourceBeforeRichKey,
  })
  await page.keyboard.insertText(' blocked input')
  await expectSource(sourceBeforeRichKey)
  assert.equal(
    await rich.evaluate(
      (element) => element.editor.state.doc.lastChild.textContent,
    ),
    'omega source later',
  )

  // Normal view restores native rich input without discarding source edits.
  await page
    .getByRole('button', { name: /^normal$/i, exact: true })
    .evaluate((button) => button.click())
  await page.clock.runFor(1)
  await waitForAsync(
    page,
    () => document.querySelector('.tiptap')?.editor?.isEditable,
  )
  await rich.evaluate((element) => {
    const editor = element.editor
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.view.focus()
  })
  await page.keyboard.insertText('!')
  await expectSource(`${sourceBeforeRichKey}!`)
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`,
  )
  await expectSource(sourceBeforeRichKey)
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .evaluate((button) => button.click())
  await page.clock.runFor(1)
  await waitForAsync(
    page,
    () =>
      document.querySelector('.cm-content')?.isContentEditable &&
      document.querySelector('.tiptap')?.editor?.isEditable === false,
  )

  // Hiding a pending preview must cancel obsolete work, including cleanup work.
  // Count nonempty parses: clearing a newly hidden rich instance is harmless.
  const hiddenBookmark = await selectBookmark()
  await page.evaluate(() => {
    const manager = document.querySelector('.tiptap').editor.markdown
    const parse = manager.parse
    const descriptor = Object.getOwnPropertyDescriptor(manager, 'parse')
    window.splitParseCount = 0
    manager.parse = function (...args) {
      if (args[0]) window.splitParseCount++
      return parse.apply(this, args)
    }
    window.stopSplitParseCount = () => {
      if (descriptor) Object.defineProperty(manager, 'parse', descriptor)
      else delete manager.parse
    }
  })
  await source.focus()
  const sourceBeforeHide = `${sourceBeforeRichKey} hidden`
  const beforeHide = await typeSource(' hidden')
  assert.equal(beforeHide.source, sourceBeforeHide)
  assert.ok(!beforeHide.rich.endsWith('hidden'))
  // Native button activation avoids actionability's animation-frame wait while
  // fake time is paused. Advance time only after the mode switch has committed.
  await page
    .getByRole('button', { name: 'Source view', exact: true })
    .evaluate((button) => button.click())
  await waitForAsync(
    page,
    () =>
      document.querySelector('.editor-panes.mode-markdown') &&
      document.querySelector('.tiptap')?.editor?.isEditable === false,
  )
  assert.equal(
    await page.evaluate(() => {
      window.splitHiddenEditor = document.querySelector('.tiptap').editor
      window.splitHiddenDocument = window.splitHiddenEditor.state.doc
      return window.splitParseCount
    }),
    0,
  )
  // Hidden source operations still map the dormant bookmark without parsing.
  const hiddenPrefix = 'asleep\n\n'
  const hiddenSource = `${hiddenPrefix}${sourceBeforeHide}`
  await source.focus()
  const hiddenEdit = await typeSource(hiddenPrefix, 'start')
  assert.equal(hiddenEdit.source, hiddenSource)
  assert.ok(!hiddenEdit.rich.startsWith('asleep'))
  await page.clock.runFor(201)
  assert.deepEqual(
    await page.evaluate(() => ({
      source: window.splitFixture.context.editor.getDocument().markdown,
      parses: window.splitParseCount,
      sameDocument:
        window.splitHiddenEditor.state.doc === window.splitHiddenDocument,
      editable: window.splitHiddenEditor.isEditable,
    })),
    { source: hiddenSource, parses: 0, sameDocument: true, editable: false },
  )
  await page.evaluate(() => window.stopSplitParseCount())
  await page
    .getByRole('button', { name: /^normal$/i, exact: true })
    .evaluate((button) => button.click())
  await page.clock.runFor(1)
  await waitForAsync(page, () => {
    const editor = document.querySelector('.tiptap')?.editor
    return (
      editor?.isEditable &&
      editor.state.doc.lastChild.textContent === 'omega source later hidden'
    )
  })
  await expectSource(hiddenSource)
  assert.deepEqual(await selection(), {
    anchor: hiddenBookmark.anchor + hiddenPrefix.length,
    head: hiddenBookmark.head + hiddenPrefix.length,
  })
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .evaluate((button) => button.click())
  await page.clock.runFor(1)
  await waitForAsync(
    page,
    () =>
      document.querySelector('.cm-content')?.isContentEditable &&
      document.querySelector('.tiptap')?.editor?.isEditable === false,
  )

  // Unknown rich attachments retain their existing immediate synchronization.
  // No fake time advances between this source edit and its rich assertion.
  await page.evaluate(() => {
    window.splitFixture.enableRich()
  })
  await waitForAsync(
    page,
    () =>
      window.splitLegacyEditor === document.querySelector('.tiptap')?.editor,
  )
  await source.focus()
  const legacy = await typeSource(' legacy')
  assert.equal(legacy.source, `${hiddenSource} legacy`)
  await waitForAsync(
    page,
    () =>
      document.querySelector('.tiptap').editor.state.doc.lastChild
        .textContent === 'omega source later hidden legacy',
  )
})

test('codemirror: editable split preserves catch-up, save, mapped selections and dormant bookmarks', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-cm-split-catchup-'))
  const file = join(profile, 'split.md')
  const original = '# title\n\nalpha **bold** content\n\nomega'
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
  const rich = await selectFormattedEngine(app, page, 'codemirror')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await source.waitFor()
  // Accepted difference: the codemirror split pane stays editable.
  assert.equal(
    await rich.evaluate((element) => element.isContentEditable),
    true,
  )
  const expectSource = async (text) => {
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
    if (
      (await page.locator('.source-pane').getAttribute('aria-hidden')) ===
      'false'
    )
      assert.equal(
        await source.evaluate((element) =>
          element.cmTile.root.view.state.doc.toString(),
        ),
        text,
      )
  }
  const typeSource = async (text, at = 'end') => {
    await source.focus()
    await source.evaluate(
      (element, { text, at }) => {
        const view = element.cmTile.root.view
        if (!view.hasFocus) throw new Error('source must own input')
        const from = at === 'start' ? 0 : view.state.doc.length
        view.dispatch({
          changes: { from, insert: text },
          selection: { anchor: from + text.length },
          userEvent: 'input.type',
        })
      },
      { text, at },
    )
  }
  const selection = () =>
    rich.evaluate((element) => {
      const { anchor, head } = element.cmTile.root.view.state.selection.main
      return { anchor, head }
    })
  const bookmark = async () =>
    rich.evaluate((element) => {
      const view = element.cmTile.root.view
      const at = view.state.doc.toString().indexOf('omega')
      if (at < 0) throw new Error('missing bookmark text')
      view.dispatch({ selection: { anchor: at + 1, head: at + 4 } })
      return { anchor: at + 1, head: at + 4 }
    })
  const formatted = (text) =>
    page.waitForFunction(
      (text) =>
        document
          .querySelector('.rich-pane .cm-content')
          .cmTile.root.view.state.doc.toString() === text,
      text,
    )
  const first = `${original} source`
  await typeSource(' source')
  await expectSource(first)
  const saved = await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(saved.saveReceipt, true)
  assert.equal(await readFile(file, 'utf8'), first)
  await formatted(first)

  const beforePrefix = await bookmark()
  const prefixed = `preface\n\n${first}`
  await typeSource('preface\n\n', 'start')
  await expectSource(prefixed)
  await formatted(prefixed)
  assert.deepEqual(await selection(), {
    anchor: beforePrefix.anchor + 9,
    head: beforePrefix.head + 9,
  })
  const beforeMode = await bookmark()
  const modePrefix = 'visible\n\n'
  const visible = modePrefix + prefixed
  await typeSource(modePrefix, 'start')
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await formatted(visible)
  assert.deepEqual(await selection(), {
    anchor: beforeMode.anchor + modePrefix.length,
    head: beforeMode.head + modePrefix.length,
  })
  await expectSource(visible)
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await source.waitFor()
  const later = `${visible} later`
  await typeSource(' later')
  await rich.focus()
  await formatted(later)
  await bookmark()
  await rich.focus()
  assert.equal(await page.evaluate(() => getSelection().toString()), 'meg')
  await app.evaluate(({ clipboard }) => clipboard.clear())
  await rich.press('ControlOrMeta+c')
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    'meg',
  )

  await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    view.focus()
  })
  await page.evaluate(() => window.hibi.flushDocumentChanges())
  const beforeTyping = await page.evaluate(() => window.hibi.getDocument())
  await page.keyboard.insertText('!')
  await page.evaluate(() => window.hibi.flushDocumentChanges())
  const splitTyped = await page.evaluate(() => window.hibi.getDocument())
  // Typing in the codemirror split pane makes one source edit, and undo takes it back.
  assert.equal(splitTyped.markdown, `${later}!`)
  assert.equal(splitTyped.contentVersion, beforeTyping.contentVersion + 1)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${mod}+z`)
  await expectSource(later)
  await formatted(later)
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    view.focus()
  })
  await page.keyboard.insertText('!')
  await expectSource(`${later}!`)
  await pressShortcut(app, `${mod}+z`)
  await expectSource(later)
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await source.waitFor()

  const hiddenBookmark = await bookmark()
  await typeSource(' hidden')
  const beforeHide = `${later} hidden`
  await expectSource(beforeHide)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await source.waitFor()
  await rich.evaluate((element) => {
    window.dormantFormatted = {
      view: element.cmTile.root.view,
      doc: element.cmTile.root.view.state.doc,
      mutations: 0,
    }
    window.dormantFormatted.observer = new MutationObserver((records) => {
      window.dormantFormatted.mutations += records.length
    })
    window.dormantFormatted.observer.observe(element, {
      subtree: true,
      characterData: true,
      childList: true,
    })
  })
  const prefix = 'asleep\n\n'
  const hiddenSource = prefix + beforeHide
  await typeSource(prefix, 'start')
  await expectSource(hiddenSource)
  await page.evaluate(async () => {
    for (let frame = 0; frame < 3; frame++)
      await new Promise(requestAnimationFrame)
  })
  assert.deepEqual(
    await page.evaluate(() => {
      const f = window.dormantFormatted
      f.observer.disconnect()
      return {
        sameDocument: f.view.state.doc === f.doc,
        mutations: f.mutations,
        hidden: document.querySelector('.rich-pane').inert,
      }
    }),
    { sameDocument: true, mutations: 0, hidden: true },
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await formatted(hiddenSource)
  await expectSource(hiddenSource)
  assert.deepEqual(await selection(), {
    anchor: hiddenBookmark.anchor + prefix.length,
    head: hiddenBookmark.head + prefix.length,
  })
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(await readFile(file, 'utf8'), hiddenSource)
  await cdp.detach()
})
