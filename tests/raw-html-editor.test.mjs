import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { marked } from 'marked'
import {
  electron,
  waitForDocumentEditor,
  waitForFormattedEditor,
} from './electron.mjs'
import { clickMenu, pressShortcut, replaceSourceText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const windowsClipboard = (html) =>
  `<html>\r\n<body>\r\n<!--StartFragment-->${html}<!--EndFragment-->\r\n</body>\r\n</html>`

const cmRawHtmlSource =
  [
    'editable paragraph',
    '<kbd>x</kbd> <span id="raw-html-span" onclick="window.__rawExecuted=true">é &amp; 😀</span>',
    '<div id="raw-html-div">\nraw block body\n<script id="raw-html-script">window.__rawExecuted=true</script>\n<img id="raw-html-img" src="x" onerror="window.__rawExecuted=true">\n<img src=x onerror="window.__rawExecuted=true">\n<object data="x"></object>\n<embed src="x">\n<input onfocus="window.__rawExecuted=true">\n<svg id="raw-html-svg" onload="window.__rawExecuted=true"></svg>\n<iframe id="raw-html-iframe" srcdoc="unsafe"></iframe>\n<style id="raw-html-style">body { display:none }</style>\n</div>',
    '<!--  keep <b>literal</b> &amp;  -->',
    '<details id="raw-html-details">\n<summary id="raw-html-summary">show</summary>\n\n<p id="raw-html-first">first</p>\n\n<p id="raw-html-last">last</p>\n</details>',
    'break a<BR />b',
    'last paragraph',
  ].join('\n\n') + '\n'

async function probeRawDocumentParsing(page) {
  await page.evaluate(() => {
    window.rawDocumentParses = []
    const parse = DOMParser.prototype.parseFromString
    DOMParser.prototype.parseFromString = function (...args) {
      const document = parse.apply(this, args)
      window.rawDocumentParses.push(
        ...[
          ...document.querySelectorAll(
            'kbd, details, summary, script, style, img, svg, iframe, object, embed, input, [id^="raw-html-"]',
          ),
        ].map((element) => [element.localName, element.id]),
      )
      return document
    }
    window.restoreRawDocumentParsing = () => {
      DOMParser.prototype.parseFromString = parse
      delete window.restoreRawDocumentParsing
    }
  })
}

test('literal html stays inert through native body edits, source switches and clipboard history', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-formatted-raw-html-'))
  const file = join(profile, 'raw.md')
  const original = cmRawHtmlSource
  await writeFile(file, original)
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
  const rich = await waitForFormattedEditor(app, page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await app.evaluate(({ clipboard }) => clipboard.clear())
  await probeRawDocumentParsing(page)
  await page.evaluate(() => {
    window.__rawExecuted = false
    window.__rawCreated = []
    window.alert = () => {
      window.__rawExecuted = true
    }
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (node.matches?.('[id^="raw-html-"]'))
            window.__rawCreated.push(node.id)
          for (const element of node.querySelectorAll?.('[id^="raw-html-"]') ??
            [])
            window.__rawCreated.push(element.id)
        }
    }).observe(document, { subtree: true, childList: true })
  })
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await clickMenu(app, 'Open…')
  await waitForDocumentEditor(app, page)
  const saved = (expected) =>
    waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      expected,
    )
  const inert = async () => {
    assert.equal(
      await rich
        .locator(
          '[id^="raw-html-"], kbd, details, summary, script, style, svg, iframe',
        )
        .count(),
      0,
    )
    // codemirror widget buffers are editor decorations.
    assert.equal(
      await rich
        .locator('img:not(.cm-widgetBuffer), object, embed, input')
        .count(),
      0,
    )
    assert.equal(await page.evaluate(() => window.__rawExecuted), false)
  }
  await saved(original)
  await inert()
  assert.deepEqual(await page.evaluate(() => window.__rawCreated), [])
  await rich.locator('.cm-line', { hasText: /^editable paragraph$/ }).click()
  await rich.press('Home')
  await rich.press('Shift+End')
  await page.keyboard.insertText('edited paragraph')
  const edited = original.replace('editable paragraph', 'edited paragraph')
  await saved(edited)
  await inert()
  assert.deepEqual(await page.evaluate(() => window.__rawCreated), [])
  await clickMenu(app, 'Save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), edited)

  assert.deepEqual(await page.evaluate(() => window.rawDocumentParses), [])
  // Clipboard rendering/conversion intentionally parses sanitized HTML; end the document-only probe first.
  await page.evaluate(() => window.restoreRawDocumentParsing())
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const native = async (command) => {
    if (command === 'copy' || command === 'cut')
      await app.evaluate(({ clipboard }) => clipboard.clear())
    const before = await page.evaluate((command) => {
      window.__rawClipboardCount ??= 0
      document.addEventListener(
        command,
        () =>
          queueMicrotask(() => {
            window.__rawClipboardCount++
          }),
        { once: true, capture: true },
      )
      return window.__rawClipboardCount
    }, command)
    await app.evaluate(
      ({ BrowserWindow }, command) =>
        BrowserWindow.getAllWindows()[0].webContents[command](),
      command,
    )
    await page.waitForFunction(
      (before) => window.__rawClipboardCount > before,
      before,
    )
  }
  await rich.focus()
  await rich.press('ControlOrMeta+a')
  await native('copy')
  const copied = await app.evaluate(async ({ clipboard }) => {
    const item = (await clipboard.read()).find((item) =>
      item.types.includes('text/html'),
    )
    return {
      text: await clipboard.readText(),
      html: item ? await (await item.getType('text/html')).text() : '',
    }
  })
  assert.equal(copied.text, edited)
  // Raw HTML copies as the literal text this view shows: the copy wrapper,
  // paragraphs, html breaks and literal text are its only elements.
  const copiedElements = await page.evaluate(
    (html) =>
      [
        ...new DOMParser()
          .parseFromString(html, 'text/html')
          .body.querySelectorAll('*'),
      ].map((element) =>
        [
          element.localName,
          ...[...element.attributes].map(
            ({ name, value }) => `${name}=${value}`,
          ),
        ].join(' '),
      ),
    copied.html,
  )
  for (const element of copiedElements)
    assert.match(
      element,
      /^(?:div data-hibi-markdown=|p|br|div class=hibi-literal-block|span class=hibi-literal-inline)$/,
    )
  await native('cut')
  await saved('')
  await pressShortcut(app, `${mod}+z`)
  await saved(edited)
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y',
  )
  await saved('')
  await writeRawClipboard(app, copied)
  await native('paste')
  await saved(edited)
  await inert()

  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  const sourceEdited = edited.replace('<kbd>x</kbd>', '<kbd>y</kbd>')
  await replaceSourceText(page, source, sourceEdited)
  await saved(sourceEdited)
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.waitFor()
  await inert()
  await saved(sourceEdited)
  assert.equal(await rich.getAttribute('contenteditable'), 'true')
  await clickMenu(app, 'Save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), sourceEdited)
})

