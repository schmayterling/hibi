import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, stopElectronTree } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('failed source languages retry in the same view and preserve native input, history and saves', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-language-retry-'))
  const addon = join(profile, 'installed-addons', 'language-fixture')
  const file = join(profile, 'note.retry')
  await mkdir(addon, { recursive: true })
  await writeFile(file, 'abc\r\n')
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'language-fixture',
      name: 'Language fixture',
      description: 'Language loading fixture',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      capabilities: ['source', 'ui'],
      fileExtensions: ['retry'],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['index.js', 'hibi-addon.json'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'language-fixture': true }),
  )
  await writeFile(
    join(addon, 'index.js'),
    `export default sdk => ({ start(context) {
    const fixture = window.languageFixture = { sdk, calls: 0 };
    context.editor.registerCodeLanguage({ id: 'retry-language', aliases: ['retry'], load: async () => {
      if (++fixture.calls === 1) throw Error('fixture language failed');
      await new Promise(resolve => { fixture.release = resolve });
      return sdk.codeMirror.language.StreamLanguage.define({ token(stream) { stream.skipToEnd(); return 'keyword' } });
    }});
    context.editor.registerDocumentFormat({ id: 'retry', name: 'Retry fixture', extensions: ['retry'],
      codeLanguage: 'retry-language', views: ['markdown'], Preview: () => null,
      render: async () => ({ html: '', css: '' }),
    });
  }});`,
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  const watchdog = setTimeout(() => stopElectronTree(app.process()), 27000)
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close().catch(() => {})
    clearTimeout(watchdog)
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .waitFor()
  await page.waitForFunction(() => !!window.languageFixture)
  assert.equal(await page.evaluate(() => window.languageFixture.calls), 0)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${mod}+o`)
  const retry = page.getByRole('button', {
    name: 'Retry language',
    exact: true,
  })
  await retry.waitFor()
  await page.evaluate(() => {
    const fixture = window.languageFixture
    fixture.view = fixture.sdk.codeMirror.view.EditorView.findFromDOM(
      document.querySelector('.cm-content'),
    )
    fixture.view.dispatch({ selection: { anchor: 2 } })
  })
  await retry.click()
  await page.waitForFunction(() => !!window.languageFixture.release)
  assert.equal(await page.evaluate(() => window.languageFixture.calls), 2)
  await page.evaluate(() => window.languageFixture.release())
  await page.waitForFunction(
    () =>
      document.querySelector('.cm-content')?.getAttribute('contenteditable') ===
      'true',
  )
  assert.equal(
    await page.evaluate(() => {
      const fixture = window.languageFixture
      return (
        fixture.view ===
          fixture.sdk.codeMirror.view.EditorView.findFromDOM(
            document.querySelector('.cm-content'),
          ) && fixture.view.state.selection.main.head === 2
      )
    }),
    true,
  )
  await retry.waitFor({ state: 'hidden' })
  await page.evaluate(() => window.languageFixture.view.focus())
  await page.keyboard.insertText('!')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'ab!c\r\n',
  )
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    'abc\r\n',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'abc\r\n',
  )
  await pressShortcut(app, `${mod}+Shift+z`)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    'ab!c\r\n',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'ab!c\r\n',
  )
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), 'ab!c\r\n')
})
