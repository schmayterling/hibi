import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
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

// An encrypted PDF (standard security handler, RC4 40-bit) that opens with `password`.
function encryptedPdf(password) {
  const pad = Buffer.from(
    '28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A',
    'hex',
  )
  const md5 = (data) => createHash('md5').update(data).digest()
  const rc4 = (key, data) => {
    const state = Array.from({ length: 256 }, (_, index) => index)
    let j = 0
    for (let i = 0; i < 256; i++) {
      j = (j + state[i] + key[i % key.length]) & 255
      ;[state[i], state[j]] = [state[j], state[i]]
    }
    const result = Buffer.alloc(data.length)
    let a = 0
    let b = 0
    for (let k = 0; k < data.length; k++) {
      a = (a + 1) & 255
      b = (b + state[a]) & 255
      ;[state[a], state[b]] = [state[b], state[a]]
      result[k] = data[k] ^ state[(state[a] + state[b]) & 255]
    }
    return result
  }
  const padded = (value) =>
    Buffer.concat([Buffer.from(value, 'latin1'), pad]).subarray(0, 32)
  const permissions = Buffer.alloc(4)
  permissions.writeInt32LE(-4)
  const id = randomBytes(16)
  const owner = rc4(
    md5(padded('owner-secret')).subarray(0, 5),
    padded(password),
  )
  const key = md5(
    Buffer.concat([padded(password), owner, permissions, id]),
  ).subarray(0, 5)
  const user = rc4(key, pad)
  const objectKey = md5(
    Buffer.concat([key, Buffer.from([5, 0, 0, 0, 0])]),
  ).subarray(0, 10)
  const text = 'BT /F1 48 Tf 72 700 Td (Unlocked) Tj ET'
  const content = rc4(objectKey, Buffer.from(text, 'latin1'))
  const hex = (buffer) => buffer.toString('hex')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'latin1'),
      content,
      Buffer.from('\nendstream', 'latin1'),
    ]),
    `<< /Filter /Standard /V 1 /R 2 /O <${hex(owner)}> /U <${hex(user)}> /P -4 >>`,
  ]
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')]
  const offsets = []
  let length = parts[0].length
  objects.forEach((body, index) => {
    offsets.push(length)
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
      Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'),
      Buffer.from('\nendobj\n', 'latin1'),
    ])
    parts.push(chunk)
    length += chunk.length
  })
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets)
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 6 0 R /ID [<${hex(id)}> <${hex(id)}>] >>\nstartxref\n${length}\n%%EOF\n`
  parts.push(Buffer.from(xref, 'latin1'))
  return Buffer.concat(parts)
}

// Chinese, Japanese and Korean lines in fonts that are not embedded, so each
// needs a predefined CMap, plus a Latin line.
function cjkPdf() {
  const utf16 = (value) =>
    Buffer.from(value, 'utf16le').swap16().toString('hex').toUpperCase()
  const descriptor = (name) =>
    `<< /Type /FontDescriptor /FontName /${name} /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>`
  const type0 = (name, cmap, ordering, supplement, ref) =>
    `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /${cmap} /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (${ordering}) /Supplement ${supplement} >> /FontDescriptor ${ref} 0 R /DW 1000 >>] >>`
  const text = [
    'BT /F1 28 Tf 72 700 Td (Latin line) Tj ET',
    `BT /F2 28 Tf 72 640 Td <${utf16('你好，世界')}> Tj ET`,
    `BT /F3 28 Tf 72 590 Td <${utf16('こんにちは世界')}> Tj ET`,
    `BT /F4 28 Tf 72 540 Td <${utf16('안녕하세요 세계')}> Tj ET`,
  ].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 6 0 R /F3 7 0 R /F4 8 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    type0('STSong-Light', 'UniGB-UCS2-H', 'GB1', 4, 9),
    type0('HeiseiMin-W3', 'UniJIS-UCS2-H', 'Japan1', 4, 10),
    type0('HYSMyeongJo-Medium', 'UniKS-UCS2-H', 'Korea1', 1, 11),
    descriptor('STSong-Light'),
    descriptor('HeiseiMin-W3'),
    descriptor('HYSMyeongJo-Medium'),
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
    '/pdfjs/cmaps/UniGB-UCS2-H.bcmap',
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

test('a password-protected PDF asks for its password and opens once unlocked', {
  timeout: 90000,
}, async (t) => {
  const { temp, page, open, ink } = await start(t, 'hibi-pdf-locked-')
  const modal = page.locator('dialog[open]')
  const field = modal.getByLabel('Password')
  const unlock = modal.getByRole('button', { name: 'Unlock', exact: true })

  const file = join(temp, 'locked.pdf')
  const bytes = encryptedPdf('hibi')
  await writeFile(file, bytes)
  await open(file)
  await modal.waitFor()
  assert.equal(await field.getAttribute('type'), 'password')
  assert.equal(await page.locator('.pdf-page canvas').count(), 0)

  // A wrong password keeps the prompt and says so.
  await field.fill('wrong')
  await unlock.click()
  await modal.getByText('Incorrect password. Try again.').waitFor()
  assert.equal(await page.locator('.pdf-page canvas').count(), 0)

  await field.fill('hibi')
  await field.press('Enter')
  await page.locator('.pdf-page canvas').first().waitFor()
  await modal.waitFor({ state: 'detached' })
  assert.ok(
    (await ink()).some((share) => share > 0.003),
    'the page is drawn',
  )

  // Saving never writes to a PDF.
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.deepEqual(await readFile(file), bytes)

  // Cancelling leaves a way to try again.
  const second = join(temp, 'locked-again.pdf')
  await writeFile(second, encryptedPdf('hibi'))
  await open(second)
  await modal.waitFor()
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
  const locked = page
    .getByRole('status')
    .filter({ hasText: 'This PDF is password-protected.' })
  await locked.waitFor()
  assert.equal(await page.locator('.pdf-page canvas').count(), 0)
  await locked.getByRole('button', { name: 'Enter password' }).click()
  await modal.waitFor()
  await field.fill('hibi')
  await field.press('Enter')
  await page.locator('.pdf-page canvas').first().waitFor()
  assert.equal(await locked.count(), 0)
})

test('CJK text in fonts the file does not embed loads its character maps', {
  timeout: 60000,
}, async (t) => {
  const { temp, page, open, ink } = await start(t, 'hibi-pdf-cjk-')
  const warnings = []
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text())
  })
  const file = join(temp, 'cjk.pdf')
  await writeFile(file, cjkPdf())
  await open(file)
  await page.locator('.pdf-page canvas').first().waitFor()
  await page.waitForTimeout(2000)
  assert.deepEqual(
    warnings.filter((text) => /cMapUrl|translateFont failed/.test(text)),
    [],
  )
  // The Latin line draws whether or not this machine has CJK fonts.
  assert.ok(
    (await ink()).some((share) => share > 0.003),
    'text is drawn',
  )
})