async function rawCMFixture(t) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-raw-cm-case-'))
  const file = join(profile, 'raw.md')
  await writeFile(file, cmRawHtmlSource)
  const app = await electron.launch({
    args: [resolve('.'), '--user-data-dir=' + profile],
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
  const rich = await waitForFormattedEditor(app, page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await app.evaluate(({ clipboard }) => clipboard.clear())
  await probeRawDocumentParsing(page)
  await page.evaluate(() => {
    window.__rawExecuted = false
    window.alert = () => {
      window.__rawExecuted = true
    }
  })
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await clickMenu(app, 'Open…')
  await waitForDocumentEditor(app, page)
  const saved = (expected) =>
    waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      expected,
    )
  const inert = async () => {
    assert.equal(
      await rich
        .locator(
          'kbd, details, summary, script, style, img:not(.cm-widgetBuffer), svg, iframe, object, embed, input, [id^="raw-html-"]',
        )
        .count(),
      0,
    )
    assert.equal(await page.evaluate(() => window.__rawExecuted), false)
  }
  await saved(cmRawHtmlSource)
  await inert()
  assert.deepEqual(await page.evaluate(() => window.rawDocumentParses), [])
  // This probe covers workspace rendering. Copy/export and paste intentionally parse sanitized HTML.
  await page.evaluate(() => window.restoreRawDocumentParsing())
  return { app, page, rich, file, original: cmRawHtmlSource, saved, inert }
}

async function selectRawSource(rich, from, to) {
  await rich.focus()
  return rich.evaluate(
    (element, { from, to }) => {
      const view = element.cmTile.root.view
      view.dispatch({
        selection: { anchor: from, head: to },
        scrollIntoView: true,
      })
      return view.state.sliceDoc(
        view.state.selection.main.from,
        view.state.selection.main.to,
      )
    },
    { from, to },
  )
}

async function writeRawClipboard(app, { text, html }) {
  await app.evaluate(
    async ({ clipboard, ClipboardItem }, { text, html }) => {
      await clipboard.clear()
      await clipboard.write([
        new ClipboardItem({
          'text/plain': text,
          ...(html ? { 'text/html': html } : {}),
        }),
      ])
    },
    { text, html },
  )
}

async function rawNativeClipboard(app, page, command) {
  if (command === 'paste') {
    const copied = await page.evaluate(() =>
      window.rawCaseClipboardEvents.findLast(
        ({ command }) => command !== 'paste',
      ),
    )
    await writeRawClipboard(app, copied)
  }
  if (command === 'copy' || command === 'cut')
    await app.evaluate(({ clipboard }) => clipboard.clear())
  const before = await page.evaluate((command) => {
    window.rawCaseClipboardEvents ??= []
    const before = window.rawCaseClipboardEvents.length
    document.addEventListener(
      command,
      (event) => {
        const data = {
          command,
          text: event.clipboardData.getData('text/plain'),
          html: event.clipboardData.getData('text/html'),
        }
        queueMicrotask(() => window.rawCaseClipboardEvents.push(data))
      },
      { once: true },
    )
    return before
  }, command)
  await app.evaluate(({ BrowserWindow }, command) => {
    BrowserWindow.getAllWindows()[0].webContents[command]()
  }, command)
  await page.waitForFunction(
    (before) => window.rawCaseClipboardEvents.length > before,
    before,
  )
  return page.evaluate(() => window.rawCaseClipboardEvents.at(-1))
}

async function pasteRawData(rich, data) {
  await rich.evaluate((element, { text, html }) => {
    const view = element.cmTile.root.view
    const update = view.update
    window.rawPasteComplete = false
    view.update = function (transactions) {
      update.call(this, transactions)
      if (transactions.some((tr) => tr.isUserEvent('input.paste'))) {
        view.update = update
        window.rawPasteComplete = true
      }
    }
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    if (html) clipboardData.setData('text/html', html)
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    )
  }, data)
  await rich.page().waitForFunction(() => window.rawPasteComplete)
}

