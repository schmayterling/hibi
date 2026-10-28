import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { marked } from 'marked'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import {
  clickMenu,
  pressShortcut,
  replaceRichText,
  replaceSourceText,
} from './keyboard.mjs'
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

test('raw HTML stays inert and exact through rich edits, atom deletion, undo, and source edits', {
  timeout: 30000,
}, async (t) => {
  const { clipboardHtml } = await import('../src/renderer/src/RawHtml.ts')
  const profile = await mkdtemp(join(tmpdir(), 'hibi-raw-html-'))
  const file = join(profile, 'raw.md')
  const kbd = '<kbd>x</kbd>'
  const span = `<span id='raw-html-span' data-note="a  &amp; b" onclick="window.__rawHtmlExecuted = true">x &lt;y&gt;</span>`
  const div = [
    `<div id="raw-html-div" data-note='keep  &amp; quotes'>`,
    '  <script id="raw-html-script">window.__rawHtmlExecuted = true</script>',
    '  <img id="raw-html-img" src="data:image/png;base64,broken" onerror="window.__rawHtmlExecuted = true">',
    '  <svg id="raw-html-svg" onload="window.__rawHtmlExecuted = true"></svg>',
    '  <img src=x onerror=alert(1)>',
    '  <iframe id="raw-html-iframe" srcdoc="<script>parent.__rawHtmlExecuted = true</script>"></iframe>',
    '  <style id="raw-html-style">.tiptap { display: none !important }</style>',
    '</div>',
  ].join('\n')
  const comment = '<!--  keep <b>literal</b> &amp;  -->'
  const details = [
    '<details id="raw-html-details">',
    '<summary id="raw-html-summary">show</summary>',
    '',
    '<p id="raw-html-first">first</p>',
    '',
    '<p id="raw-html-second">second</p>',
    '</details>',
  ].join('\n')
  const original = [
    'editable paragraph',
    `inline ${kbd} and ${span}.`,
    div,
    comment,
    details,
    'break a<BR />b',
    'last paragraph',
  ].join('\n\n')
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
  await selectFormattedEngine(app, page, 'tiptap')
  // Install probes before opening workspace markup, including detached DOM parsing.
  await page.evaluate(() => {
    window.__rawHtmlExecuted = false
    window.alert = () => {
      window.__rawHtmlExecuted = true
    }
    window.__rawHtmlCreated = []
    const record = (root) => {
      if (root.matches?.('[id^="raw-html-"]'))
        window.__rawHtmlCreated.push(root.id)
      for (const node of root.querySelectorAll?.('[id^="raw-html-"]') ?? [])
        window.__rawHtmlCreated.push(node.id)
    }
    new MutationObserver((records) => {
      for (const mutation of records)
        for (const node of mutation.addedNodes) record(node)
    }).observe(document, { childList: true, subtree: true })
    const parse = DOMParser.prototype.parseFromString
    DOMParser.prototype.parseFromString = function (...args) {
      const result = parse.apply(this, args)
      record(result)
      return result
    }
  })
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'raw.md',
  )
  await waitForDocumentEditor(app, page)
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  const serialize = () =>
    rich.evaluate((element) => element.editor.getMarkdown())
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
        html: clipboardData.getData('text/html'),
        text: clipboardData.getData('text/plain'),
      }
    })
  const paste = (data) =>
    rich.evaluate((element, { html, text }) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/html', html)
      clipboardData.setData('text/plain', text)
      element.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      )
    }, data)
  const inert = async () => {
    assert.deepEqual(
      await rich
        .locator(
          'kbd, details, summary, script, style, img:not(.ProseMirror-separator[alt=""]:not([src])), svg, iframe, object, embed, input, [id^="raw-html-"]',
        )
        .evaluateAll((nodes) => nodes.map((node) => node.outerHTML)),
      [],
      'workspace HTML must never become live editor elements',
    )
    assert.deepEqual(
      await page.evaluate(() => ({
        executed: window.__rawHtmlExecuted,
        created: window.__rawHtmlCreated,
      })),
      { executed: false, created: [] },
    )
  }
  assert.equal(
    await serialize(),
    original,
    'full serializer must retain every HTML byte',
  )
  const atoms = await rich.evaluate((element) => {
    const result = []
    element.editor.state.doc.descendants((node, pos) => {
      if (!['rawHtmlInline', 'rawHtmlBlock'].includes(node.type.name)) return
      const dom = element.editor.view.nodeDOM(pos)
      result.push({
        type: node.type.name,
        atom: node.isAtom,
        size: node.nodeSize,
        source: node.attrs.source,
        level: dom.getAttribute('data-raw-html'),
        editable: dom.getAttribute('contenteditable'),
        text: dom.querySelector('code')?.textContent,
      })
    })
    return result
  })
  for (const [source, level] of [
    [kbd, 'inline'],
    [span, 'inline'],
    [div, 'block'],
    [comment, 'block'],
    ...details.split('\n\n').map((source) => [source, 'block']),
  ]) {
    const atom = atoms.find((node) => node.source === source)
    assert.ok(atom, `missing ${level} atom: ${source}`)
    assert.equal(
      atom.type,
      level === 'inline' ? 'rawHtmlInline' : 'rawHtmlBlock',
    )
    assert.equal(atom.atom, true)
    assert.equal(atom.size, 1)
    assert.equal(atom.level, level)
    assert.equal(atom.editable, 'false')
    assert.equal(
      atom.text,
      atom.source,
      'chip must show literal source in code text',
    )
  }
  await inert()

  const edited = original.replace('editable paragraph', 'edited paragraph')
  await replaceRichText(page, rich.locator('p').first(), 'edited paragraph')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    edited,
  )
  assert.equal(await serialize(), edited)
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(
    await readFile(file, 'utf8'),
    edited,
    'unrelated edits must save original HTML bytes',
  )

  for (const [source, level, removed] of [
    [kbd, 'inline', edited.replace(kbd, '')],
    [div, 'block', edited.replace(`\n\n${div}`, '')],
  ]) {
    const before = await rich.evaluate((element) => element.editor.getJSON())
    await rich
      .locator(`[data-raw-html="${level}"]`)
      .filter({ hasText: source })
      .click()
    const selection = await rich.evaluate((element) => {
      const { selection } = element.editor.state
      return {
        source: selection.node?.attrs.source,
        atom: selection.node?.isAtom,
        size: selection.to - selection.from,
      }
    })
    assert.equal(selection.source, source)
    assert.equal(selection.atom, true)
    assert.equal(selection.size, 1, 'native click must select whole atom')
    assert.equal(await page.getByRole('dialog').count(), 0)
    await rich.press('Delete')
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      removed,
    )
    assert.equal(
      await serialize(),
      removed,
      'delete must remove only selected HTML atom',
    )
    await rich.press('ControlOrMeta+z')
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      edited,
    )
    assert.deepEqual(
      await rich.evaluate((element) => element.editor.getJSON()),
      before,
    )
    assert.equal(
      await serialize(),
      edited,
      'undo must restore exact HTML source',
    )
  }

  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const sourceEdited = edited.replace(kbd, '<kbd>y</kbd>')
  await replaceSourceText(
    page,
    page.getByRole('textbox', { name: 'Markdown editor', exact: true }),
    sourceEdited,
  )
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    sourceEdited,
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await waitForDocumentEditor(app, page)
  assert.equal(await serialize(), sourceEdited)
  assert.equal(
    await rich.locator('[data-raw-html="inline"] code').first().textContent(),
    '<kbd>y</kbd>',
  )
  await inert()
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(await readFile(file, 'utf8'), sourceEdited)

  const clipboardDocument = await rich.evaluate((element) =>
    element.editor.getJSON(),
  )
  t.beforeEach(async () => {
    await rich.evaluate((element, doc) => {
      element.editor.view.dragging = null
      element.editor.commands.setContent(doc)
      element.editor.commands.setTextSelection(1)
    }, clipboardDocument)
    // An empty selection records an empty payload, clearing clipboard trust.
    assert.equal((await copy()).html, '')
    await app.evaluate(({ clipboard }) => clipboard.clear())
    await waitForAsync(
      page,
      async (markdown) =>
        (await window.hibi.getDocument()).markdown === markdown,
      sourceEdited,
    )
  })

  await t.test('internal copy/paste restores chips', async () => {
    for (const [level, source] of [
      ['inline', '<kbd>y</kbd>'],
      ['block', div],
    ]) {
      await rich
        .locator(`[data-raw-html="${level}"]`)
        .filter({ hasText: source })
        .click()
      const before = await rich.evaluate((element) => element.editor.getJSON())
      const copied = await copy()
      assert.equal(copied.text, source)
      assert.doesNotMatch(copied.html, /data-raw-html-session/)
      assert.equal(await rich.locator('[data-raw-html-session]').count(), 0)
      await paste(copied)
      assert.deepEqual(
        await rich.evaluate((element) => element.editor.getJSON()),
        before,
      )
      assert.equal(await serialize(), sourceEdited)
      await inert()
    }
  })

  await t.test('native clipboard round-trip restores chips', async () => {
    for (const [level, source] of [
      ['inline', '<kbd>y</kbd>'],
      ['block', div],
    ]) {
      await rich
        .locator(`[data-raw-html="${level}"]`)
        .filter({ hasText: source })
        .click()
      const before = await rich.evaluate((element) => element.editor.getJSON())
      const copied = await copy()
      await page.evaluate(() => {
        window.__nativeCopy = null
        window.__nativePaste = null
        document.addEventListener(
          'copy',
          (event) => {
            window.__nativeCopy = event.clipboardData.getData('text/html')
          },
          { once: true },
        )
        document.addEventListener(
          'paste',
          (event) => {
            window.__nativePaste = event.clipboardData.getData('text/html')
          },
          { once: true },
        )
      })
      await app.evaluate(({ clipboard }) => clipboard.clear())
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.copy()
      })
      await waitForAsync(page, () => window.__nativeCopy !== null)
      assert.equal(await page.evaluate(() => window.__nativeCopy), copied.html)
      await writeRawClipboard(app, copied)
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.paste()
      })
      await waitForAsync(page, () => window.__nativePaste !== null)
      const pastedHtml = await page.evaluate(() => window.__nativePaste)
      assert.equal(clipboardHtml(pastedHtml), copied.html)
      t.diagnostic(
        `native ${level} clipboard prefix: ${JSON.stringify(pastedHtml.slice(0, pastedHtml.indexOf(copied.html)))}`,
      )
      assert.deepEqual(
        await rich.evaluate((element) => element.editor.getJSON()),
        before,
      )
      await inert()
    }
  })

  await t.test('Windows fragments restore only the copied chips', async () => {
    for (const level of ['inline', 'block']) {
      await rich.locator(`[data-raw-html="${level}"]`).first().click()
      const before = await rich.evaluate((element) => element.editor.getJSON())
      const copied = await copy()
      const outside = copied.html.replace('</code>', 'outside</code>')
      await paste({
        ...copied,
        html: windowsClipboard(copied.html)
          .replace(
            '<body>',
            `<head><meta charset="utf-8"></head><body>${outside}`,
          )
          .replace('</body>', `${outside}</body>`),
      })
      assert.deepEqual(
        await rich.evaluate((element) => element.editor.getJSON()),
        before,
      )
      assert.equal(await serialize(), sourceEdited)
      await inert()
    }
  })

  await t.test('drag data restores chips on paste and drop', async () => {
    for (const level of ['inline', 'block']) {
      const chip = rich.locator(`[data-raw-html="${level}"]`).first()
      await chip.click()
      const before = await rich.evaluate((element) => element.editor.getJSON())
      const source = await chip.textContent()
      const dragged = await chip.evaluate((element) => {
        const dataTransfer = new DataTransfer()
        const rect = element.getBoundingClientRect()
        element.dispatchEvent(
          new DragEvent('dragstart', {
            bubbles: true,
            cancelable: true,
            dataTransfer,
            clientX: rect.x + rect.width / 2,
            clientY: rect.y + rect.height / 2,
          }),
        )
        return {
          html: dataTransfer.getData('text/html'),
          text: dataTransfer.getData('text/plain'),
        }
      })
      assert.equal(dragged.text, source)
      assert.doesNotMatch(dragged.html, /data-raw-html-session/)
      await paste(dragged)
      assert.deepEqual(
        await rich.evaluate((element) => element.editor.getJSON()),
        before,
      )
      await rich.evaluate((element, data) => {
        const { view } = element.editor
        view.dragging = null
        const dataTransfer = new DataTransfer()
        dataTransfer.setData('text/html', data.html)
        dataTransfer.setData('text/plain', data.text)
        const rect = element.lastElementChild.getBoundingClientRect()
        element.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer,
            clientX: rect.x + 5,
            clientY: rect.y + rect.height / 2,
          }),
        )
      }, dragged)
      assert.equal(
        await rich.locator(`[data-raw-html="${level}"]`).count(),
        before.content
          .flatMap((node) =>
            node.type === 'rawHtmlBlock' ? [node] : (node.content ?? []),
          )
          .filter(
            (node) =>
              node.type ===
              (level === 'block' ? 'rawHtmlBlock' : 'rawHtmlInline'),
          ).length + 1,
      )
      await rich.evaluate(
        (element, doc) => element.editor.commands.setContent(doc),
        before,
      )
      await waitForAsync(
        page,
        async (markdown) =>
          (await window.hibi.getDocument()).markdown === markdown,
        sourceEdited,
      )
      await inert()
    }
  })

  await t.test('internal copy/paste keeps html break spelling', async () => {
    const before = await rich.evaluate((element) => {
      const { editor } = element
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'hardBreak')
          editor.commands.setTextSelection({ from: pos - 1, to: pos + 2 })
      })
      return editor.getJSON()
    })
    const copied = await copy()
    await paste({ ...copied, html: windowsClipboard(copied.html) })
    assert.deepEqual(
      await rich.evaluate((element) => element.editor.getJSON()),
      before,
    )
    assert.equal(await serialize(), sourceEdited)
  })

  await t.test(
    'modified and superseded copies cannot restore chips',
    async () => {
      // ProseMirror reads repeated clicks on one chip within 500 ms as double
      // or triple clicks, which select differently, so select it directly.
      const selectChip = (level) =>
        rich.evaluate(
          (element, type) => {
            const { editor } = element
            let chip = -1
            editor.state.doc.descendants((node, pos) => {
              if (chip < 0 && node.type.name === type) chip = pos
              return chip < 0
            })
            editor.commands.setNodeSelection(chip)
          },
          `rawHtml${level === 'block' ? 'Block' : 'Inline'}`,
        )
      for (const level of ['inline', 'block']) {
        await selectChip(level)
        const before = await rich.evaluate((element) =>
          element.editor.getJSON(),
        )
        const copied = await copy()
        const beforeCount = await rich
          .locator(`[data-raw-html="${level}"]`)
          .count()
        for (const stale of [false, true]) {
          if (stale) {
            await rich.evaluate((element) =>
              element.editor.commands.setTextSelection({ from: 1, to: 3 }),
            )
            await copy()
            await selectChip(level)
          }
          await paste({
            ...copied,
            html: windowsClipboard(
              stale
                ? copied.html
                : copied.html.replace('</code>', 'forged</code>'),
            ),
          })
          assert.equal(
            await rich.locator(`[data-raw-html="${level}"]`).count(),
            beforeCount - 1,
          )
          await inert()
          await rich.evaluate(
            (element, doc) => element.editor.commands.setContent(doc),
            before,
          )
          await waitForAsync(
            page,
            async (markdown) =>
              (await window.hibi.getDocument()).markdown === markdown,
            sourceEdited,
          )
        }
      }
    },
  )

  await t.test('external html falls back to escaped text or code', async () => {
    const text = '<script>alert(1)</script>'
    const escaped = '&lt;script&gt;alert(1)&lt;/script&gt;'
    for (const [tag, level, code, markdown] of [
      ['span', 'inline', false, escaped],
      ['div', 'block', false, escaped],
      ['span', 'inline', true, `\`${text}\``],
      ['pre', 'block', true, `\`\`\`\n${text}\n\`\`\``],
    ]) {
      const expected = sourceEdited.replace('last paragraph', markdown)
      for (const session of ['', ' data-raw-html-session="external"']) {
        await rich.evaluate((element) => {
          const { editor } = element
          const { doc } = editor.state
          const from = doc.content.size - doc.lastChild.nodeSize
          editor.commands.insertContentAt(
            { from, to: doc.content.size },
            { type: 'paragraph' },
          )
          editor.commands.setTextSelection(from + 1)
        })
        await paste({
          html: `<${tag} data-raw-html="${level}"${session}>${code ? `<code>${escaped}</code>` : escaped}</${tag}>`,
          text,
        })
        assert.deepEqual(
          await rich.evaluate((element) =>
            element.editor.state.doc.lastChild.toJSON(),
          ),
          tag === 'pre'
            ? {
                type: 'codeBlock',
                attrs: { language: null },
                content: [{ type: 'text', text }],
              }
            : {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    ...(code ? { marks: [{ type: 'code' }] } : {}),
                    text,
                  },
                ],
              },
        )
        await waitForAsync(
          page,
          async (markdown) =>
            (await window.hibi.getDocument()).markdown === markdown,
          expected,
        )
        await page.evaluate(() => window.hibi.saveDocument(false))
        assert.equal(await readFile(file, 'utf8'), expected)
        await inert()
      }
    }
  })
})

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

