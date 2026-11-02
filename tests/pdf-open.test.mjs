import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

const mib = 1024 * 1024

// A one-page PDF whose Helvetica is not embedded, so its text needs the
// standard font data to draw.
function helveticaPdf() {
  const text = 'BT /F1 72 Tf 72 600 Td (Hibi) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, index) => {
    offsets.push(out.length)
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets)
    out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

async function start(t, prefix) {
  const temp = await mkdtemp(join(tmpdir(), prefix))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  await waitForDocumentEditor(app, page)
  const open = async (file) => {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await clickMenu(app, 'Open…')
  }
  // Chromium prints real PDFs, so no fixture files are needed.
  const print = async (pages) =>
    Buffer.from(
      await app.evaluate(async ({ BrowserWindow }, pages) => {
        const window = new BrowserWindow({ show: false })
        const body = Array.from(
          { length: pages },
          (_, index) =>
            `<div style="page-break-after:always;font:64px sans-serif">Page ${index + 1}<div style="width:300px;height:200px;background:#336"></div></div>`,
        ).join('')
        await window.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(body)}`,
        )
        const bytes = await window.webContents.printToPDF({
          printBackground: true,
        })
        window.destroy()
        return bytes.toString('base64')
      }, pages),
      'base64',
    )
  const canvases = () => page.locator('.pdf-page canvas').count()
  // The share of each drawn page that is not white, so a blank page fails.
  const ink = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.pdf-page canvas')].map((canvas) => {
        const small = document.createElement('canvas')
        small.width = 60
        small.height = 80
        const context = small.getContext('2d')
        context.fillStyle = '#fff'
        context.fillRect(0, 0, 60, 80)
        context.drawImage(canvas, 0, 0, 60, 80)
        const data = context.getImageData(0, 0, 60, 80).data
        let dark = 0
        for (let index = 0; index < data.length; index += 4)
          if (data[index] < 235 || data[index + 1] < 235) dark++
        return dark / 4800
      }),
    )
  return { temp, page, open, print, canvases, ink }
}

const tabs = (page) =>
  page.evaluate(async () =>
    (await window.hibi.getDocument()).tabs.map((tab) => tab.name),
  )

test('a PDF opens in the viewer, navigates, zooms, and stays unchanged on save', {
  timeout: 90000,
}, async (t) => {
  const { temp, page, open, print, canvases, ink } = await start(
    t,
    'hibi-pdf-open-',
  )
  const file = join(temp, 'three.pdf')
  const bytes = await print(3)
  await writeFile(file, bytes)

  await open(file)
  await page.locator('.pdf-page canvas').first().waitFor()
  assert.equal(await page.locator('.cm-content').count(), 0)
  const shares = await ink()
  assert.ok(
    shares.some((share) => share > 0.01),
    `a page has ink: ${shares}`,
  )
  const toolbar = page.locator('.preview-toolbar')
  await toolbar.getByText('of 3').waitFor()

  const input = page.getByRole('textbox', { name: 'Page number' })
  const width = () =>
    page
      .locator('.pdf-page')
      .first()
      .evaluate((slot) => slot.getBoundingClientRect().width)
  assert.equal(await input.inputValue(), '1')
  await page.getByRole('button', { name: 'Next page', exact: true }).click()
  await page.waitForFunction(
    () =>
      document.querySelector('input[aria-label="Page number"]')?.value === '2',
  )

  const fit = await width()
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.waitForFunction(
    (before) =>
      document.querySelector('.pdf-page').getBoundingClientRect().width >
      before,
    fit,
  )
  assert.ok((await width()) > fit)
  await page.getByRole('button', { name: 'Fit width', exact: true }).click()
  await page.waitForFunction(
    (before) =>
      Math.abs(
        document.querySelector('.pdf-page').getBoundingClientRect().width -
          before,
      ) <= 1,
    fit,
  )
  assert.ok((await canvases()) >= 1)

  // Saving never writes to a PDF.
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.deepEqual(await readFile(file), bytes)
})

test('text in fonts the file does not embed is drawn from the shipped font data', {
  timeout: 60000,
}, async (t) => {
  const { temp, page, open, ink } = await start(t, 'hibi-pdf-fonts-')
  const warnings = []
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text())
  })
  const file = join(temp, 'helvetica.pdf')
  await writeFile(file, helveticaPdf())
  await open(file)
  await page.locator('.pdf-page canvas').first().waitFor()
  await page.waitForFunction(
    () => document.querySelector('.pdf-page canvas') !== null,
  )
  await page.waitForTimeout(1500)
  assert.ok(
    (await ink()).some((share) => share > 0.005),
    'the text is drawn',
  )
  // pdf.js warns when it falls back to a substitute font.
  assert.deepEqual(
    warnings.filter((text) => /standardFontDataUrl/.test(text)),
    [],
  )
})

test('the decoders and standard fonts ship with the app', {
  timeout: 60000,
}, async (t) => {
  const { page } = await start(t, 'hibi-pdf-assets-')
  const status = (path) =>
    page.evaluate(async (path) => (await fetch(path)).status, path)
  for (const path of [
    '/pdfjs/wasm/openjpeg_nowasm_fallback.js',
    '/pdfjs/wasm/jbig2_nowasm_fallback.js',
    '/pdfjs/standard_fonts/FoxitSerif.pfb',
    '/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
  ])
    assert.equal(await status(path), 200, path)
})

test('a long PDF keeps few canvases and still reaches its last page', {
  timeout: 150000,
}, async (t) => {
  const { temp, page, open, print, canvases } = await start(t, 'hibi-pdf-long-')
  const file = join(temp, 'long.pdf')
  await writeFile(file, await print(300))
  await open(file)
  await page.locator('.pdf-page canvas').first().waitFor()
  await page.waitForFunction(
    () => document.querySelectorAll('.pdf-page').length === 300,
  )
  await page.waitForTimeout(1500)
  assert.ok((await canvases()) <= 10, 'few canvases at the top')

  const input = page.getByRole('textbox', { name: 'Page number' })
  await input.fill('300')
  await input.press('Enter')
  await page.locator('.pdf-page[data-page="300"] canvas').waitFor()
  await page.waitForTimeout(1500)
  assert.ok((await canvases()) <= 10, 'few canvases after the jump')
  assert.equal(await page.locator('.pdf-page[data-page="1"] canvas').count(), 0)
})

test('damaged PDFs show a message instead of pages', {
  timeout: 90000,
}, async (t) => {
  const { temp, page, open, print } = await start(t, 'hibi-pdf-broken-')
  const good = join(temp, 'good.pdf')
  await writeFile(good, await print(1))
  const broken = {
    'text.pdf': Buffer.from('this is text, not a document'),
    'truncated.pdf': Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog'),
  }
  const status = page
    .getByRole('status')
    .filter({ hasText: 'Unable to display PDF' })
  for (const [name, bytes] of Object.entries(broken)) {
    await writeFile(join(temp, name), bytes)
    // A valid PDF first, so the message can only come from the next file.
    await open(good)
    await page.locator('.pdf-page canvas').first().waitFor()
    await open(join(temp, name))
    await status.waitFor()
    assert.match(
      await status.textContent(),
      /missing, damaged, password-protected/,
      name,
    )
    assert.equal(await page.locator('.pdf-page canvas').count(), 0, name)
  }
})

test('oversized, folder and unsupported files are refused clearly', {
  timeout: 90000,
}, async (t) => {
  const { temp, page, open } = await start(t, 'hibi-pdf-refused-')
  const toasts = () => page.locator('.toast').allTextContents()

  const big = join(temp, 'big.pdf')
  await writeFile(big, '%PDF-1.4\n')
  await truncate(big, 64 * mib + 1)
  await open(big)
  await page.locator('.toast').filter({ hasText: 'big.pdf' }).first().waitFor()
  assert.match(
    (await toasts()).join('\n'),
    /big\.pdf is larger than 64 MiB, so Hibi can’t display it\./,
  )
  assert.equal((await tabs(page)).includes('big.pdf'), false)

  await mkdir(join(temp, 'x.pdf'))
  await open(join(temp, 'x.pdf'))
  await page
    .locator('.toast')
    .filter({ hasText: 'Choose a PDF file, not a folder or device.' })
    .first()
    .waitFor()
  assert.equal((await tabs(page)).includes('x.pdf'), false)

  await writeFile(join(temp, 'scan.bmp'), Buffer.from([0x42, 0x4d, 0xff, 0xfe]))
  await open(join(temp, 'scan.bmp'))
  await page.locator('.toast').filter({ hasText: 'scan.bmp' }).first().waitFor()
  assert.match((await toasts()).join('\n'), /Hibi can’t open scan\.bmp/)
})