for (const [label, find, replacement] of [
  ['inline', 'x</kbd>', 'y'],
  ['block', 'raw block body', 'changed block body'],
]) {
  test('literal ' +
    label +
    ' html body accepts native edits and exact undo without executing markup', {
    timeout: 45000,
  }, async (t) => {
    const { app, page, rich, original, saved, inert } = await rawCMFixture(t)
    const from = original.indexOf(find)
    const text = label === 'inline' ? 'x' : find
    assert.equal(await selectRawSource(rich, from, from + text.length), text)
    await page.keyboard.insertText(replacement)
    const edited =
      original.slice(0, from) + replacement + original.slice(from + text.length)
    await saved(edited)
    assert.equal(await rich.getAttribute('contenteditable'), 'true')
    assert.equal(await page.getByRole('dialog').count(), 0)
    await inert()
    await pressShortcut(
      app,
      process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
    )
    await saved(original)
    await inert()
  })
}

for (const level of ['inline', 'block']) {
  test('deleting a selected ' +
    level +
    ' html source range preserves surrounding bytes and undo', {
    timeout: 45000,
  }, async (t) => {
    const { app, page, rich, original, saved, inert } = await rawCMFixture(t)
    // Select the literal source range for deletion and native history.
    const from = original.indexOf(
      level === 'inline' ? '<kbd>' : '<div id="raw-html-div">',
    )
    const to =
      level === 'inline'
        ? original.indexOf('</kbd>', from) + 6
        : original.indexOf('</div>', from) + 6
    assert.equal(
      await selectRawSource(rich, from, to),
      original.slice(from, to),
    )
    assert.equal(await page.getByRole('dialog').count(), 0)
    await page.keyboard.press('Delete')
    await saved(original.slice(0, from) + original.slice(to))
    await inert()
    await pressShortcut(
      app,
      process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
    )
    await saved(original)
    await inert()
  })
}

