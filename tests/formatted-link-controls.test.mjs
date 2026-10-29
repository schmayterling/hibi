import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

const note =
  'See [docs](https://old.example "Keep title") here. Bare https://bare.example/path.\n\n| name |\n| --- |\n| [&amp;](https://cell.example) |\n'
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
async function open(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-link-controls-'))
  const file = join(root, 'note.md')
  await writeFile(file, note)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog, shell, ipcMain }, file) => {
    ipcMain.removeHandler('clipboard:write-text')
    ipcMain.handle('clipboard:write-text', (_event, value) => {
      globalThis.copiedLink = value
    })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    globalThis.openedLinks = []
    shell.openExternal = async (url) => {
      globalThis.openedLinks.push(url)
    }
  }, file)
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  const editor = await selectFormattedEngine(app, page, 'codemirror')
  await clickMenu(app, 'Open…')
  await page.getByRole('link', { name: 'docs', exact: true }).waitFor()
  const panel = page.getByRole('dialog', { name: 'Link actions', exact: true })
  const dialog = page.getByRole('dialog', { name: 'Edit link', exact: true })
  const read = () =>
    page.evaluate(async () => (await window.hibi.getDocument()).markdown)
  return { app, page, editor, panel, dialog, read }
}

test('codemirror link hover offers URL, edit, open, copy and remove', {
  timeout: 60000,
}, async (t) => {
  const { app, page, panel, dialog, read } = await open(t)
  const link = page.getByRole('link', { name: 'docs', exact: true })
  await link.hover()
  await panel.waitFor()
  await page.screenshot({ path: resolve('.scratch/link-actions.png') })
  assert.match(await panel.innerText(), /https:\/\/old.example/)
  for (const label of ['Edit link', 'Open link', 'Copy link', 'Remove link'])
    await panel.getByRole('button', { name: label, exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Copy link', exact: true }).click()
  assert.equal(
    await app.evaluate(() => globalThis.copiedLink),
    'https://old.example',
  )
  await link.hover()
  await panel.getByRole('button', { name: 'Open link', exact: true }).click()
  assert.deepEqual(await app.evaluate(() => globalThis.openedLinks), [
    'https://old.example/',
  ])
  await link.hover()
  await panel.getByRole('button', { name: 'Edit link', exact: true }).click()
  assert.equal(
    await dialog.getByLabel('Link destination').inputValue(),
    'https://old.example',
  )
  await dialog.getByLabel('Link destination').fill('https://new.example')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.ok((await read()).includes('[docs](https://new.example "Keep title")'))
  await pressShortcut(app, `${mod}+z`)
  await page.waitForFunction(
    async (note) => (await window.hibi.getDocument()).markdown === note,
    note,
  )
  await link.hover()
  await panel.getByRole('button', { name: 'Remove link', exact: true }).click()
  await page.waitForFunction(async () =>
    (await window.hibi.getDocument()).markdown.startsWith('See docs here.'),
  )
  await pressShortcut(app, `${mod}+z`)
  await page.waitForFunction(
    async (note) => (await window.hibi.getDocument()).markdown === note,
    note,
  )
})

test('codemirror removes a detected URL without changing its visible text', {
  timeout: 60000,
}, async (t) => {
  const { app, page, panel, read } = await open(t)
  const link = page.getByRole('link', {
    name: 'https://bare.example/path',
    exact: true,
  })
  await link.hover()
  await panel.getByRole('button', { name: 'Remove link', exact: true }).click()
  await link.waitFor({ state: 'detached' })
  assert.ok((await read()).includes('https\\://bare.example/path'))
  await pressShortcut(app, `${mod}+z`)
  await link.waitFor()
})

test('codemirror caret actions and context edit are keyboard reachable', {
  timeout: 60000,
}, async (t) => {
  const { app, page, panel, dialog } = await open(t)
  const link = page.getByRole('link', { name: 'docs', exact: true })
  await link.click()
  await panel.waitFor()
  await page.keyboard.press('Tab')
  assert.equal(
    await panel
      .getByRole('button', { name: 'Edit link', exact: true })
      .evaluate((button) => button === document.activeElement),
    true,
  )
  await page.keyboard.press('Enter')
  await dialog.waitFor()
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await link.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Link actions', exact: true })
  await menu
    .getByRole('menuitem', { name: 'Edit link…', exact: true })
    .waitFor()
  await page.keyboard.press('Enter')
  await dialog.waitFor()
  assert.equal(
    await dialog.getByLabel('Link destination').inputValue(),
    'https://old.example',
  )
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await link.click()
  await page.keyboard.press('Shift+F10')
  await menu.waitFor()
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  await page.waitForFunction(() =>
    document.activeElement?.closest('.rich-pane .cm-editor'),
  )
})

test('toolbar settings keep the stable link action name', {
  timeout: 30000,
}, async (t) => {
  const { app, page } = await open(t)
  await page.getByRole('link', { name: 'docs', exact: true }).click()
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-toolbar-id="format.link"]')
        ?.getAttribute('aria-label') === 'Edit link',
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^appearance$/i }).click()
  await page.locator('.toolbar-order summary').click()
  const action = page.locator(
    '.toolbar-order [data-toolbar-id="format.link"] button',
  )
  assert.equal(await action.innerText(), 'Link')
  await action.click()
  await page
    .getByRole('combobox', { name: 'Toolbar placement for Link', exact: true })
    .waitFor()
})

test('codemirror entity-only cell link has the same caret actions', {
  timeout: 60000,
}, async (t) => {
  const { page, panel, dialog } = await open(t)
  const link = page.getByRole('link', { name: '&', exact: true })
  await link.click()
  await page
    .locator('.hibi-lp-cell-editor')
    .getByRole('link', { name: '&', exact: true })
    .waitFor()
  await panel.waitFor()
  await panel.getByRole('button', { name: 'Edit link', exact: true }).click()
  assert.equal(
    await dialog.getByLabel('Link destination').inputValue(),
    'https://cell.example',
  )
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
})
