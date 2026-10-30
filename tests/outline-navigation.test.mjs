import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  electron,
  stopElectronTree,
  waitForDocumentEditor,
} from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu, pressShortcut, replaceSourceText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('large outline follows rich and source carets with bounded rows and ignores stale results', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-outline-navigation-'))
  const file = join(profile, 'headings.md')
  await writeFile(
    file,
    '# top\r\n\r\n' +
      Array.from(
        { length: 1000 },
        (_, i) => `## node ${i}\r\n\r\ntext ${i}\r\n\r\n`,
      ).join(''),
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
  page.setDefaultTimeout(7000)
  await page.setViewportSize({ width: 1100, height: 800 })
  await selectFormattedEngine(app, page, t.formattedEngine)
  const cm = t.formattedEngine === 'codemirror'
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    })
  }, file)
  await clickMenu(app, 'Open…')
  if (cm) {
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).name === 'headings.md',
    )
    await rich.press('ControlOrMeta+End')
    await rich.evaluate((element) => element.blur())
  }
  await rich.getByRole('heading', { name: 'node 999', exact: true }).waitFor()
  await page.getByRole('button', { name: /^toggle right sidebar$/i }).click()
  await page.getByRole('button', { name: /^right sidebar views$/i }).click()
  await page
    .getByRole('menuitem', { name: 'On this page', exact: true })
    .click()
  const outline = page.locator(
    '.outline-sidebar[data-side="right"][data-open="true"]',
  )
  const selected = outline.locator(
    '[role="treeitem"][aria-selected="true"] .sidebar-label',
  )
  const expectSelected = async (label) => {
    await page.waitForFunction(
      (label) =>
        document.querySelector(
          '.outline-sidebar[data-side="right"] [role="treeitem"][aria-selected="true"] .sidebar-label',
        )?.textContent === label,
      label,
      { timeout: 15000 },
    )
    assert.equal(await selected.textContent(), label)
    assert.ok((await outline.locator('.sidebar-row').count()) < 65)
  }
  for (const label of ['node 999', 'node 100', 'node 500', 'top']) {
    await rich.evaluate((element, label) => {
      if (element.matches('.cm-content')) {
        const view = element.cmTile.root.view
        const text = label === 'top' ? '# top\n' : `## ${label}\n`
        const anchor = view.state.doc.toString().indexOf(text)
        if (anchor < 0) throw new Error('missing heading')
        view.dispatch({ selection: { anchor }, scrollIntoView: true })
        return
      }
      const editor = element.editor
      let position
      editor.state.doc.descendants((node, offset) => {
        if (node.type.name === 'heading' && node.textContent === label)
          position = offset + 1
      })
      editor.commands.setTextSelection(position)
    }, label)
    await expectSelected(label)
  }
  await page.evaluate(() => {
    const pending = new Map()
    let next = 0
    const request = window.requestIdleCallback,
      cancel = window.cancelIdleCallback
    window.requestIdleCallback = (callback) => {
      pending.set(++next, callback)
      return next
    }
    window.cancelIdleCallback = (id) => pending.delete(id)
    window.pendingOutlineReads = pending
    window.releaseOutlineReads = () => {
      window.requestIdleCallback = request
      window.cancelIdleCallback = cancel
      for (const callback of pending.values())
        callback({ didTimeout: false, timeRemaining: () => 20 })
      pending.clear()
    }
    const content = document.querySelector('.rich-pane .cm-content')
    if (content) {
      const view = content.cmTile.root.view
      const insert = '# replacement\n\n'
      view.dispatch({
        changes: { from: 0, insert },
        selection: { anchor: view.state.doc.length + insert.length },
      })
      window.outlineSelectionBeforeStaleClick = view.state.selection.main.head
      return
    }
    const editor = document.querySelector('.tiptap').editor
    editor.commands.insertContentAt(0, {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'replacement' }],
    })
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    window.outlineSelectionBeforeStaleClick = editor.state.selection.head
  })
  await page.waitForFunction(() => window.pendingOutlineReads.size > 0)
  // The previous top heading was at position zero. A new heading now occupies
  // that position; an old outline row must never navigate to the replacement.
  await outline.getByRole('treeitem', { name: 'top', exact: true }).click()
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  assert.equal(
    await rich.evaluate((element) =>
      element.matches('.cm-content')
        ? element.cmTile.root.view.state.selection.main.head
        : element.editor.state.selection.head,
    ),
    await page.evaluate(() => window.outlineSelectionBeforeStaleClick),
  )
  assert.equal(
    await outline
      .getByRole('treeitem', { name: 'replacement', exact: true })
      .count(),
    0,
  )
  await page.evaluate(() => {
    window.releaseOutlineReads()
    // Reveal the newly published first rows in the virtualized sidebar.
    const content = document.querySelector('.rich-pane .cm-content')
    if (content)
      content.cmTile.root.view.dispatch({
        selection: { anchor: 1 },
        scrollIntoView: true,
      })
    else document.querySelector('.tiptap').editor.commands.setTextSelection(1)
  })
  await outline
    .getByRole('treeitem', { name: 'replacement', exact: true })
    .waitFor()
  await outline.getByRole('treeitem', { name: 'top', exact: true }).click()
  assert.equal(
    await rich.evaluate((element) =>
      element.matches('.cm-content')
        ? element.cmTile.root.view.state.doc
            .lineAt(element.cmTile.root.view.state.selection.main.head)
            .text.replace(/^# /, '')
        : element.editor.state.selection.$from.parent.textContent,
    ),
    'top',
  )
  if (cm)
    await pressShortcut(
      app,
      process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
    )
  else await rich.evaluate((element) => element.editor.commands.undo())
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  // Simulate a page with no idle time so outline work must honor its timeout.
  await page.evaluate(() => {
    window.requestIdleCallback = (callback, options) =>
      window.setTimeout(
        () => callback({ didTimeout: true, timeRemaining: () => 0 }),
        options?.timeout ?? 500,
      )
    window.cancelIdleCallback = (id) => window.clearTimeout(id)
  })
  await page.getByRole('button', { name: /^source view$/i }).click()
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await source.focus()
  await source.press('ControlOrMeta+a')
  await source.press('ArrowRight')
  await expectSelected('node 999')
  await source.press('ControlOrMeta+a')
  await source.press('ArrowLeft')
  await expectSelected('top')
})

