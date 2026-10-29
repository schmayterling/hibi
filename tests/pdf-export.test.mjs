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
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'
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

[^soil]: Loam drains well.
`

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
  timeout: 90000,
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
  await writeFile(join(profile, 'addons.json'), JSON.stringify({ math: true }))
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
  await page.waitForFunction(() =>
    ['math', 'mermaid', 'markdown'].every(
      (id) => performance.getEntriesByName(`hibi:addon:${id}`).length,
    ),
  )
  await app.evaluate(({ dialog }, file) => {
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
    const result = await pdfText(target)
    assert.ok(result.pages > 0)
    for (const expected of [
      'Quarterly garden plan',
      'Tomatoes',
      'Basil',
      'Remember to water the seedlings.',
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
  // The source view exports the rendered note, not the editor.
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
  )
  const palette = page.getByRole('dialog', { name: /command palette/i })
  await palette.getByRole('combobox').fill('source view')
  await palette
    .getByRole('option')
    .filter({ has: page.getByText(uiName('Source view', true)) })
    .first()
    .click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await exportTo('menu', () => clickMenu(app, 'Export as PDF…'))
  assert.deepEqual(errors, [])
})