test('partial native html-break clipboard keeps original spelling through cut, paste and history', {
  timeout: 45000,
}, async (t) => {
  const { app, page, rich, original, saved, inert } = await rawCMFixture(t)
  const fragment = 'a<BR />b'
  const from = original.indexOf(fragment),
    to = from + fragment.length
  assert.equal(await selectRawSource(rich, from, to), fragment)
  const copied = await rawNativeClipboard(app, page, 'copy')
  assert.equal(copied.text, fragment)
  assert.doesNotMatch(copied.html, /data-raw-html-session/)
  assert.equal(
    await page.evaluate(
      (html) =>
        new DOMParser()
          .parseFromString(html, 'text/html')
          .querySelectorAll('br').length,
      copied.html,
    ),
    1,
  )
  await rawNativeClipboard(app, page, 'cut')
  const removed = original.slice(0, from) + original.slice(to)
  await saved(removed)
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  await saved(original)
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y',
  )
  await saved(removed)
  const pasted = await rawNativeClipboard(app, page, 'paste')
  await saved(original)
  // Only Windows exposes its hosted native clipboard envelope; the portable fragment case below runs everywhere.
  if (process.platform === 'win32') {
    const fragments = await page.evaluate(
      (html) =>
        html.map((value) => {
          const fragment =
            /<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/i.exec(
              value,
            )?.[1] ?? value
          return new DOMParser().parseFromString(fragment, 'text/html').body
            .innerHTML
        }),
      [pasted.html, copied.html],
    )
    assert.equal(fragments[0], fragments[1])
  }
  await inert()
})

test('Windows html fragment wrappers exclude outside markup and retain literal selected source', {
  timeout: 45000,
}, async (t) => {
  const { page, rich, original, saved, inert } = await rawCMFixture(t)
  const fragment = '<kbd>x</kbd>'
  const from = original.indexOf(fragment),
    to = from + fragment.length
  assert.equal(await selectRawSource(rich, from, to), fragment)
  const copied = await rich.evaluate((element) => {
    const clipboardData = new DataTransfer()
    element.dispatchEvent(
      new ClipboardEvent('copy', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    )
    return {
      text: clipboardData.getData('text/plain'),
      html: clipboardData.getData('text/html'),
    }
  })
  assert.equal(copied.text, fragment)
  await page.keyboard.press('Delete')
  await saved(original.slice(0, from) + original.slice(to))
  const wrapped = windowsClipboard(copied.html)
    .replace(
      '<body>',
      '<head><meta charset="utf-8"></head><body><div>OUTSIDE BEFORE</div>',
    )
    .replace('</body>', '<div>OUTSIDE AFTER</div></body>')
  await pasteRawData(rich, { ...copied, html: wrapped })
  await waitForAsync(
    page,
    async (removed) => (await window.hibi.getDocument()).markdown !== removed,
    original.slice(0, from) + original.slice(to),
  )
  const pasted = (await page.evaluate(() => window.hibi.getDocument())).markdown
  t.diagnostic(
    JSON.stringify({
      outsideBefore: pasted.includes('OUTSIDE BEFORE'),
      outsideAfter: pasted.includes('OUTSIDE AFTER'),
      restoredExactSource: pasted === original,
      insertedPrefix: pasted.slice(from, from + 80),
    }),
  )
  assert.doesNotMatch(pasted, /OUTSIDE/)
  assert.equal(pasted, original)
  await inert()
})

for (const route of ['paste', 'drop']) {
  test('literal html drag data survives ' +
    route +
    ' without becoming live markup', {
    timeout: 45000,
  }, async (t) => {
    const { app, page, rich, original, saved, inert } = await rawCMFixture(t)
    const fragment = '<kbd>x</kbd>'
    const from = original.indexOf(fragment),
      to = from + fragment.length
    assert.equal(await selectRawSource(rich, from, to), fragment)
    const dragged = await rich.evaluate((element) => {
      const dataTransfer = new DataTransfer()
      const view = element.cmTile.root.view
      const at = view.coordsAtPos(view.state.selection.main.from)
      element.dispatchEvent(
        new DragEvent('dragstart', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          clientX: at.left + 1,
          clientY: (at.top + at.bottom) / 2,
        }),
      )
      const data = {
        text: dataTransfer.getData('text/plain'),
        html: dataTransfer.getData('text/html'),
      }
      element.dispatchEvent(
        new DragEvent('dragend', { bubbles: true, dataTransfer }),
      )
      return data
    })
    assert.equal(dragged.text, fragment)
    assert.doesNotMatch(dragged.html, /data-raw-html-session/)
    if (route === 'paste') {
      await page.keyboard.press('Delete')
      await saved(original.slice(0, from) + original.slice(to))
      await pasteRawData(rich, dragged)
      await saved(original)
    } else {
      const target = original.indexOf('last paragraph')
      await selectRawSource(rich, target, target)
      await page.evaluate(() => new Promise(requestAnimationFrame))
      const point = await rich.evaluate((element, target) => {
        const at = element.cmTile.root.view.coordsAtPos(target)
        return { x: at.left + 1, y: (at.top + at.bottom) / 2 }
      }, target)
      const cdp = await page.context().newCDPSession(page)
      try {
        const items = [{ mimeType: 'text/plain', data: dragged.text }]
        if (dragged.html)
          items.push({ mimeType: 'text/html', data: dragged.html })
        for (const type of ['dragEnter', 'dragOver', 'drop'])
          await cdp.send('Input.dispatchDragEvent', {
            type,
            ...point,
            data: { items, files: [], dragOperationsMask: 1 },
          })
      } finally {
        await cdp.detach()
      }
      await saved(original.slice(0, target) + fragment + original.slice(target))
      await pressShortcut(
        app,
        process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
      )
      await saved(original)
    }
    await inert()
  })
}

