import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('empty formatted blocks remain editable and rich editing survives vim and view switches', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-rich-editability-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.locator('#addon-vim').click()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await rich.fill('/table')
  await rich.press('Enter')
  await rich.locator('td').first().click()
  await page.keyboard.press('Enter')
  assert.equal(await rich.getAttribute('contenteditable'), 'true')
  await page.keyboard.type('cell')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('<br>cell'),
  )
  await rich.locator('td').last().click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.type('after table')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('after table'),
  )
  await pressShortcut(app, `${mod}+Shift+\\`)
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.waitFor()
  await page.locator('[data-vim-plugin]').waitFor()
  await source.focus()
  await source.press('Escape')
  await source.pressSequentially('Goextra')
  await source.press('Escape')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('extra'),
  )
  assert.equal(await rich.getAttribute('contenteditable'), 'false')
  await pressShortcut(app, `${mod}+Shift+[`)
  await source.waitFor({ state: 'hidden' })
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.editor?.isEditable,
  )
  await rich.locator('td').first().click()
  await page.keyboard.type(' rich')
  assert.equal(await rich.getAttribute('contenteditable'), 'true')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('rich'),
  )
  assert.ok(
    (await page.evaluate(() => window.hibi.getDocument())).markdown.includes(
      '<br>',
    ),
  )
  for (const command of ['code', 'quote', 'h1']) {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    const revision = (await page.evaluate(() => window.hibi.getDocument()))
      .revision
    await pressShortcut(app, `${mod}+n`)
    await waitForAsync(
      page,
      async (revision) => (await window.hibi.getDocument()).revision > revision,
      revision,
    )
    await rich.waitFor()
    await page.waitForFunction(
      () =>
        document.querySelector('.tiptap')?.textContent === '' &&
        document.querySelector('.tiptap')?.getAttribute('contenteditable') ===
          'true',
    )
    await rich.fill(`/${command}`)
    await page.getByRole('listbox', { name: /slash commands/i }).waitFor()
    await rich.press('Enter')
    await rich
      .locator({ code: 'pre', quote: 'blockquote', h1: 'h1' }[command])
      .waitFor()
    await rich.press(`${mod}+Enter`)
    await page.keyboard.type('outside')
    assert.equal(await rich.getAttribute('contenteditable'), 'true')
    assert.equal(await rich.locator('p').last().innerText(), 'outside')
  }
})
