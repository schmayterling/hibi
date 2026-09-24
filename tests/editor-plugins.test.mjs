import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('word counts and block dragging preserve drafts, formatting, undo, and plugin cleanup', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-editor-plugins-'))
  const initial =
    '# hello **world**\n\nsecond paragraph\n\nthird paragraph\n\n- first item\n- second item\n\nlast paragraph'
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'word-count': true, 'block-drag': true }),
  )
  await writeFile(join(profile, 'sample.md'), initial)
  await writeFile(join(profile, 'plain.txt'), 'plain 👨‍👩‍👧‍👦')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const read = () =>
    page.evaluate(async () => (await window.hibi.getDocument()).markdown)
  const status = page.locator('[data-status-id="word-count.total"]')
  const grip = page.locator('.block-drag-handle')
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  const count = (text) =>
    page.waitForFunction(
      (text) =>
        document.querySelector('[data-status-id="word-count.total"]')
          ?.textContent === text,
      text,
    )
  const open = async (name) => {
    await app.evaluate(
      ({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [path],
        })
      },
      join(profile, name),
    )
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      name,
    )
  }
  await rich.waitFor()
  await count('0 words · 0 characters')
  await open('sample.md')
  await count('12 words · 85 characters')
  await page.locator('.tiptap h1').hover()
  await grip.click()
  await page
    .getByRole('menuitem', { name: 'Move block down', exact: true })
    .click()
  assert.match(await read(), /^second paragraph\n\n# hello \*\*world\*\*/)
  await rich.press(`${mod}+z`)
  await waitForAsync(
    page,
    async (initial) => (await window.hibi.getDocument()).markdown === initial,
    initial,
  )

  await page.locator('.tiptap h1').hover()
  const target = page.locator('.tiptap > p').last()
  const box = await target.boundingBox()
  await grip.dragTo(target, { targetPosition: { x: 20, y: box.height - 1 } })
  await waitForAsync(
    page,
    async () => !(await window.hibi.getDocument()).markdown.startsWith('#'),
  )
  assert.match(await read(), /# hello \*\*world\*\*/)
  assert.equal((await read()).match(/hello/g).length, 1)
  await count('12 words · 85 characters')
  await rich.press(`${mod}+z`)
  await waitForAsync(
    page,
    async (initial) => (await window.hibi.getDocument()).markdown === initial,
    initial,
  )

  await page.locator('.tiptap li').first().hover()
  await grip.click()
  await page
    .getByRole('menuitem', { name: 'Move block down', exact: true })
    .click()
  assert.match(await read(), /- second item\n- first item/)
  await rich.press(`${mod}+z`)
  await waitForAsync(
    page,
    async (initial) => (await window.hibi.getDocument()).markdown === initial,
    initial,
  )
  await page.locator('.tiptap h1').click()
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: 'Search commands' })
    .fill('move block down')
  await page.getByRole('option', { name: /move block down/i }).click()
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith('second paragraph'),
  )
  await rich.press(`${mod}+z`)

  await pressShortcut(app, `${mod}+Shift+]`)
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await page
    .locator(
      '.editor-panes.mode-markdown[data-source-ready="true"] .source-pane:not([inert]) .cm-content[contenteditable="true"]',
    )
    .waitFor({ timeout: 15_000 })
  await source.fill('# cafe\u0301 👨‍👩‍👧‍👦\n\n中文')
  await count('2 words · 12 characters')
  await pressShortcut(app, `${mod}+Shift+[`)
  await count('2 words · 9 characters')
  await open('plain.txt')
  await count('1 word · 7 characters')
  assert.equal(await grip.isVisible(), false)

  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  for (const id of ['word-count', 'block-drag']) {
    await page.locator(`#addon-${id}`).click()
    await page.waitForFunction(
      (id) => !document.querySelector(`#addon-${id}`).checked,
      id,
    )
  }
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  assert.equal(await status.count(), 0)
  assert.equal(await grip.count(), 0)
  assert.equal(await read(), 'plain 👨‍👩‍👧‍👦')
  assert.deepEqual(errors, [])
})