test('native copied source requires both formats and source copies supersede formatted copies', {
  timeout: 45000,
}, async (t) => {
  const { app, page, rich, file, original, saved, inert } =
    await rawCMFixture(t)
  const fragment = '<kbd>x</kbd>'
  const from = original.indexOf(fragment),
    to = from + fragment.length
  const escaped =
    original.slice(0, from) + String.raw`\<kbd>x\</kbd>` + original.slice(to)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const paste = async (data, expected) => {
    const before = await page.evaluate(() => window.hibi.getDocument())
    await writeRawClipboard(app, data)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.paste(),
    )
    await saved(expected)
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).contentVersion,
      before.contentVersion + 1,
    )
    await inert()
  }
  await selectRawSource(rich, from, to)
  const copied = await rawNativeClipboard(app, page, 'copy')
  assert.equal(copied.text, fragment)
  await paste({ ...copied, text: '<script>forged</script>' }, escaped)
  await pressShortcut(app, `${mod}+z`)
  await saved(original)

  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  assert.equal(
    await selectRawSource(source, 0, 'editable paragraph'.length),
    'editable paragraph',
  )
  const plain = await rawNativeClipboard(app, page, 'copy')
  assert.equal(plain.text, 'editable paragraph')
  assert.equal(plain.html, '')
  assert.equal(
    await source.evaluate((element) =>
      element.cmTile.root.view.state.doc.toString(),
    ),
    original,
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.waitFor()
  await selectRawSource(rich, from, to)
  await paste(copied, escaped)
  await pressShortcut(app, `${mod}+z`)
  await saved(original)
  await selectRawSource(rich, from, to)
  const plainPasted = original.slice(0, from) + plain.text + original.slice(to)
  await paste(plain, plainPasted)
  await pressShortcut(app, `${mod}+z`)
  await saved(original)
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y',
  )
  await saved(plainPasted)
  await inert()
  await clickMenu(app, 'Save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), plainPasted)
})

