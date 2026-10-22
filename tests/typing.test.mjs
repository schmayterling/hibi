import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

// Counts committed editor input in the status bar; Typing speed itself is tested in its directory repository.
async function installTypingProbe(profile) {
  const directory = join(profile, 'installed-addons', 'typing-probe')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'hibi-addon.json'),
    JSON.stringify({
      id: 'typing-probe',
      name: 'Typing probe',
      description: 'Counts committed editor input.',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      capabilities: [],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(directory, 'index.js'),
    `export default () => ({ start(context) {
      let characters = 0
      const item = context.statusBar.register({ id: 'count', label: '0' })
      context.editor.onInput((event) => {
        characters += event.characters
        item.update({ label: String(characters) })
      })
    } })`,
  )
  await writeFile(
    join(directory, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'typing-probe': true }),
  )
}

test('editor input, source formatting shortcuts, and sidebar shortcut', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-typing-'))
  await installTypingProbe(profile)
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
  const count = page.locator('[data-status-id="typing-probe.count"]')
  const counted = (value) =>
    page.waitForFunction(
      (value) =>
        document.querySelector('[data-status-id="typing-probe.count"]')
          ?.textContent === value,
      value,
    )
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await counted('0')
  await page
    .getByRole('textbox', { name: /document editor/i })
    .pressSequentially('hello')
  await counted('5')
  await pressShortcut(app, `${mod}+Shift+]`)
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.press(`${mod}+a`)
  await pressShortcut(app, `${mod}+b`)
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === '**hello**',
  )
  await pressShortcut(app, `${mod}+Shift+\\`)
  await source.focus()
  await pressShortcut(app, `${mod}+i`)
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === '***hello***',
  )
  await source.press('ArrowRight')
  // Formatting adds no input, so the source-view key is the sixth character.
  await source.pressSequentially('!')
  await counted('6')
  const before = await page.locator('.app').getAttribute('data-sidebar')
  await pressShortcut(app, `${mod}+/`)
  await page.waitForFunction(
    (before) => document.querySelector('.app').dataset.sidebar !== before,
    before,
  )
  await pressShortcut(app, `${mod}+k`)
  await page.getByRole('combobox').fill('typing')
  await page.keyboard.press('Escape')
  await page
    .getByRole('dialog', { name: /command palette/i })
    .waitFor({ state: 'hidden' })
  // Palette text is not editor input: the next editor key makes seven.
  await source.focus()
  await source.pressSequentially('?')
  await counted('7')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '***hello!?***',
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.locator('#addon-typing-probe').click()
  await count.waitFor({ state: 'detached' })
})
