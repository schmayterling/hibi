import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import {
  clickMenu,
  pressShortcut,
  replaceRichText,
  replaceSourceText,
} from './keyboard.mjs'
import { NATIVE_COMPILER_READY_TIMEOUT, waitForAsync } from './poll.mjs'
import { uiName } from './ui.mjs'

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=',
  'base64',
)
const note = `---
title: Hidden properties
---
# Quarterly garden plan

Inline math $e^{i\\pi} + 1 = 0$ sits in a sentence with a footnote[^soil].

$$
\\bar{x} = \\frac{1}{n} \\sum_{i=1}^{n} x_i
$$

| Bed | Crop |
| --- | ---- |
| North | Tomatoes |
| South | Basil |

> [!NOTE]
> Remember to water the seedlings.

> [!TIP]- Folded harvest tip
> Pick basil before it flowers.

\`\`\`js
const answer = 42
\`\`\`

- [x] Order compost
- [ ] Plant garlic

![Garden pixel](pixel.png)

\`\`\`mermaid
graph TD
  Seed --> Sprout
\`\`\`

\`\`\`typst
$ x^2 + y^2 $
\`\`\`

[^soil]: Loam drains well.

> \`\`\`typst
> $ x $
> \`\`\`
Outside typst
===

> $$
> x
> $$
Outside math
===

> -# Small words
Outside subtext
===

> > [!NOTE]
> > \`\`\`
> > Nested code
> > \`\`\`
Outside alert
===

Boundary note[^boundary].

[^boundary]: \`\`\`
    Footnote code
    \`\`\`
Outside footnote
===
`

