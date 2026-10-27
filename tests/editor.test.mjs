import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  testFormattedEngines as it,
  selectFormattedEngine,
} from './formatted-engine.mjs'
import {
  clickMenu,
  pressShortcut,
  replaceRichText,
  replaceSourceText,
} from './keyboard.mjs'

it('empty entry, three views, and lossless source switching', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-editor-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  let cdp
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      })
    })
    await cdp?.detach()
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const cm = t.formattedEngine === 'codemirror'
  await selectFormattedEngine(app, page, t.formattedEngine)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  if (cm) {
    cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  }
  await waitForDocumentEditor(app, page)
  if (cm) {
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      '',
    )
    await rich.locator('.cm-placeholder').waitFor({ state: 'attached' })
    assert.equal(
      await rich.locator('.cm-placeholder').textContent(),
      'Start typing',
    )
  } else {
    assert.equal((await rich.innerText()).trim(), '')
    assert.equal(
      await rich.locator('p').getAttribute('data-placeholder'),
      'Start typing',
    )
  }
  await page.waitForFunction(
    () =>
      (
        document.activeElement?.getAttribute('aria-label') ?? ''
      ).toLowerCase() === 'document editor',
  )
  await replaceRichText(page, rich, 'hello editor')
  await page.waitForFunction(
    () =>
      document.querySelector('.workspace-sidebar').getAttribute('data-open') ===
      'false',
  )
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.querySelector('.titlebar')).opacity,
    ),
    '1',
  )
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.waitFor()
  const geometry = await page.evaluate((cm) => {
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
      padding: getComputedStyle(
        document.querySelector(cm ? '.rich-pane .cm-content' : '.tiptap'),
      ).paddingTop,
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
  }, cm)
  assert.equal(geometry.top, geometry.toolbarBottom)
  assert.equal(geometry.bottom, geometry.viewport - 32)
  assert.equal(geometry.padding, '48px')
  assert.equal(geometry.besideSidebar, true)
  assert.equal(geometry.flat, true)
  await clickMenu(app, 'Settings')
  await page.getByRole('main', { name: /settings/i }).waitFor()
  if (cm) await rich.waitFor({ state: 'hidden' })
  assert.equal(await rich.isVisible(), false)
  await page.getByRole('tab', { name: /^editor$/i, exact: true }).click()
  await page.getByRole('slider', { name: /content padding/i }).press('Home')
  assert.equal(
    await page.evaluate(
      (cm) =>
        getComputedStyle(
          document.querySelector(cm ? '.rich-pane .cm-content' : '.tiptap'),
        ).paddingTop,
      cm,
    ),
    '0px',
  )
  await page.keyboard.press('Escape')
  assert.equal(await source.innerText(), 'hello editor')
  const markdown =
    '# hello\n\n**bold** text\n\n- [x] done\n\n| name | value |\n| --- | --- |\n| one | two |'
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(page, source, markdown)
  await rich.getByRole('heading', { name: /^hello$/i, exact: true }).waitFor()
  assert.equal(
    await rich.locator(cm ? '.hibi-lp-strong' : 'strong').innerText(),
    'bold',
  )
  if (cm)
    assert.equal(
      await rich
        .locator('.hibi-lp-strong')
        .evaluate(
          (element) =>
            Number.parseFloat(getComputedStyle(element).fontWeight) >= 600,
        ),
      true,
    )
  assert.equal(await rich.getByRole('checkbox').isChecked(), true)
  assert.equal(
    await rich.getByRole('cell', { name: /^two$/i, exact: true }).innerText(),
    'two',
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await source.waitFor({ state: 'hidden' })
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await rich.waitFor({ state: 'hidden' })
  assert.equal(
    (await source.locator('.cm-line').allTextContents()).join('\n'),
    markdown,
  )
  const extended =
    '---\ntitle: keep me\n---\n\n<div data-value="keep">custom html</div>\n'
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(page, source, extended)
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await t.test(
    'split formatted view is read-only',
    {
      todo: cm
        ? 'formatted gap split-002: split formatted view must remain read-only'
        : undefined,
    },
    async () => {
      assert.equal(await rich.getAttribute('contenteditable'), 'false')
    },
  )
  if (cm) {
    await rich.locator('.hibi-lp-codeblock').waitFor()
    assert.ok(
      (await rich.innerText()).includes(
        '<div data-value="keep">custom html</div>',
      ),
    )
  }
  assert.equal(
    (await source.locator('.cm-line').allTextContents()).join('\n'),
    extended,
  )
  await page.reload()
  await rich.waitFor()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
  const appearance = page.getByRole('tab', {
    name: /^appearance$/i,
    exact: true,
  })
  const previousTab = await appearance.evaluate((tab) => {
    const tabs = [
      ...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]'),
    ]
    return tabs[tabs.indexOf(tab) - 1].id
  })
  await appearance.press('ArrowUp')
  await page.locator(`[id="${previousTab}"][aria-selected="true"]`).waitFor()
  assert.equal(
    await page
      .locator(`[id="${previousTab}"]`)
      .evaluate((tab) => tab === document.activeElement),
    true,
  )
  await page.keyboard.press('Escape')
  assert.equal(
    await page.evaluate(
      (cm) =>
        getComputedStyle(
          document.querySelector(cm ? '.rich-pane .cm-content' : '.tiptap'),
        ).paddingTop,
      cm,
    ),
    '0px',
  )
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
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
    .getByRole('button', { name: /^source view$/i, exact: true })
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

it('rich find status follows matches and selection while typing', {
  timeout: 30000,
}, async (t) => {
  const engine = t.formattedEngine
  const profile = await mkdtemp(join(tmpdir(), 'hibi-find-status-'))
  const file = join(profile, 'find.md')
  await writeFile(file, 'alpha beta alpha\n')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const rich = await selectFormattedEngine(app, page, engine)
  const count = (text) =>
    page.waitForFunction(
      (text) => document.querySelector('.find-count')?.textContent === text,
      text,
    )
  const edit = async (change) => {
    if (change === 'append' || change === 'last') {
      await rich.press('End')
      if (change === 'append') await page.keyboard.insertText(' alpha')
      else
        for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft')
    } else {
      await rich.press('Home')
      for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight')
      if (change === 'type') await page.keyboard.insertText('x')
    }
  }
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+f' : 'Control+f',
  )
  await page
    .getByRole('textbox', { name: 'Find in document', exact: true })
    .fill('alpha')
  await count('1/2')
  await edit('beta')
  await count('0/2')
  await edit('append')
  await count('0/3')
  await edit('last')
  await count('3/3')
  await edit('type')
  await count('0/3')
})