for (const trusted of [true, false]) {
  test('cold html paste ' +
    (trusted
      ? 'keeps accepted source after another copy'
      : 'cannot gain trust from a later matching copy'), {
    timeout: 45000,
  }, async (t) => {
    const { app, page, rich, file, original, saved, inert } =
      await rawCMFixture(t)
    const fragment = '<kbd>x</kbd>'
    const from = original.indexOf(fragment),
      to = from + fragment.length
    await selectRawSource(rich, from, to)
    const copied = await rawNativeClipboard(app, page, 'copy')
    let before = original
    if (trusted) {
      await rich.press('Delete')
      before = original.slice(0, from) + original.slice(to)
      await saved(before)
      await selectRawSource(rich, from, from)
    } else {
      await selectRawSource(rich, 0, 'editable paragraph'.length)
      await rawNativeClipboard(app, page, 'copy')
      await selectRawSource(rich, from, to)
    }
    const expected = trusted
      ? original
      : original.slice(0, from) +
        String.raw`\<kbd>x\</kbd>` +
        original.slice(to)
    assert.equal(
      await page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .some((entry) => entry.name.includes('/html-markdown-')),
      ),
      false,
      'converter must be cold',
    )
    await app.evaluate(({ net }) => {
      const fetch = net.fetch
      let release
      const held = new Promise((resolve) => {
        release = resolve
      })
      const state = {
        requested: false,
        release,
        restore: () => {
          net.fetch = fetch
        },
      }
      globalThis.rawColdImport = state
      net.fetch = async function (...args) {
        if (/\/html-markdown-[^/]+\.js$/.test(String(args[0]))) {
          state.requested = true
          await held
        }
        return fetch.apply(this, args)
      }
    })
    await rich.evaluate((element) => {
      const view = element.cmTile.root.view
      const update = view.update
      window.rawPasteComplete = false
      view.update = function (transactions) {
        update.call(this, transactions)
        if (transactions.some((tr) => tr.isUserEvent('input.paste'))) {
          view.update = update
          window.rawPasteComplete = true
        }
      }
      document.addEventListener(
        'paste',
        (event) => {
          window.rawColdPaste = {
            text: event.clipboardData.getData('text/plain'),
            html: event.clipboardData.getData('text/html'),
          }
        },
        { once: true, capture: true },
      )
    })
    const version = (await page.evaluate(() => window.hibi.getDocument()))
      .contentVersion
    let later
    try {
      await writeRawClipboard(app, copied)
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.paste(),
      )
      await waitForAsync(app, () => globalThis.rawColdImport.requested)
      await selectRawSource(
        rich,
        trusted ? 0 : from,
        trusted ? 'editable paragraph'.length : to,
      )
      later = await rawNativeClipboard(app, page, 'copy')
      assert.equal(later.text, trusted ? 'editable paragraph' : copied.text)
      if (!trusted) assert.equal(later.html, copied.html)
    } finally {
      await app.evaluate(() => {
        globalThis.rawColdImport.release()
        globalThis.rawColdImport.restore()
        delete globalThis.rawColdImport
      })
    }
    await page.waitForFunction(() => window.rawPasteComplete)
    const actual = await rich.evaluate((element) =>
      element.cmTile.root.view.state.doc.toString(),
    )
    await saved(actual)
    const state = await page.evaluate(() => window.hibi.getDocument())
    await clickMenu(app, 'Save')
    await waitForAsync(
      page,
      async () => !(await window.hibi.getDocument()).dirty,
    )
    assert.equal(await readFile(file, 'utf8'), actual)
    await inert()
    t.diagnostic(
      JSON.stringify({
        trusted,
        copied,
        later,
        pasted: await page.evaluate(() => window.rawColdPaste),
        actual,
        contentVersion: state.contentVersion,
        beforeVersion: version,
      }),
    )
    assert.equal(actual, expected)
    assert.equal(state.contentVersion, version + 1)
    if (trusted)
      assert.deepEqual(
        await rich.evaluate((element) => {
          const { main } = element.cmTile.root.view.state.selection
          return { anchor: main.anchor, head: main.head }
        }),
        { anchor: 0, head: 'editable paragraph'.length },
      )
    await rich.focus()
    await pressShortcut(
      app,
      process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
    )
    await saved(before)
    await pressShortcut(
      app,
      process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y',
    )
    await saved(expected)
    await inert()
  })
}