function assertLightDiagram(html) {
  const diagram = html.match(/<img[^>]+class="mermaid-diagram"[^>]+>/)?.[0]
  assert.ok(diagram, 'rendered Mermaid image in print page')
  const svg = decodeURIComponent(
    diagram.match(/src="data:image\/svg\+xml,([^"]+)"/)[1],
  )
  assert.match(svg, /--pele-bg:#ffffff/, 'dark app exports a light diagram')
  assert.doesNotMatch(svg, /--pele-bg:#181818/, 'no dark diagram background')
}

async function printWindows(app) {
  return app.evaluate(
    ({ BrowserWindow, session }) =>
      BrowserWindow.getAllWindows().filter(
        (window) =>
          window.webContents.session === session.fromPartition('hibi-print'),
      ).length,
  )
}

async function pdfText(path) {
  const data = new Uint8Array(await readFile(path))
  assert.equal(Buffer.from(data.subarray(0, 5)).toString(), '%PDF-')
  const task = getDocument({ data, isEvalSupported: false })
  const pdf = await task.promise
  let text = ''
  let images = 0
  for (let index = 1; index <= pdf.numPages; index++) {
    const page = await pdf.getPage(index)
    const content = await page.getTextContent()
    for (const item of content.items)
      text += (item.str ?? '') + (item.hasEOL ? '\n' : '')
    const { fnArray } = await page.getOperatorList()
    images += fnArray.filter(
      (fn) =>
        fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject,
    ).length
  }
  const pages = pdf.numPages
  await task.destroy()
  return { text, pages, images }
}

test('exports the active note as a PDF from the palette and the File menu', {
  timeout: 90000 + NATIVE_COMPILER_READY_TIMEOUT,
}, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hibi-pdf-export-')))
  // Set HIBI_PDF_OUTPUT to keep the exported PDFs for review.
  const output = process.env.HIBI_PDF_OUTPUT
    ? resolve(process.env.HIBI_PDF_OUTPUT)
    : root
  const notes = join(root, 'notes')
  const profile = join(root, 'profile')
  await mkdir(notes, { recursive: true })
  await mkdir(profile, { recursive: true })
  await mkdir(output, { recursive: true })
  const file = join(notes, 'garden.md')
  await writeFile(file, note)
  await writeFile(join(notes, 'pixel.png'), pixel)
  await writeFile(join(notes, 'private.png'), pixel)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ math: true, typst: true, 'text-extras': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await selectFormattedEngine(app, page, t.formattedEngine)
  await page.evaluate(() => {
    localStorage.setItem(
      'hibi-colorscheme',
      JSON.stringify({
        mode: 'dark',
        light: 'hibi-light',
        dark: 'hibi-dark',
      }),
    )
  })
  await page.reload()
  await page.waitForFunction(
    () => getComputedStyle(document.documentElement).colorScheme === 'dark',
  )
  await app.evaluate(({ app, session }) => {
    globalThis.pdfPreferences = []
    app.on('browser-window-created', (_event, window) => {
      if (window.webContents.session !== session.fromPartition('hibi-print'))
        return
      const preferences = window.webContents.getLastWebPreferences()
      globalThis.pdfPreferences.push({
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
        javascript: preferences.javascript,
      })
    })
    const protocol = session.fromPartition('hibi-print', {
      cache: false,
    }).protocol
    const handle = protocol.handle.bind(protocol)
    protocol.handle = (scheme, handler) =>
      handle(scheme, async (request) => {
        const response = await handler(request)
        globalThis.pdfHtml = await response.clone().text()
        return response
      })
  })
  await page.waitForFunction(() =>
    ['math', 'mermaid', 'markdown', 'typst', 'text-extras'].every(
      (id) => performance.getEntriesByName(`hibi:addon:${id}`).length,
    ),
  )
  await waitForDocumentEditor(app, page)
  const draft = `Unsaved formatted ${t.formattedEngine} content`
  await replaceRichText(
    page,
    page.getByRole('textbox', { name: 'Document editor' }),
    draft,
  )
  const draftPdf = join(output, `${t.formattedEngine}-draft.pdf`)
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
  }, draftPdf)
  await clickMenu(app, 'Export as PDF…')
  await page
    .getByText(uiName(`Exported ${t.formattedEngine}-draft.pdf.`))
    .waitFor()
  assert.ok((await pdfText(draftPdf)).text.includes(draft))
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).savedMarkdown,
    '',
  )
  assert.equal(await printWindows(app), 0)
  await app.evaluate(({ dialog }, file) => {
    dialog.showMessageBox = async () => ({ response: 1 })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await clickMenu(app, 'Open…')
  // Export reads the document, whichever editor shows it.
  await waitForAsync(
    page,
    async (note) => (await window.hibi.getDocument()).markdown === note,
    note,
  )

  async function exportTo(name, run) {
    const target = join(output, `${t.formattedEngine}-${name}.pdf`)
    await app.evaluate(({ dialog, BrowserWindow }, target) => {
      globalThis.pdfSaveOptions = null
      dialog.showSaveDialog = async (window, options) => {
        if (!(window instanceof BrowserWindow))
          throw new Error('The PDF save dialog must keep its parent window.')
        globalThis.pdfSaveOptions = options
        return { canceled: false, filePath: target }
      }
    }, target)
    await run()
    await page
      .getByText(uiName(`Exported ${t.formattedEngine}-${name}.pdf.`))
      .waitFor()
    const options = await app.evaluate(() => globalThis.pdfSaveOptions)
    assert.equal(options.defaultPath, join(notes, 'garden.pdf'))
    assert.deepEqual(options.filters, [{ name: 'PDF', extensions: ['pdf'] }])
    const html = await app.evaluate(() => globalThis.pdfHtml)
    assertLightDiagram(html)
    for (const flavor of ['typst', 'math', 'subtext', 'alert', 'footnote'])
      assert.match(html, new RegExp(`<h1[^>]*>Outside ${flavor}</h1>`))
    assert.deepEqual(
      await page.evaluate((html) => {
        const document = new DOMParser().parseFromString(html, 'text/html')
        return [...document.querySelectorAll('h1')]
          .filter(
            (heading) =>
              heading.textContent.startsWith('Outside ') &&
              heading.closest('blockquote, li'),
          )
          .map((heading) => heading.textContent)
      }, html),
      [],
    )
    const result = await pdfText(target)
    assert.ok(result.pages > 0)
    for (const expected of [
      'Quarterly garden plan',
      'Tomatoes',
      'Basil',
      'Remember to water the seedlings.',
      'Folded harvest tip',
      'Pick basil before it flowers.',
      'const answer = 42',
      'Order compost',
      'Plant garlic',
      'Loam drains well.',
    ])
      assert.ok(result.text.includes(expected), `${expected} in ${name} PDF`)
    for (const raw of [
      '$$',
      '\\bar',
      '\\frac',
      'graph TD',
      '-->',
      'title:',
      '[!NOTE]',
    ])
      assert.ok(!result.text.includes(raw), `no raw ${raw} in ${name} PDF`)
    // Math and the diagram are typeset, and the local image is embedded.
    for (const rendered of ['Seed', 'Sprout', 'iπ', '∑'])
      assert.ok(result.text.includes(rendered), `${rendered} in ${name} PDF`)
    assert.ok(result.images >= 1, `${result.images} images in ${name} PDF`)
    // A folded callout prints its body, which the page cannot open.
    assert.match(
      html,
      /<details class="github-alert" data-alert="tip" data-fold="-"><summary class="github-alert-title">Folded harvest tip<\/summary>/,
    )
    assert.ok(
      html.includes('alt="Typst block preview"'),
      'Typst rendered in dark mode',
    )
    assert.equal(await printWindows(app), 0)
    assert.equal(
      await app.evaluate(({ session }) =>
        session
          .fromPartition('hibi-print')
          .protocol.isProtocolHandled('hibi-print'),
      ),
      false,
    )
  }

  await exportTo('palette', async () => {
    await pressShortcut(
      app,
      process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
    )
    const palette = page.getByRole('dialog', { name: /command palette/i })
    await palette.getByRole('combobox').fill('pdf')
    await palette
      .getByRole('option')
      .filter({ has: page.getByText(uiName('Export as PDF…', true)) })
      .first()
      .click()
  })
  // A source-first note may already have this view selected.
  const sourceView = page.getByRole('button', { name: /^source view$/i })
  if ((await sourceView.getAttribute('aria-pressed')) !== 'true')
    await sourceView.click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const edited = `${note}\n\nUnsaved source content`
  await replaceSourceText(
    page,
    page.getByRole('textbox', { name: 'Markdown editor' }),
    edited,
  )
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    edited,
  )
  await exportTo('menu', () => clickMenu(app, 'Export as PDF…'))
  assert.ok(
    (
      await pdfText(join(output, `${t.formattedEngine}-menu.pdf`))
    ).text.includes('Unsaved source content'),
    'accepted unsaved source edits are included in the PDF',
  )
  assert.equal(await readFile(file, 'utf8'), note)
  assert.equal(
    await page.evaluate(async () =>
      window.hibi.readPdfImage(
        'private.png',
        (await window.hibi.getDocument()).revision,
      ),
    ),
    null,
  )
  const diagramFile = join(notes, 'diagram.mmd')
  await writeFile(diagramFile, 'graph TD\n  Seed --> Sprout')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, diagramFile)
  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'diagram.mmd',
  )
  const diagramPdf = join(output, `${t.formattedEngine}-diagram.pdf`)
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
  }, diagramPdf)
  await clickMenu(app, 'Export as PDF…')
  await page
    .getByText(uiName(`Exported ${t.formattedEngine}-diagram.pdf.`))
    .waitFor()
  assertLightDiagram(await app.evaluate(() => globalThis.pdfHtml))
  assert.ok((await pdfText(diagramPdf)).text.includes('Sprout'))
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    ),
    'dark',
  )
  const preferences = await app.evaluate(() => globalThis.pdfPreferences)
  assert.equal(preferences.length, 4)
  for (const settings of preferences)
    assert.deepEqual(settings, {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
    })
  assert.equal(
    await app.evaluate(
      ({ webContents }) =>
        webContents
          .getAllWebContents()
          .filter((contents) => contents.getURL().startsWith('hibi-print:'))
          .length,
    ),
    0,
  )
  assert.deepEqual(errors, [])
})
