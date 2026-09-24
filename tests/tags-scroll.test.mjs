import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('tags do not scan whole Markdown source when source editor scrolls', {
  timeout: 45000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-tags-scroll-'))
  const root = join(temp, 'notes')
  await mkdir(root)
  const markdown = [
    '# note',
    '',
    'top #top',
    ...Array.from({ length: 2000 }, (_, index) => `ordinary line ${index}`),
    'last #last',
  ].join('\n')
  await writeFile(join(root, 'large.md'), markdown)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
  })
  t.after(async () => {
    await page?.evaluate(() => window.restoreTagPerf?.()).catch(() => {})
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(6500)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await waitForAsync(page, async () =>
    (await window.hibi.getAddonStates()).some(
      (addon) => addon.id === 'tags' && addon.enabled,
    ),
  )
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, root)
  await pressShortcut(app, `${mod}+Shift+o`)
  await page
    .getByRole('tree', { name: /workspace files/i })
    .getByRole('treeitem', { name: /^large\.md$/i, exact: true })
    .click()
  await page
    .getByRole('textbox', { name: /document editor/i })
    .locator('.hibi-tag[data-tag="top"]')
    .waitFor()
  await pressShortcut(app, `${mod}+Shift+]`)
  await page
    .locator(
      '.editor-panes.mode-markdown[data-source-ready="true"] .cm-content[contenteditable="true"]',
    )
    .waitFor()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.locator('.hibi-tag[data-tag="top"]').waitFor()
  await page.evaluate((length) => {
    const originalMatchAll = String.prototype.matchAll
    const originalPostMessage = Worker.prototype.postMessage
    window.tagPerf = { scans: 0, posts: 0 }
    String.prototype.matchAll = function (pattern) {
      if (
        pattern instanceof RegExp &&
        pattern.source.includes('#(') &&
        this.length >= length / 2
      )
        window.tagPerf.scans++
      return originalMatchAll.call(this, pattern)
    }
    Worker.prototype.postMessage = function (data, ...rest) {
      if (typeof data?.key === 'string' && typeof data?.source === 'string')
        window.tagPerf.posts++
      return originalPostMessage.call(this, data, ...rest)
    }
    window.restoreTagPerf = () => {
      String.prototype.matchAll = originalMatchAll
      Worker.prototype.postMessage = originalPostMessage
    }
  }, markdown.length)
  await source.click()
  await page.keyboard.type('x')
  await page.waitForFunction(() => window.tagPerf.posts >= 1)
  await page.evaluate(() => {
    window.tagPerf.scans = 0
    window.tagPerf.posts = 0
    const scroller = document.querySelector('.cm-scroller')
    scroller.scrollTop = scroller.scrollHeight
  })
  await source.locator('.hibi-tag[data-tag="last"]').waitFor()
  assert.deepEqual(await page.evaluate(() => window.tagPerf), {
    scans: 0,
    posts: 0,
  })
  assert.deepEqual(errors, [])
  await page.evaluate(() => window.restoreTagPerf())
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
})
