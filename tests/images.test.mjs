import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  documentMediaPath,
  imageSources,
  readDocumentImage,
  resolveDocumentMediaPath,
} from '../src/main/images.ts'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
  'base64',
)

test('website-root image paths fall back to workspace assets without replacing absolute-file behavior', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-root-images-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'uploads'))
  await mkdir(join(root, 'notes'))
  const image = join(root, 'uploads', 'shot with spaces.png'),
    note = join(root, 'notes', 'note.md')
  await writeFile(image, png)
  const source = '/uploads/shot%20with%20spaces.png'
  assert.equal(await resolveDocumentMediaPath(source, note, root), image)
  assert.equal(
    await readDocumentImage(source, note, root),
    `data:image/png;base64,${png.toString('base64')}`,
  )
  assert.equal(await readDocumentImage(source, note), null)
  assert.equal(
    await readDocumentImage(source, join(root, 'note.md')),
    `data:image/png;base64,${png.toString('base64')}`,
  )
  assert.equal(await resolveDocumentMediaPath(image, note, root), image)
  assert.equal(
    await resolveDocumentMediaPath(pathToFileURL(image).href, note, root),
    image,
  )
  assert.equal(
    await resolveDocumentMediaPath('/../outside.png', note, root),
    null,
  )
  assert.equal(documentMediaPath('%2F%2Fserver/image.png', note), null)
  assert.equal(documentMediaPath('assets/%00.png', note), null)
  await mkdir(join(root, 'public', 'uploads'), { recursive: true })
  const publicImage = join(root, 'public', 'uploads', 'site.png')
  await writeFile(publicImage, png)
  assert.equal(
    await resolveDocumentMediaPath('/uploads/site.png', note, root),
    publicImage,
  )
})

test('local images resolve from the note, validate content, and retain their Markdown paths', {
  timeout: 30000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-images-'))
  const assets = join(folder, 'assets')
  await mkdir(assets)
  const image = join(assets, 'my image.png')
  await writeFile(image, png)
  await writeFile(join(assets, 'fake.png'), 'private text is not image data')
  const first = join(folder, 'first.md')
  const original = `![relative](assets/my%20image.png)\n\n![absolute](<${image}>)\n\n![file](${pathToFileURL(image).href})\n\n![root](/assets/my%20image.png)\n\nbody`
  await writeFile(first, original)
  assert.equal(imageSources(original).size, 4)
  for (const source of imageSources(original)) {
    assert.equal(
      await readDocumentImage(source, first),
      `data:image/png;base64,${png.toString('base64')}`,
    )
  }
  assert.equal(await readDocumentImage('assets/my%20image.png', null), null)
  assert.equal(await readDocumentImage('assets/fake.png', first), null)
  assert.equal(
    await readDocumentImage('https://example.com/image.png', first),
    null,
  )
  assert.equal(await readDocumentImage('missing.png', first), null)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, first) => {
    dialog.showOpenDialog = async () => {
      await new Promise((resolve) => setTimeout(resolve, 180))
      return { canceled: false, filePaths: [first] }
    }
  }, first)
  const page = await app.firstWindow()
  page.setDefaultTimeout(6500)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  const [toolbar] = await Promise.all([
    page.evaluate(async () => {
      const header = document.querySelector('.titlebar')
      const button = header.querySelector('.sidebar-toggle')
      const frames = []
      const start = performance.now()
      while (performance.now() - start < 450) {
        await new Promise(requestAnimationFrame)
        frames.push({
          same: header === document.querySelector('.titlebar'),
          opacity: getComputedStyle(button).opacity,
          busy: header.getAttribute('aria-busy'),
        })
      }
      return frames
    }),
    clickMenu(app, 'Open…'),
  ])
  assert.ok(toolbar.some((frame) => frame.busy === 'true'))
  assert.ok(
    toolbar.every((frame) => frame.same && frame.opacity === '1'),
    JSON.stringify(toolbar),
  )
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.tiptap img')].length === 4 &&
      [...document.querySelectorAll('.tiptap img')].every(
        (image) => image.complete && image.naturalWidth === 1,
      ),
  )
  const revision = (await page.evaluate(() => window.hibi.getDocument()))
    .revision
  assert.equal(
    await page.evaluate(
      (revision) => window.hibi.readDocumentImage('/etc/passwd', revision),
      revision,
    ),
    null,
  )
  assert.equal(
    await page.evaluate(
      (revision) =>
        window.hibi.readDocumentImage('assets/my%20image.png', revision - 1),
      revision,
    ),
    null,
  )
  await page.locator('.tiptap p').last().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' edited')
  const markdown = (await page.evaluate(() => window.hibi.getDocument()))
    .markdown
  assert.ok(markdown.includes('assets/my%20image.png'))
  assert.ok(markdown.includes(image))
  assert.ok(!markdown.includes('data:image'))
  await mkdir(join(folder, 'nested'))
  await writeFile(
    join(folder, 'nested', 'page.md'),
    '![root](/assets/my%20image.png)',
  )
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [`${folder}/nested/page.md`],
    })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, folder)
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+o`,
  )
  await page
    .locator('.tiptap img[title^="media unavailable"]')
    .waitFor({ state: 'attached' })
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    })
  }, folder)
  const snapshot = await page.evaluate(async () => {
    await window.hibi.openWorkspace()
    return window.hibi.getWorkspaceSnapshot()
  })
  await page.waitForFunction(() => {
    const image = document.querySelector('.tiptap img')
    return image?.complete && image.naturalWidth === 1
  })
  assert.equal(
    snapshot.pages.find((page) => page.path === 'nested/page.md').images[
      '/assets/my%20image.png'
    ],
    `data:image/png;base64,${png.toString('base64')}`,
  )
})
