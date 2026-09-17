import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('empty entry, three views, and lossless source switching', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-editor-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  assert.equal((await rich.innerText()).trim(), '')
  assert.equal(
    await rich.locator('p').getAttribute('data-placeholder'),
    'Start typing',
  )
  await page.waitForFunction(
    () =>
      (
        document.activeElement?.getAttribute('aria-label') ?? ''
      ).toLowerCase() === 'document editor',
  )
  await rich.fill('hello editor')
  await page.waitForFunction(
    () =>
      document.querySelector('.workspace-sidebar').getAttribute('data-open') ===
      'false',
  )
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('.titlebar')).opacity === '0',
  )
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('.titlebar')).opacity === '1',
  )
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.waitFor()
  const geometry = await page.evaluate(() => {
    const panes = document
      .querySelector('.editor-panes')
      .getBoundingClientRect()
    const title = document
      .querySelector('.document-title')
      .getBoundingClientRect()
    return {
      top: panes.top,
      toolbarBottom:
        document.querySelector('.editor-toolbar').getBoundingClientRect()
          .bottom +
        Number.parseFloat(
          getComputedStyle(document.querySelector('.editor-toolbar'))
            .marginBottom,
        ),
      bottom: panes.bottom,
      viewport: innerHeight,
      padding: getComputedStyle(document.querySelector('.tiptap')).paddingTop,
      besideSidebar:
        title.x >
        document.querySelector('.workspace-sidebar').getBoundingClientRect()
          .right,
      flat:
        getComputedStyle(document.querySelector('.titlebar'))
          .borderBottomWidth === '0px' &&
        getComputedStyle(document.querySelector('.document-title'))
          .borderWidth === '0px',
    }
  })
  assert.equal(geometry.top, geometry.toolbarBottom)
  assert.equal(geometry.bottom, geometry.viewport - 32)
  assert.equal(geometry.padding, '48px')
  assert.equal(geometry.besideSidebar, true)
  assert.equal(geometry.flat, true)
  await clickMenu(app, 'Settings')
  await page.getByRole('main', { name: /settings/i }).waitFor()
  assert.equal(await rich.isVisible(), false)
  await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
  await page
    .getByRole('checkbox', { name: /hide top bar while typing/i })
    .uncheck()
  await page.getByRole('tab', { name: /^editor$/i, exact: true }).click()
  await page.getByRole('slider', { name: /content padding/i }).press('Home')
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.querySelector('.tiptap')).paddingTop,
    ),
    '0px',
  )
  await page.keyboard.press('Escape')
  assert.equal(await source.innerText(), 'hello editor')
  const markdown =
    '# hello\n\n**bold** text\n\n- [x] done\n\n| name | value |\n| --- | --- |\n| one | two |'
  await source.fill(markdown)
  await rich.getByRole('heading', { name: /^hello$/i, exact: true }).waitFor()
  assert.equal(await rich.locator('strong').innerText(), 'bold')
  assert.equal(await rich.getByRole('checkbox').isChecked(), true)
  assert.equal(
    await rich.getByRole('cell', { name: /^two$/i, exact: true }).innerText(),
    'two',
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await source.waitFor({ state: 'hidden' })
  await page
    .getByRole('button', { name: /^markdown only$/i, exact: true })
    .click()
  await rich.waitFor({ state: 'hidden' })
  assert.equal(
    (await source.locator('.cm-line').allTextContents()).join('\n'),
    markdown,
  )
  const extended =
    '---\ntitle: keep me\n---\n\n<div data-value="keep">custom html</div>\n'
  await source.fill(extended)
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  assert.equal(await rich.getAttribute('contenteditable'), 'false')
  assert.equal(
    (await source.locator('.cm-line').allTextContents()).join('\n'),
    extended,
  )
  await page.reload()
  await rich.waitFor()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
  assert.equal(
    await page
      .getByRole('checkbox', { name: /hide top bar while typing/i })
      .isChecked(),
    false,
  )
  await page
    .getByRole('tab', { name: /^appearance$/i, exact: true })
    .press('ArrowUp')
  await page
    .getByRole('tab', {
      name: /^code highlighting$/i,
      exact: true,
      selected: true,
    })
    .waitFor()
  assert.equal(
    await page
      .getByRole('tab', { name: /^code highlighting$/i, exact: true })
      .getAttribute('aria-selected'),
    'true',
  )
  await page.keyboard.press('Escape')
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.querySelector('.tiptap')).paddingTop,
    ),
    '0px',
  )
  await page
    .getByRole('button', { name: /^markdown only$/i, exact: true })
    .click()
  await source.waitFor()
  const sourceBefore = (await page.evaluate(() => window.hibi.getDocument()))
    .markdown
  assert.equal(await page.locator('.cm-lineNumbers').count(), 0)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^editor$/i, exact: true }).click()
  await page.getByRole('checkbox', { name: /show line numbers/i }).check()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page.locator('.cm-lineNumbers').waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    sourceBefore,
  )
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await page.locator('.cm-lineNumbers').waitFor()
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].reload(),
    ),
  ])
  await page
    .getByRole('button', { name: /^markdown only$/i, exact: true })
    .click()
  await page.locator('.cm-lineNumbers').waitFor()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^editor$/i, exact: true }).click()
  await page.getByRole('checkbox', { name: /show line numbers/i }).uncheck()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page.locator('.cm-lineNumbers').waitFor({ state: 'detached' })
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    sourceBefore,
  )
})
