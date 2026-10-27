import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu, pressShortcut, replaceRichText } from './keyboard.mjs'

test('default view persists separately from temporary switches and respects format support', {
  timeout: 30000,
}, async (t) => {
  const engine = t.formattedEngine
  const temp = await mkdtemp(join(tmpdir(), 'hibi-default-view-'))
  const profile = join(temp, 'profile')
  const file = join(temp, 'plain.txt')
  await writeFile(file, 'Literal text')
  let app
  const close = async () => {
    if (!app) return
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    app = null
  }
  t.after(async () => {
    await close()
    await rm(temp, { recursive: true, force: true })
  })
  const launch = async () => {
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(6000)
    await page.locator('.titlebar').waitFor()
    return page
  }
  let page = await launch()
  await selectFormattedEngine(app, page, engine)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await waitForDocumentEditor(app, page)
  await replaceRichText(page, rich, 'Keep this draft')
  const draft = (await page.evaluate(() => window.hibi.getDocument())).markdown
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Editor', exact: true }).click()
  const setting = page.getByLabel('Default view', { exact: true })
  assert.equal(await setting.inputValue(), 'normal')
  await setting.selectOption('markdown')
  await page.getByRole('button', { name: /back to app/i }).click()
  await page.getByRole('textbox', { name: /markdown editor/i }).waitFor()
  assert.equal(
    await page
      .getByRole('button', { name: 'Source view', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    draft,
  )
  await clickMenu(app, 'Settings')
  await setting.selectOption('side-by-side')
  await page.getByRole('button', { name: /back to app/i }).click()
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${mod}+o`)
  await page
    .getByRole('textbox', { name: 'Plain text editor', exact: true })
    .waitFor()
  assert.equal(
    await page
      .getByRole('button', { name: 'Source view', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  )
  assert.equal(
    await page.evaluate(() => localStorage.getItem('default-view')),
    'side-by-side',
  )
  await pressShortcut(app, `${mod}+n`)
  await page.getByRole('textbox', { name: /markdown editor/i }).waitFor()
  assert.equal(
    await page
      .getByRole('button', { name: 'side-by-side', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  )
  await page.getByRole('button', { name: 'normal', exact: true }).click()
  await close()
  page = await launch()
  await page.getByRole('textbox', { name: /markdown editor/i }).waitFor()
  assert.equal(
    await page
      .getByRole('button', { name: 'side-by-side', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Editor', exact: true }).click()
  assert.equal(
    await page.getByLabel('Default view', { exact: true }).inputValue(),
    'side-by-side',
  )
  await page
    .getByLabel('Default view', { exact: true })
    .selectOption('markdown')
  await close()
  page = await launch()
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('aria-label') === 'Markdown editor',
  )
  await page.keyboard.type('Type immediately')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'Type immediately',
  )
  await page.evaluate(() => localStorage.setItem('default-view', 'invalid'))
  await page.reload()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  assert.equal(
    await page
      .getByRole('button', { name: 'normal', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  )
})