test('source outline resolves references through its worker and preserves native syntax and math boundaries', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-outline-semantics-')),
    file = join(profile, 'outline.md'),
    original =
      '# **literal** [label][ref]\n\n[ref]: /target\n\n$$\n# hidden math\n$$\n\n# real\n'
  await writeFile(file, original)
  await writeFile(join(profile, 'addons.json'), JSON.stringify({ math: true }))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  const watchdog = setTimeout(() => stopElectronTree(app.process()), 40000)
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close().catch(() => {})
    clearTimeout(watchdog)
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  // Any renderer error fails the test, also one that work after an edit throws.
  const errors = []
  page.on('pageerror', (error) => errors.push(error.stack ?? String(error)))
  page.setDefaultTimeout(7000)
  await selectFormattedEngine(app, page, t.formattedEngine)
  const cm = t.formattedEngine === 'codemirror'
  await page.evaluate(() => {
    localStorage.setItem(
      'hibi:markdown-syntax-disabled',
      JSON.stringify(['core.bold']),
    )
  })
  await page.reload()
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    })
  }, file)
  const establishedWorkers = page
    .workers()
    .filter((worker) => worker.url().includes('/document.worker-'))
  for (const worker of establishedWorkers)
    await worker.evaluate(() => {
      globalThis.outlineReferenceRequests = []
      self.addEventListener('message', ({ data }) => {
        const request = data.message ?? data
        if (request.type === 'metadata' && request.reference)
          globalThis.outlineReferenceRequests.push(request.reference.label)
      })
    })
  await page.evaluate(() => {
    window.outlineWorkers = []
    window.outlineReferenceRequests = []
    window.Worker = new Proxy(window.Worker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args)
        if (String(args[0]).includes('/document.worker-')) {
          window.outlineWorkers.push(String(args[0]))
          const post = worker.postMessage.bind(worker)
          worker.postMessage = (message, ...rest) => {
            const request = message.message ?? message
            if (request.type === 'metadata' && request.reference)
              window.outlineReferenceRequests.push(request.reference.label)
            return post(message, ...rest)
          }
        }
        return worker
      },
    })
  })
  await clickMenu(app, 'Open…')
  if (cm) {
    // Read rendered labels with the caret outside the heading.
    await waitForDocumentEditor(app, page)
    await rich.evaluate((element) => element.blur())
  }
  const documentWorkers = page
    .workers()
    .filter((worker) => worker.url().includes('/document.worker-'))
  const workerCreations = await page.evaluate(
    () => window.outlineWorkers.length,
  )
  const assertWorkerReuse = () =>
    t.test('source outline reuses its document worker', async () => {
      const workers = page
        .workers()
        .filter((worker) => worker.url().includes('/document.worker-'))
      assert.equal(workers.length, 1)
      for (const worker of documentWorkers) assert.ok(workers.includes(worker))
      assert.equal(
        await page.evaluate(() => window.outlineWorkers.length),
        workerCreations,
      )
    })
  const expectedLabels = ['**literal** label', 'real']
  const checkFormattedHeadings = async () => {
    await page
      .waitForFunction(() => {
        const headings = [
          ...document.querySelectorAll('.rich-pane :is(h1, .hibi-lp-h1)'),
        ].map((heading) => heading.textContent)
        return (
          JSON.stringify(headings) ===
          JSON.stringify(['**literal** label', 'real'])
        )
      })
      .catch(async (cause) => {
        const state = await page.evaluate(async () => ({
          headings: [
            ...document.querySelectorAll('.rich-pane :is(h1, .hibi-lp-h1)'),
          ].map((node) => node.textContent),
          source: (await window.hibi.getDocument()).markdown,
          active: document.activeElement?.getAttribute('aria-label'),
        }))
        throw new Error(
          `formatted headings must match **literal** label / real: ${JSON.stringify(state)}`,
          { cause },
        )
      })
  }
  if (cm)
    await t.test(
      'formatted references render their resolved heading labels',
      checkFormattedHeadings,
    )
  else await checkFormattedHeadings()
  // Keep the historical label oracle even if formatted rendering fails.
  const nativeLabels = cm
    ? expectedLabels
    : await rich.locator('h1').allTextContents()
  await page.getByRole('button', { name: /^source view$/i }).click()
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await source.waitFor()
  await page.getByRole('button', { name: /^toggle right sidebar$/i }).click()
  await page.getByRole('button', { name: /^right sidebar views$/i }).click()
  await page
    .getByRole('menuitem', { name: 'On this page', exact: true })
    .click()
  const outline = page.locator(
    '.outline-sidebar[data-side="right"][data-open="true"]',
  )
  const expectLabels = async (labels) => {
    await page.waitForFunction((labels) => {
      const actual = [
        ...document.querySelectorAll(
          '.outline-sidebar[data-side="right"] [role="treeitem"][id^="right-outline-source:"] .sidebar-label',
        ),
      ].map((node) => node.textContent)
      return JSON.stringify(actual) === JSON.stringify(labels)
    }, labels)
    assert.deepEqual(
      await outline.locator('.sidebar-label').allTextContents(),
      labels,
    )
  }
  await expectLabels(nativeLabels)
  if (cm) {
    const requests = (
      await Promise.all(
        establishedWorkers
          .filter((worker) => page.workers().includes(worker))
          .map((worker) =>
            worker.evaluate(() => globalThis.outlineReferenceRequests),
          ),
      )
    ).flat()
    assert.ok(
      requests.includes('ref') ||
        (await page.evaluate(() =>
          window.outlineReferenceRequests.includes('ref'),
        )),
    )
    await assertWorkerReuse()
  } else {
    assert.ok(
      await page.evaluate(() =>
        window.outlineReferenceRequests.includes('ref'),
      ),
    )
    assert.equal(await page.evaluate(() => window.outlineWorkers.length), 1)
  }

  await replaceSourceText(page, source, original.replace('[ref]:', '[gone]:'))
  await expectLabels(['**literal** [label][ref]', 'real'])
  await replaceSourceText(page, source, original)
  await expectLabels(nativeLabels)
  // The renamed heading after the quote shows when the outline has read it.
  const nested = original
    .replace('$$\n# hidden math\n$$', () => '> $$\n> # hidden math\n> $$')
    .replace('# real', '# real after quote')
  await replaceSourceText(page, source, nested)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    nested,
  )
  assert.equal(
    (await source.locator('.cm-line').allTextContents()).join('\n'),
    nested,
    'CodeMirror retains both dollar signs in the nested math fixture',
  )
  const unavailable = outline.getByText(
    /Source outline could not read this note.*Switch to visual mode/,
  )
  await expectLabels([...nativeLabels.slice(0, -1), 'real after quote'])
  assert.equal(await unavailable.count(), 0)
  await replaceSourceText(page, source, original)
  await expectLabels(nativeLabels)
  assert.equal(await unavailable.count(), 0)
  if (cm) await assertWorkerReuse()
  else assert.equal(await page.evaluate(() => window.outlineWorkers.length), 1)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    original,
  )
  assert.deepEqual(errors, [])
})
