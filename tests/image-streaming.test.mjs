import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut, replaceSourceText } from './keyboard.mjs'

const gif = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
)
const svg = (
  width,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="16"
onload="document.documentElement.setAttribute('data-executed', 'onload')">
<script>document.documentElement.setAttribute('data-executed', 'script')</script>
<rect width="100%" height="100%" fill="red"/></svg>`

test('large local images stream; external changes refresh one image and svg remains inert', {
  timeout: 45000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-image-streaming-'))
  const workspace = join(root, 'notes')
  await mkdir(join(workspace, 'assets'), { recursive: true })
  await writeFile(
    join(workspace, 'assets', 'large.gif'),
    Buffer.concat([gif, Buffer.alloc(9 * 1024 * 1024)]),
  )
  await writeFile(join(workspace, 'assets', 'active.svg'), svg(16))
  await writeFile(join(workspace, 'assets', 'stable.gif'), gif)
  await writeFile(
    join(workspace, 'note.md'),
    '![large](assets/large.gif)\n\n![active](assets/active.svg)\n\n![stable](assets/stable.gif)',
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [workspace],
    })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, workspace)
  await page.getByRole('button', { name: /toggle workspace sidebar/i }).click()
  await page
    .getByRole('button', { name: /^open workspace$/i, exact: true })
    .click()
  await page.getByRole('treeitem', { name: /^note\.md$/i, exact: true }).click()
  const images = page.locator('.tiptap img')
  await images.first().waitFor()
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.tiptap img')].length === 3 &&
      [...document.querySelectorAll('.tiptap img')].every(
        (img) => img.complete && img.naturalWidth > 0,
      ),
  )
  const urls = await images.evaluateAll((items) =>
    items.map((image) => image.src),
  )
  for (const url of urls) assert.match(url, /^app:\/\/hibi\/document-media\//)
  assert.deepEqual(
    await images.evaluateAll((items) =>
      items.map((image) => [image.loading, image.decoding]),
    ),
    Array.from({ length: 3 }, () => ['lazy', 'async']),
  )
  const oldBridge = await page.evaluate(async () => {
    const { revision } = await window.hibi.getDocument()
    return {
      small: await window.hibi.readDocumentImage('assets/stable.gif', revision),
      large: await window.hibi.readDocumentImage('assets/large.gif', revision),
    }
  })
  assert.match(oldBridge.small, /^data:image\/gif;base64,/)
  assert.equal(oldBridge.large, null)
  const headers = await page.evaluate(async (url) => {
    const response = await fetch(url)
    return Object.fromEntries(response.headers)
  }, urls[1])
  assert.equal(headers['content-type'], 'image/svg+xml')
  assert.match(
    headers['content-security-policy'],
    /sandbox; default-src 'none'/,
  )
  assert.equal(headers['x-content-type-options'], 'nosniff')
  // Even a direct SVG document has no script privileges or application origin.
  const nextWindow = app.waitForEvent('window')
  const svgWindow = await app.evaluateHandle(async ({ BrowserWindow }, url) => {
    const window = new BrowserWindow({
      show: false,
      focusable: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    await window.loadURL(url)
    return window
  }, urls[1])
  const svgPage = await nextWindow
  const cdp = await svgPage.context().newCDPSession(svgPage)
  const { root: svgDocument } = await cdp.send('DOM.getDocument')
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: svgDocument.nodeId,
    selector: 'svg',
  })
  const { attributes } = await cdp.send('DOM.getAttributes', { nodeId })
  assert.ok(!attributes.includes('data-executed'))
  await cdp.detach()
  await svgWindow.evaluate((window) => window.destroy())
  await svgWindow.dispose()
  await writeFile(join(workspace, 'assets', 'active.svg'), svg(48))
  await page.waitForFunction((previous) => {
    const image = document.querySelector('.tiptap img[alt="active"]')
    return (
      image?.src !== previous && image?.complete && image.naturalWidth === 48
    )
  }, urls[1])
  const next = await images.evaluateAll((items) =>
    items.map((image) => image.src),
  )
  assert.equal(next[0], urls[0])
  assert.equal(next[2], urls[2])
  assert.equal(
    await page.evaluate(async (url) => (await fetch(url)).status, urls[1]),
    404,
  )
  // A resync must not replace otherwise unchanged display URLs.
  await page.evaluate(() => window.hibi.refreshWorkspace())
  assert.deepEqual(
    await images.evaluateAll((items) => items.map((image) => image.src)),
    next,
  )
  const revision = await page.evaluate(
    async () => (await window.hibi.getDocument()).revision,
  )
  async function changedScope(operation) {
    const previous = await images.evaluateAll((items) =>
      items.map((image) => image.src),
    )
    await operation()
    await page.waitForFunction(
      (previous) =>
        [...document.querySelectorAll('.tiptap img')].length === 3 &&
        [...document.querySelectorAll('.tiptap img')].every(
          (image, index) =>
            image.src !== previous[index] &&
            image.complete &&
            image.naturalWidth > 0,
        ),
      previous,
    )
    assert.equal(
      await page.evaluate(
        async () => (await window.hibi.getDocument()).revision,
      ),
      revision,
    )
  }
  await changedScope(() =>
    page.evaluate(() => window.hibi.renameDocument('renamed.md')),
  )
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    },
    join(workspace, 'saved-as.md'),
  )
  await changedScope(() => page.evaluate(() => window.hibi.saveDocument(true)))
  await mkdir(join(workspace, 'folder', 'assets'), { recursive: true })
  for (const name of ['large.gif', 'active.svg', 'stable.gif'])
    await link(
      join(workspace, 'assets', name),
      join(workspace, 'folder', 'assets', name),
    )
  await changedScope(() =>
    page.evaluate(() =>
      window.hibi.workspaceAction({
        action: 'move',
        path: 'saved-as.md',
        destination: 'folder/saved-as.md',
      }),
    ),
  )

  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, mod + '+n')
  await pressShortcut(app, mod + '+Shift+]')
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.waitFor()
  await replaceSourceText(page, source, '![first save](assets/stable.gif)')
  await pressShortcut(app, mod + '+Shift+[')
  await page
    .locator('.tiptap img[alt="first save"]')
    .waitFor({ state: 'attached' })
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    },
    join(workspace, 'first-save.md'),
  )
  await page.evaluate(() => window.hibi.saveDocument(false))
  await page.waitForFunction(() => {
    const image = document.querySelector('.tiptap img[alt="first save"]')
    return image?.complete && image.naturalWidth === 1
  })
  assert.equal(
    await page.evaluate(async (url) => (await fetch(url)).status, next[1]),
    404,
  )
})
