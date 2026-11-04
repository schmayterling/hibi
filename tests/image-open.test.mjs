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
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
const gif = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
)
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>',
)

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
  page.setDefaultTimeout(10000)
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
  return { temp, page, open }
}

test('images open in the viewer, stay unchanged on save, and explain failures', {
  timeout: 60000,
}, async (t) => {
  const { temp, page, open } = await start(t, 'hibi-image-open-')
  const photo = join(temp, 'photo.png')
  const fake = join(temp, 'fake.png')
  const bitmap = join(temp, 'scan.bmp')
  await writeFile(photo, png)
  await writeFile(fake, 'this is text, not a picture')
  await writeFile(bitmap, Buffer.from([0x42, 0x4d, 0xff, 0xfe, 0x80, 0x81]))

  await open(photo)
  const image = page.locator('.image-viewer img.image-preview')
  await image.waitFor()
  assert.match(await image.getAttribute('src'), /^data:image\/png;base64,/)
  assert.equal(await image.getAttribute('alt'), 'photo.png')
  assert.equal(await page.locator('.cm-content').count(), 0)

  // Saving never writes to an image.
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.deepEqual(await readFile(photo), png)

  // An image the viewer cannot decode shows its own message.
  await open(fake)
  await page
    .getByRole('status')
    .filter({ hasText: 'Unable to display image' })
    .waitFor()
  assert.equal(await page.locator('.image-viewer img').count(), 0)

  // A binary file that is not an image gets a clear error, not a decoder one.
  await open(bitmap)
  const toast = page.locator('.toast').filter({ hasText: 'scan.bmp' }).first()
  await toast.waitFor()
  const text = (await page.locator('.toast').allTextContents()).join('\n')
  assert.match(text, /Hibi can’t open scan\.bmp/)
  assert.doesNotMatch(text, /TypeError|encoded data|remote method/)
})

test('every supported image type decodes in the viewer', {
  timeout: 90000,
}, async (t) => {
  const { temp, page, open } = await start(t, 'hibi-image-types-')
  // Chromium encodes the JPEG and WebP, so both are real files it can decode.
  const encode = async (type) => {
    const url = await page.evaluate((type) => {
      const canvas = document.createElement('canvas')
      canvas.width = 8
      canvas.height = 6
      const context = canvas.getContext('2d')
      context.fillStyle = '#c33'
      context.fillRect(0, 0, 8, 6)
      return canvas.toDataURL(type)
    }, type)
    assert.ok(url.startsWith(`data:${type};base64,`), `${type} encoder`)
    return Buffer.from(url.split(',')[1], 'base64')
  }
  const jpeg = await encode('image/jpeg')
  const webp = await encode('image/webp')
  // A valid PNG padded to exactly the 8 MiB limit still opens.
  const edge = Buffer.concat([png, Buffer.alloc(8 * mib - png.length)])
  const cases = [
    ['photo.png', png, 'image/png'],
    ['photo.jpg', jpeg, 'image/jpeg'],
    ['photo.jpeg', jpeg, 'image/jpeg'],
    ['photo.webp', webp, 'image/webp'],
    ['photo.gif', gif, 'image/gif'],
    ['photo.svg', svg, 'image/svg+xml'],
    ['UPPER.PNG', png, 'image/png'],
    ['edge.png', edge, 'image/png'],
  ]
  for (const [name, bytes, mime] of cases) {
    const file = join(temp, name)
    await writeFile(file, bytes)
    await open(file)
    const shown = page.locator(`.image-viewer img.image-preview[alt="${name}"]`)
    await shown.waitFor()
    assert.ok(
      (await shown.getAttribute('src')).startsWith(`data:${mime};`),
      name,
    )
    const width = await shown.evaluate(async (img) => {
      await img.decode()
      return img.naturalWidth
    })
    assert.ok(width > 0, `${name} decoded`)
    assert.equal(await page.locator('.cm-content').count(), 0, name)
  }
})

test('broken, empty, oversized and unsupported images fail visibly', {
  timeout: 90000,
}, async (t) => {
  const { temp, page, open } = await start(t, 'hibi-image-broken-')
  const photo = join(temp, 'photo.png')
  await writeFile(photo, png)
  const broken = {
    'text.png': Buffer.from('this is text, not a picture'),
    'truncated.png': png.subarray(0, 20),
    'garbage.jpg': Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from('not really a jpeg'),
    ]),
    'unclosed.svg': Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect',
    ),
    'empty.gif': Buffer.alloc(0),
  }
  const status = page
    .locator('.image-viewer')
    .getByRole('status')
    .filter({ hasText: 'Unable to display image' })
  for (const [name, bytes] of Object.entries(broken)) {
    await writeFile(join(temp, name), bytes)
    // A valid image first, so the message can only come from the next file.
    await open(photo)
    await page
      .locator('.image-viewer img.image-preview[alt="photo.png"]')
      .waitFor()
    await open(join(temp, name))
    await status.waitFor()
    assert.equal(await status.isVisible(), true, name)
    assert.match(await status.textContent(), /not a supported image/, name)
    assert.equal(await page.locator('.image-viewer img').count(), 0, name)
  }

  const toasts = () => page.locator('.toast').allTextContents()
  const tabs = () =>
    page.evaluate(async () =>
      (await window.hibi.getDocument()).tabs.map((tab) => tab.name),
    )

  // Past the limit, the file is refused up front and no tab opens.
  const big = join(temp, 'big.png')
  await writeFile(big, png)
  await truncate(big, 8 * mib + 1)
  await open(big)
  await page.locator('.toast').filter({ hasText: 'big.png' }).first().waitFor()
  assert.match(
    (await toasts()).join('\n'),
    /big\.png is larger than 8 MiB, so Hibi can’t display it\./,
  )
  assert.equal((await tabs()).includes('big.png'), false)

  // A folder with an image name is not an image.
  await mkdir(join(temp, 'folder.png'))
  await open(join(temp, 'folder.png'))
  await page
    .locator('.toast')
    .filter({ hasText: 'Choose an image file, not a folder or device.' })
    .first()
    .waitFor()
  assert.equal((await tabs()).includes('folder.png'), false)

  // An unsupported binary still gets the clear error, not a decoder message.
  await writeFile(join(temp, 'scan.bmp'), Buffer.from([0x42, 0x4d, 0xff, 0xfe]))
  await open(join(temp, 'scan.bmp'))
  await page.locator('.toast').filter({ hasText: 'scan.bmp' }).first().waitFor()
  const text = (await toasts()).join('\n')
  assert.match(text, /Hibi can’t open scan\.bmp/)
  assert.doesNotMatch(text, /TypeError|encoded data|remote method/)
})