test('codemirror: literal html stays inert through native body edits, source switches and clipboard history', {
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
  const rich = await selectFormattedEngine(app, page, 'codemirror')
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
  assert.doesNotMatch(
    copied.html,
    /<script|<iframe|<style| onerror=| onclick=/i,
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
  const rich = await selectFormattedEngine(app, page, 'codemirror')
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
  test('codemirror: literal ' +
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
  test('codemirror: deleting a selected ' +
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

test('codemirror: partial native html-break clipboard keeps original spelling through cut, paste and history', {
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

test('codemirror: Windows html fragment wrappers exclude outside markup and retain literal selected source', {
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
  test('codemirror: literal html drag data survives ' +
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

const rawCopyGaps = {
  inline: {
    modified:
      'formatted gap contracts-003: modified inline html copies must fall back without restoring raw markup',
    superseded:
      'formatted gap contracts-004: superseded inline html copies must fall back without restoring raw markup',
  },
  block: {
    modified:
      'formatted gap contracts-005: modified block html copies must fall back without restoring raw markup',
    superseded:
      'formatted gap contracts-006: superseded block html copies must fall back without restoring raw markup',
  },
}

for (const level of ['inline', 'block']) {
  test('codemirror: modified and superseded ' +
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
      await pasteRawData(rich, { ...copied, html })
      await t.test(
        stale
          ? 'superseded copy rejects raw restoration'
          : 'modified copy rejects raw restoration',
        { todo: rawCopyGaps[level][stale ? 'superseded' : 'modified'] },
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

test('codemirror: external html falls back to escaped text or code without trusting raw-html attributes', {
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