for (const level of ['inline', 'block']) {
  test('modified and superseded ' +
    level +
    ' html copies cannot restore literal markup', {
    timeout: 45000,
  }, async (t) => {
    const { app, page, rich, file, original, saved, inert } =
      await rawCMFixture(t)
    const from = original.indexOf(
      level === 'inline' ? '<kbd>' : '<div id="raw-html-div">',
    )
    const to =
      level === 'inline'
        ? original.indexOf('</kbd>', from) + 6
        : original.indexOf('</div>', from) + 6
    const fragment = original.slice(from, to)
    const copy = () =>
      rich.evaluate((element) => {
        const clipboardData = new DataTransfer()
        element.dispatchEvent(
          new ClipboardEvent('copy', {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        )
        return {
          text: clipboardData.getData('text/plain'),
          html: clipboardData.getData('text/html'),
        }
      })
    for (const stale of [false, true]) {
      await rich.evaluate((element, text) => {
        const view = element.cmTile.root.view
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
        })
      }, original)
      await saved(original)
      await selectRawSource(rich, from, to)
      const copied = await copy()
      assert.equal(copied.text, fragment)
      assert.ok(copied.html)
      if (stale) {
        await selectRawSource(rich, 0, 'editable paragraph'.length)
        const superseding = await copy()
        assert.equal(superseding.text, 'editable paragraph')
        await selectRawSource(rich, from, to)
      }
      const html = stale
        ? copied.html
        : copied.html.replace('</div>', 'forged</div>')
      const before = await page.evaluate(() => window.hibi.getDocument())
      await pasteRawData(rich, { ...copied, html })
      const after = await page.evaluate(() => window.hibi.getDocument())
      assert.equal(after.contentVersion, before.contentVersion + 1)
      await t.test(
        stale
          ? 'superseded copy rejects raw restoration'
          : 'modified copy rejects raw restoration',
        async () => {
          const pasted = (await page.evaluate(() => window.hibi.getDocument()))
            .markdown
          assert.ok(
            !pasted.includes(fragment),
            'untrusted copy must not restore literal html',
          )
          if (!stale) assert.match(pasted, /forged/)
        },
      )
      const pasted = (await page.evaluate(() => window.hibi.getDocument()))
        .markdown
      const selection = await rich.evaluate((element) => {
        const { main } = element.cmTile.root.view.state.selection
        return { anchor: main.anchor, head: main.head }
      })
      assert.equal(selection.anchor, selection.head)
      await rich.focus()
      await pressShortcut(
        app,
        process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
      )
      await saved(original)
      await inert()
      await pressShortcut(
        app,
        process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y',
      )
      await saved(pasted)
      assert.deepEqual(
        await rich.evaluate((element) => {
          const { main } = element.cmTile.root.view.state.selection
          return { anchor: main.anchor, head: main.head }
        }),
        selection,
      )
      await page
        .getByRole('button', { name: 'Source view', exact: true })
        .click()
      await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
      assert.equal(
        await page
          .getByRole('textbox', { name: 'Markdown editor', exact: true })
          .evaluate((element) => element.cmTile.root.view.state.doc.toString()),
        pasted,
      )
      await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
      await rich.waitFor()
      await inert()
      await clickMenu(app, 'Save')
      await waitForAsync(
        page,
        async () => !(await window.hibi.getDocument()).dirty,
      )
      assert.equal(
        await readFile(file, 'utf8'),
        (await page.evaluate(() => window.hibi.getDocument())).markdown,
      )
    }
  })
}

test('external html falls back to escaped text or code without trusting raw-html attributes', {
  timeout: 45000,
}, async (t) => {
  const { app, page, rich, file, original, saved, inert } =
    await rawCMFixture(t)
  const text = '<script>alert(1)</script>'
  const escaped = '&lt;script&gt;alert(1)&lt;/script&gt;'
  for (const [tag, level, code, markdown] of [
    ['span', 'inline', false, escaped],
    ['div', 'block', false, escaped],
    ['span', 'inline', true, '`' + text + '`'],
    ['pre', 'block', true, '```\n' + text + '\n```'],
  ]) {
    for (const session of ['', ' data-raw-html-session="external"']) {
      await rich.evaluate((element, text) => {
        const view = element.cmTile.root.view
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
        })
      }, original)
      await saved(original)
      const from = original.indexOf('last paragraph')
      await selectRawSource(rich, from, from + 'last paragraph'.length)
      await pasteRawData(rich, {
        html:
          '<' +
          tag +
          ' data-raw-html="' +
          level +
          '"' +
          session +
          '>' +
          (code ? '<code>' + escaped + '</code>' : escaped) +
          '</' +
          tag +
          '>',
        text,
      })
      await t.test(
        tag +
          (code ? ' code' : ' text') +
          (session ? ' with forged session' : ' without session'),
        async () => {
          const pasted = (await page.evaluate(() => window.hibi.getDocument()))
            .markdown
          const prefix = original.slice(0, from)
          const suffix = original.slice(from + 'last paragraph'.length)
          assert.ok(pasted.startsWith(prefix))
          assert.ok(pasted.endsWith(suffix))
          const inserted = pasted.slice(
            prefix.length,
            pasted.length - suffix.length,
          )
          assert.equal(marked.parse(inserted), marked.parse(markdown))
        },
      )
      await inert()
      await clickMenu(app, 'Save')
      await waitForAsync(
        page,
        async () => !(await window.hibi.getDocument()).dirty,
      )
      assert.equal(
        await readFile(file, 'utf8'),
        (await page.evaluate(() => window.hibi.getDocument())).markdown,
      )
    }
  }
})
