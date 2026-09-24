import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut, replaceRichText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('modified link clicks, note/settings history, and file-menu remote imports', {
  timeout: 40000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-navigation-'))
  await writeFile(
    join(root, 'a.md'),
    '[next](b.md)\n\n[web](https://example.com/)',
  )
  await writeFile(join(root, 'b.md'), '# second')
  const server = createServer((request, response) => {
    response.setHeader(
      'Content-Type',
      request.url === '/html' ? 'text/html' : 'text/markdown',
    )
    response.end(
      request.url === '/large' ? 'x'.repeat(2097153) : '# remote note',
    )
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}`
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await app.evaluate(
    ({ dialog, shell }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
      dialog.showMessageBox = async () => ({ response: 1 })
      shell.openExternal = async (url) => {
        globalThis.lastExternal = url
      }
    },
    join(root, 'a.md'),
  )
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await waitForDocumentEditor(app, page)
  await pressShortcut(app, `${mod}+o`)
  await rich.getByRole('link', { name: /^next$/i, exact: true }).waitFor()
  await rich
    .getByRole('link', { name: /^web$/i, exact: true })
    .click({ modifiers: ['Shift'] })
  assert.equal(
    await app.evaluate(() => globalThis.lastExternal),
    'https://example.com/',
  )
  await rich.getByRole('link', { name: /^next$/i, exact: true }).click()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).name,
    'a.md',
  )
  const waitName = async (name) => {
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      name,
    )
    await page.waitForFunction(
      () =>
        document.querySelector('.app').getAttribute('aria-busy') === 'false',
    )
  }
  if (process.platform === 'darwin') {
    await rich
      .getByRole('link', { name: /^next$/i, exact: true })
      .click({ modifiers: ['Control', 'Meta'] })
    await waitName('b.md')
    await pressShortcut(app, `${mod}+[`)
    await waitName('a.md')
  }
  await rich
    .getByRole('link', { name: /^next$/i, exact: true })
    .click({ modifiers: ['Shift'] })
  await waitName('b.md')
  await pressShortcut(app, `${mod}+[`)
  await waitName('a.md')
  await pressShortcut(app, `${mod}+]`)
  await waitName('b.md')
  // History switches tabs without discarding the other note's draft.
  await replaceRichText(
    page,
    rich.getByRole('heading', { name: 'second', exact: true }),
    'unsaved second',
  )
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 2 })
  })
  await pressShortcut(app, `${mod}+[`)
  await waitName('a.md')
  await page.getByRole('tab', { name: /^b\.md$/i, exact: true }).click()
  await waitName('b.md')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '# unsaved second',
  )
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  await pressShortcut(app, `${mod}+[`)
  await waitName('a.md')
  await pressShortcut(app, `${mod}+Shift+\\`)
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.waitFor()
  await source.click()
  const point = await source.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const index = node.textContent.indexOf('b.md')
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + 1)
      const box = range.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
  })
  assert.ok(point)
  await page.keyboard.down('Shift')
  await page.mouse.click(point.x, point.y)
  await page.keyboard.up('Shift')
  await waitName('b.md')
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
  await page.getByRole('tab', { name: /^hotkeys$/i, exact: true }).click()
  await pressShortcut(app, `${mod}+[`)
  await page
    .getByRole('tab', { name: /^appearance$/i, exact: true, selected: true })
    .waitFor()
  await pressShortcut(app, `${mod}+]`)
  await page
    .getByRole('tab', { name: /^hotkeys$/i, exact: true, selected: true })
    .waitFor()
  await page.keyboard.press('Escape')
  await page.waitForFunction(
    () => document.querySelector('.app').dataset.screen === 'editor',
  )
  const beforeSettings = (await page.evaluate(() => window.hibi.getDocument()))
    .markdown
  await clickMenu(app, 'Settings')
  const back = page.getByRole('button', { name: /^back to app$/i, exact: true })
  const categoryTab = page.getByRole('tab', { name: /^about$/i, exact: true })
  const backBounds = await back.boundingBox()
  const tabBounds = await categoryTab.boundingBox()
  const scrollbarWidth = await page
    .locator('.settings-sidebar .sidebar-scroll')
    .evaluate((scroll) => scroll.offsetWidth - scroll.clientWidth)
  assert.equal(backBounds.x, tabBounds.x)
  assert.ok(Math.abs(backBounds.width - tabBounds.width - scrollbarWidth) < 1)
  assert.ok(backBounds.y + backBounds.height < tabBounds.y)
  await back.click()
  await page.waitForFunction(
    () => document.querySelector('.app').dataset.screen === 'editor',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    beforeSettings,
  )
  async function remote(address) {
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        .items.find((item) => item.label === 'File')
        .submenu.items.find((item) => item.label === 'Open from URL…')
        .click(),
    )
    const dialog = page.getByRole('dialog', {
      name: /^open from URL$/i,
      exact: true,
    })
    await dialog.getByLabel(/^markdown url$/i, { exact: true }).fill(address)
    await dialog.getByRole('button', { name: /^open$/i, exact: true }).click()
  }
  await remote(`${url}/readme.md`)
  await waitName('readme.md')
  const imported = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(imported.markdown, '# remote note')
  assert.equal(imported.dirty, true)
  await remote(`${url}/html`)
  await page
    .getByText(
      /this url points to a web page\. use a direct link to the raw text file\./i,
    )
    .waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '# remote note',
  )
  await remote(`${url}/large`)
  await page
    .getByText(/the download exceeds the 2 mib document limit\./i)
    .waitFor()
  await assert.rejects(
    page.evaluate(() => window.hibi.openRemoteDocument('file:///etc/passwd')),
  )
  await assert.rejects(
    page.evaluate(async () =>
      window.hibi.openDocumentLink(
        'javascript:alert(1)',
        (await window.hibi.getDocument()).revision,
      ),
    ),
  )
})
