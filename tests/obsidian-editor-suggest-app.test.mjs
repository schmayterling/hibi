import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { fixtureVault } from './obsidian/harness.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const list = '.cm-tooltip-autocomplete'

test('obsidian editor suggestions open on their trigger, pick with Enter, close with Escape and leave on unload', {
  timeout: 120000,
}, async (t) => {
  const fixture = await fixtureVault(t, 'editor-suggest', { cleanup: false })
  await writeFile(join(fixture.vault, 'note.md'), 'Hello\r\n')
  const kept = () =>
    Promise.all(
      [
        'untouched.md',
        '.obsidian/plugins/editor-suggest/main.js',
        '.obsidian/plugins/editor-suggest/data.json',
      ].map((path) => readFile(join(fixture.vault, path), 'hex')),
    )
  const before = await kept()
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${fixture.overlay}`],
  })
  t.after(async () => {
    try {
      await app.close()
      assert.deepEqual(await kept(), before)
    } finally {
      await fixture.dispose()
    }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, vault) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [vault],
    })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, fixture.vault)
  await pressShortcut(app, `${mod}+Shift+o`)
  const warning = page.getByRole('dialog', {
    name: 'Back up this Obsidian vault',
  })
  await warning
    .locator('.dialog-footer')
    .getByRole('button', { name: 'Continue', exact: true })
    .click()
  await warning.waitFor({ state: 'hidden' })
  await page.locator('.app[aria-busy="false"]').waitFor()
  await page
    .getByRole('tree', { name: /workspace files/i })
    .getByRole('treeitem', { name: 'note.md', exact: true })
    .click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'note.md',
  )
  await waitForDocumentEditor(app, page)

  const settings = async (enable) => {
    await clickMenu(app, 'Settings')
    if (enable) {
      await page
        .getByRole('tab', { name: 'Addon Manager', exact: true })
        .click()
      await page
        .getByRole('checkbox', { name: 'Obsidian plugins', exact: true })
        .click()
      await page
        .getByRole('tab', { name: 'Addon Manager', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Install copy', exact: true })
        .click()
    } else
      await page
        .getByRole('tab', { name: 'Addon Manager', exact: true })
        .click()
    await page
      .getByRole('checkbox', { name: 'Enable Editor suggest', exact: true })
      .click()
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  }
  await settings(true)
  await page.waitForFunction(() => window.__hibiSuggestFixture)

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const content = '.rich-pane .cm-content'
  await page.locator(content).waitFor()
  await page.evaluate((content) => {
    const editor = document.querySelector(content).cmTile.root.view
    editor.focus()
    editor.dispatch({ selection: { anchor: editor.state.doc.line(1).to } })
  }, content)
  const text = () =>
    page.evaluate(
      (content) =>
        document.querySelector(content).cmTile.root.view.state.doc.line(1).text,
      content,
    )

  // Typed key by key: the list opens on typed characters.
  // The trigger opens the list with the plugin's own rows, after its answer.
  await page.keyboard.type(' @a')
  await page.locator(`${list} .fixture-person`).nth(1).waitFor()
  assert.deepEqual(
    await page.locator(`${list} .fixture-person`).allTextContents(),
    ['alice', 'alan'],
  )
  assert.deepEqual(
    await page.locator(`${list} [role="option"]`).allInnerTexts(),
    ['@alice', '@alan'],
  )
  // Enter picks the first row through selectSuggestion.
  await page.keyboard.press('Enter')
  await waitForAsync(
    page,
    (content) =>
      document.querySelector(content).cmTile.root.view.state.doc.line(1)
        .text === 'Hello @alice ',
    content,
  )
  await page.locator(list).waitFor({ state: 'hidden' })
  assert.deepEqual(
    await page.evaluate(() => window.__hibiSuggestFixture.selected),
    [['alice', true]],
  )
  assert.equal(
    await page.evaluate(() => window.__hibiSuggestFixture.file),
    'note.md',
  )
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith('Hello @alice '),
  )

  // Escape closes the list and keeps the typed text.
  await page.keyboard.type('@b')
  await page.locator(`${list} .fixture-person`).first().waitFor()
  await page.keyboard.press('Escape')
  await page.locator(list).waitFor({ state: 'hidden' })
  assert.equal(await text(), 'Hello @alice @b')
  assert.equal(
    (await page.evaluate(() => window.__hibiSuggestFixture.selected)).length,
    1,
  )

  // Unloaded, the trigger no longer reaches the plugin.
  await settings(false)
  await page.waitForFunction(() => window.__hibiSuggestFixture.unloaded === 1)
  await page.evaluate((content) => {
    const editor = document.querySelector(content).cmTile.root.view
    editor.focus()
    editor.dispatch({ selection: { anchor: editor.state.doc.line(1).to } })
  }, content)
  await waitForAsync(
    page,
    (content) => document.activeElement === document.querySelector(content),
    content,
  )
  const triggers = await page.evaluate(
    () => window.__hibiSuggestFixture.triggers,
  )
  await page.keyboard.type(' @a')
  await waitForAsync(
    page,
    (content) =>
      document
        .querySelector(content)
        .cmTile.root.view.state.doc.line(1)
        .text.endsWith('@b @a'),
    content,
  )
  // Longer than the list's typing delay and its providers' time limit.
  await page.evaluate(() => new Promise((done) => setTimeout(done, 700)))
  assert.equal(await page.locator(`${list} .fixture-person`).count(), 0)
  assert.equal(
    await page.evaluate(() => window.__hibiSuggestFixture.triggers),
    triggers,
  )
  assert.deepEqual(errors, [])
})
