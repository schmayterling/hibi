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
    apiVersion: 2,
    kind: 'extension',
    version: '1.0.0',
    authors: [{ displayName: 'fixture author' }],
    entry: 'index.js',
    settings: { category: 'general', icon: 'book-open' },
  }
  await writeFile(join(extension, 'hibi-addon.json'), JSON.stringify(metadata))
  await writeFile(join(extension, 'README.md'), '# fixture addon')
  await writeFile(
    join(extension, 'index.js'),
    `export default ({ React, ui, codeMirror }) => ({
    start(context) {
      window.fixtureStarts = (window.fixtureStarts || 0) + 1;
      context.settings.registerCategory({id:'tools',label:'Fixture tools'});
      context.settings.register({id:'extra',label:'Fixture preferences',category:'tools',icon:(props)=>React.createElement('svg',{...props,'data-settings-icon':'fixture'}),Content() {
        return React.createElement(ui.SettingRow,{id:'fixture-extra',label:'Fixture chime'},React.createElement(ui.Toggle,{id:'fixture-extra',defaultChecked:true}));
      }});
      const view = context.sidebar.register({id:'view',label:'Fixture view',Content({input}) {
        React.useEffect(() => { window.fixtureViewMounted = true; return () => { window.fixtureViewMounted = false; }; }, []);
        return React.createElement('p', null, input || 'Fixture sidebar content');
      }});
      window.fixtureSidebar = view;
      context.statusBar.register({id:'status',label:'fixture active',onClick:()=>view.open('Selected fixture')});
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
      apiVersion: 1,
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
  await page.evaluate(() =>
    localStorage.setItem(
      'sidebar-pinned-views',
      JSON.stringify(['missing.one', 'missing.two', 'missing.three']),
    ),
  )
  await page.reload()
  await rich.fill('keep this draft')
  await pressShortcut(app, `${mod}+Shift+o`)
  await page.getByRole('button', { name: /new workspace file/i }).waitFor()
  assert.equal(await page.evaluate(() => window.fixtureStarts), undefined)
  assert.equal(
    (await page.evaluate(() => window.hibi.getInstalledAddons())).length,
    0,
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await pressShortcut(app, `${mod}+k`)
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('install addon')
  await page.getByRole('option').first().click()
  await page.locator('#addon-fixture-addon').waitFor()
  assert.equal(await page.locator('#addon-fixture-addon').isChecked(), false)
  assert.equal(await page.evaluate(() => window.fixtureStarts), undefined)
  const packages = await page.evaluate(() => window.hibi.getInstalledAddons())
  assert.deepEqual(packages[0].manifest.settings, metadata.settings)
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
  await page
    .getByRole('tab', { name: 'Fixture preferences', exact: true })
    .click()
  await page
    .getByRole('checkbox', { name: 'Fixture chime', exact: true })
    .waitFor()
  assert.equal(
    await page
      .locator('.sidebar-section')
      .filter({ hasText: 'Fixture tools' })
      .count(),
    1,
  )
  assert.equal(await page.locator('[data-settings-icon="fixture"]').count(), 1)
  await choose('Fixture chime')
  await page.waitForFunction(
    () => document.activeElement?.id === 'fixture-extra',
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page.getByText(/^fixture active$/i, { exact: true }).waitFor()
  assert.notEqual(await page.evaluate(() => window.fixtureViewMounted), true)
  await choose('show fixture view')
  const view = page.getByRole('complementary', { name: 'Fixture view' })
  await view.getByText('Fixture sidebar content', { exact: true }).waitFor()
  await page.getByRole('button', { name: /sidebar views/i }).click()
  await page.getByRole('menuitem', { name: /^pin fixture view tab$/i }).click()
  assert.deepEqual(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem('sidebar-pinned-views')),
    ),
    ['fixture-addon.view'],
  )
  assert.equal(await page.getByRole('dialog').count(), 0)
  await page.getByRole('button', { name: /^fixture active$/i }).click()
  await view.getByText('Selected fixture', { exact: true }).waitFor()
  await choose('show workspace sidebar')
  await page.waitForFunction(() => window.fixtureViewMounted === false)
  await choose('show fixture view')
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
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await page
    .locator('.rich-pane .hibi-token-keyword')
    .waitFor({ state: 'attached' })
  await page.evaluate(() => {
    window.syntaxSource = document.querySelector('.cm-content')
    window.syntaxRich = document.querySelector('.tiptap')
  })
  await choose('disable fixture addon')
  await page
    .locator('[id="settings-addon-fixture-addon.extra"]')
    .waitFor({ state: 'detached' })
  assert.equal(
    await page.locator('[id="settings-addon-fixture-addon.extra"]').count(),
    0,
  )
  await page.waitForFunction(() => window.fixtureViewMounted === false)
  await page.evaluate(() => window.fixtureSidebar.open('Disposed view'))
  assert.equal(
    await page.getByRole('complementary', { name: 'Fixture view' }).count(),
    0,
  )
  assert.equal(await page.locator('.app').getAttribute('data-sidebar'), 'true')
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
  await source.focus()
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async () =>
      !(await window.hibi.getDocument()).markdown.includes('fixture-code'),
  )
  await pressShortcut(
    app,
    process.platform === 'win32' ? 'Control+y' : `${mod}+Shift+z`,
  )
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    code,
  )
  await choose('enable fixture addon')
  await page
    .locator('.source-pane .hibi-token-keyword')
    .filter({ hasText: /^hello addon$/i })
    .waitFor()
  await app.evaluate((_electron, path) => {
    globalThis.packageSource = path
  }, theme)
  await choose('install addon')
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
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
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
    /Addon folders cannot contain symbolic links or invalid paths\./,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getInstalledAddons())).length,
    1,
  )
})
