import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('sideloads reviewed packages disabled, discovers their settings/themes/commands, and cleans up removal', {
  timeout: 45000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-sideload-'))
  const extension = join(temp, 'extension'),
    theme = join(temp, 'theme'),
    bad = join(temp, 'bad')
  await Promise.all([extension, theme, bad].map((path) => mkdir(path)))
  const metadata = {
    id: 'fixture-addon',
    name: 'fixture addon',
    description: 'sideload test',
    apiVersion: 1,
    kind: 'extension',
    version: '1.0.0',
    authors: [{ displayName: 'fixture author' }],
    entry: 'index.js',
  }
  await writeFile(join(extension, 'hibi-addon.json'), JSON.stringify(metadata))
  await writeFile(join(extension, 'README.md'), '# fixture addon')
  await writeFile(
    join(extension, 'index.js'),
    `export default ({ React, ui, codeMirror }) => ({
    start(context) {
      window.fixtureStarts = (window.fixtureStarts || 0) + 1;
      context.statusBar.register({id:'status',label:'fixture active'});
      context.editor.registerCodeLanguage({id:'fixture-code',language:codeMirror.language.StreamLanguage.define({token(stream) { stream.skipToEnd(); return 'keyword'; }})});
      context.styles.register('fixture', ':root { --fixture-enabled: yes; }');
      context.commands.register({id:'append',label:'fixture: append',run:()=>context.editor.updateMarkdown(text=>text+'\\nfixture')});
    },
    Settings() { return React.createElement(ui.SettingRow,{id:'fixture-option',label:'fixture option',description:'a discovered setting'},React.createElement(ui.Button,{id:'fixture-option'},'example')); }
  });`,
  )
  const license = await readFile('node_modules/react/LICENSE', 'utf8')
  await writeFile(
    join(theme, 'hibi-addon.json'),
    JSON.stringify({
      ...metadata,
      id: 'fixture-theme',
      name: 'fixture theme',
      kind: 'theme',
      entry: undefined,
      themes: [
        {
          id: 'dark',
          name: 'fixture night',
          appearance: 'dark',
          author: 'fixture author',
          license: { name: 'MIT', text: license },
          colors: {
            background: '#111111',
            surface: '#222222',
            ink: '#eeeeee',
            muted: '#aaaaaa',
            accent: '#88cccc',
            border: '#333333',
          },
        },
      ],
    }),
  )
  await writeFile(join(theme, 'README.md'), '# fixture theme')
  await writeFile(
    join(bad, 'hibi-addon.json'),
    JSON.stringify({ ...metadata, id: 'bad-symlink' }),
  )
  await writeFile(join(bad, 'README.md'), '# invalid package')
  await symlink(join(extension, 'index.js'), join(bad, 'index.js'))
  const profile = join(temp, 'profile')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  await app.evaluate(async ({ dialog, shell }, source) => {
    globalThis.packageSource = source
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [globalThis.packageSource],
    })
    dialog.showMessageBox = async () => ({ response: 1 })
    const fs = process.getBuiltinModule('fs/promises')
    shell.trashItem = async (path) => {
      await fs.rename(path, `${path}.trashed`)
    }
  }, extension)
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const choose = async (query) => {
    await pressShortcut(app, `${mod}+k`)
    const input = page.getByRole('combobox', { name: /search commands/i })
    await input.fill(query)
    await page.getByRole('option').first().waitFor()
    await input.press('Enter')
    await page
      .getByRole('dialog', { name: /command palette/i })
      .waitFor({ state: 'hidden' })
  }
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  await rich.fill('keep this draft')
  await pressShortcut(app, `${mod}+Shift+o`)
  await page.getByRole('button', { name: /new workspace file/i }).waitFor()
  assert.equal(await page.evaluate(() => window.fixtureStarts), undefined)
  assert.equal(
    (await page.evaluate(() => window.hibi.getInstalledAddons())).length,
    0,
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addons$/i, exact: true }).click()
  await pressShortcut(app, `${mod}+k`)
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('install theme or extension')
  await page.getByRole('option').first().click()
  await page.locator('#addon-fixture-addon').waitFor()
  assert.equal(await page.locator('#addon-fixture-addon').isChecked(), false)
  assert.equal(await page.evaluate(() => window.fixtureStarts), undefined)
  const packages = await page.evaluate(() => window.hibi.getInstalledAddons())
  assert.equal(
    await page.evaluate(
      async (url) => (await fetch(url)).status,
      packages[0].url,
    ),
    403,
  )
  await page.locator('#addon-fixture-addon').click()
  await page.waitForFunction(() => window.fixtureStarts === 1)
  await choose('fixture option')
  await page.waitForFunction(
    () => document.activeElement?.id === 'fixture-option',
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page.getByText(/^fixture active$/i, { exact: true }).waitFor()
  await choose('fixture: append')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('fixture'),
  )
  assert.match(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    /^keep this draft/,
  )
  await pressShortcut(app, `${mod}+Shift+]`)
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  const code = 'keep this draft\n\n```fixture-code\nhello addon\n```'
  await source.fill(code)
  await page
    .locator('.source-pane .hibi-token-keyword')
    .filter({ hasText: /^hello addon$/i })
    .waitFor()
  await page
    .locator('.rich-pane .hibi-token-keyword')
    .waitFor({ state: 'attached' })
  await page.evaluate(() => {
    window.syntaxSource = document.querySelector('.cm-content')
    window.syntaxRich = document.querySelector('.tiptap')
  })
  await choose('disable fixture addon')
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('.hibi-token-keyword')].some(
        (node) => node.textContent === 'hello addon',
      ),
  )
  assert.equal(
    await page.evaluate(
      () =>
        window.syntaxSource === document.querySelector('.cm-content') &&
        window.syntaxRich === document.querySelector('.tiptap'),
    ),
    true,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    code,
  )
  await source.press(`${mod}+z`)
  await waitForAsync(
    page,
    async () =>
      !(await window.hibi.getDocument()).markdown.includes('fixture-code'),
  )
  await source.press(`${mod}+Shift+z`)
  await choose('enable fixture addon')
  await page
    .locator('.source-pane .hibi-token-keyword')
    .filter({ hasText: /^hello addon$/i })
    .waitFor()
  await app.evaluate((_electron, path) => {
    globalThis.packageSource = path
  }, theme)
  await choose('install theme or extension')
  await waitForAsync(
    page,
    async () => (await window.hibi.getInstalledAddons()).length === 2,
  )
  await choose('enable fixture theme')
  await choose('themes fixture night')
  await page.waitForFunction(
    () => document.documentElement.dataset.colorscheme === 'fixture-theme.dark',
  )
  const licenses = await page.evaluate(() => window.hibi.getLicenses())
  const credit = licenses.find((entry) => entry.name === 'fixture night')
  assert.ok(credit)
  assert.equal(
    await page.evaluate((id) => window.hibi.getLicense(id), credit.id),
    license,
  )
  await choose('disable fixture theme')
  await page.waitForFunction(
    () => document.documentElement.dataset.colorscheme === 'hibi-dark',
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addons$/i, exact: true }).click()
  await page
    .locator('.setting-row')
    .filter({ has: page.locator('#addon-fixture-addon') })
    .getByRole('button', { name: /^remove$/i, exact: true })
    .click()
  await page.locator('#addon-fixture-addon').waitFor({ state: 'detached' })
  assert.equal(
    await page
      .locator('style[data-addon-style="fixture-addon.fixture"]')
      .count(),
    0,
  )
  assert.equal(
    await page.getByText(/^fixture active$/i, { exact: true }).count(),
    0,
  )
  await pressShortcut(app, `${mod}+k`)
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('fixture: append')
  assert.equal(await page.getByRole('option').count(), 0)
  await page.keyboard.press('Escape')
  await app.evaluate((_electron, path) => {
    globalThis.packageSource = path
  }, bad)
  await assert.rejects(
    page.evaluate(() => window.hibi.installAddon()),
    /symlink/,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getInstalledAddons())).length,
    1,
  )
})
