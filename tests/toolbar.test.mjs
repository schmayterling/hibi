import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'
import { uiName } from './ui.mjs'

test('addon actions follow formatting by default and keep custom toolbar order', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-toolbar-addon-order-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await page.evaluate(() => window.hibi.setAddonEnabled('tags', true))
  await page.reload()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^appearance$/i }).click()
  await page.locator('.toolbar-order summary').click()
  const order = page.locator('.toolbar-order li')
  const ids = () =>
    order.evaluateAll((items) => items.map((item) => item.dataset.toolbarId))
  await page.locator('.toolbar-order [data-toolbar-id="tags.browse"]').waitFor()
  assert.equal((await ids()).at(-1), 'tags.browse')
  await page
    .locator('.toolbar-order [data-toolbar-id="format.bold"] button')
    .click()
  await page.getByRole('button', { name: /^move bold later$/i }).click()
  assert.equal((await ids()).at(-1), 'tags.browse')
  await page
    .locator('.toolbar-order [data-toolbar-id="tags.browse"] button')
    .click()
  await page
    .getByRole('button', { name: /^move browse tags earlier$/i })
    .click()
  assert.equal((await ids()).at(-2), 'tags.browse')
  await page.reload()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^appearance$/i }).click()
  await page.locator('.toolbar-order summary').click()
  assert.equal((await ids()).at(-2), 'tags.browse')
  await page.getByRole('button', { name: /^reset order$/i }).click()
  assert.equal((await ids()).at(-1), 'tags.browse')
})

test('toolbar auto-hide defaults on, shares top-bar timing, and moves content smoothly', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-toolbar-hide-'))
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
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
  const autoHide = page.getByRole('checkbox', {
    name: /^hide toolbar while typing$/i,
    exact: true,
  })
  assert.equal(await autoHide.isChecked(), true)
  assert.equal(
    await page
      .getByRole('checkbox', {
        name: /^hide top bar while typing$/i,
        exact: true,
      })
      .isChecked(),
    true,
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page.locator('.toolbar-slot').evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    )
  })
  const expanded = await page
    .locator('.toolbar-slot')
    .evaluate((element) => element.getBoundingClientRect().height)
  const sample = () =>
    page.evaluate(async () => {
      const values = []
      for (let frame = 0; frame < 32; frame++) {
        await new Promise(requestAnimationFrame)
        values.push({
          height: document
            .querySelector('.toolbar-slot')
            .getBoundingClientRect().height,
          top: document.querySelector('.editor-page').getBoundingClientRect()
            .top,
          title: Number(
            getComputedStyle(document.querySelector('.titlebar')).opacity,
          ),
          toolbar: Number(
            getComputedStyle(document.querySelector('.editor-toolbar')).opacity,
          ),
          fade: Number.parseFloat(
            getComputedStyle(document.querySelector('.app')).getPropertyValue(
              '--editor-top-fade',
            ),
          ),
        })
      }
      return values
    })
  const [hiding] = await Promise.all([sample(), rich.press('a')])
  assert.ok(
    hiding.some((value) => value.height > 1 && value.height < expanded - 1),
  )
  assert.equal(hiding.at(-1).height, 0)
  assert.equal(hiding.at(-1).top, 0)
  const insets = await page
    .locator('.tiptap p')
    .first()
    .evaluate((paragraph) => {
      const rect = paragraph.getBoundingClientRect()
      return { top: rect.top, left: rect.left }
    })
  assert.ok(Math.abs(insets.top - insets.left) < 1, JSON.stringify(insets))
  assert.equal(hiding.at(-1).title, 0)
  assert.equal(hiding.at(-1).toolbar, 0)
  assert.ok(
    hiding.some(
      (value) =>
        value.height > 2 && value.toolbar < value.height / expanded - 0.15,
    ),
  )
  assert.equal(hiding.at(-1).fade, 24)
  assert.match(
    await page
      .locator('.editor-content')
      .evaluate((element) => getComputedStyle(element).maskImage),
    /24px/,
  )
  assert.ok(
    hiding.every(
      (value) => Math.abs(value.height / expanded - value.title) < 0.13,
    ),
  )
  await page.waitForFunction(
    () => document.querySelector('.app').dataset.typing === 'false',
  )
  const showing = await sample()
  assert.ok(
    showing.some((value) => value.height > 1 && value.height < expanded - 1),
  )
  assert.equal(showing.at(-1).height, expanded)
  assert.equal(showing.at(-1).top, 36 + expanded)
  assert.equal(showing.at(-1).title, 1)
  assert.equal(showing.at(-1).toolbar, 1)
  assert.ok(showing.some((value) => value.toolbar > 0 && value.toolbar < 1))
  assert.ok(
    showing.some(
      (value) =>
        value.height > 2 && value.toolbar < value.height / expanded - 0.15,
    ),
  )
  assert.equal(showing.at(-1).fade, 0)
  await clickMenu(app, 'Settings')
  await autoHide.uncheck()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await rich.press('b')
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('.titlebar')).opacity === '0',
  )
  assert.equal(
    await page
      .locator('.toolbar-slot')
      .evaluate((element) => element.getBoundingClientRect().height),
    expanded,
  )
  await page.reload()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
  assert.equal(await autoHide.isChecked(), false)
  await autoHide.check()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await rich.press('c')
  await page.waitForFunction(
    () =>
      document.querySelector('.toolbar-slot').getBoundingClientRect().height ===
      0,
  )
  assert.equal(
    await page
      .locator('.toolbar-slot')
      .evaluate((element) => getComputedStyle(element).transitionDuration),
    '0s',
  )
})

test('markdown toolbar formats both panes without dragging and reorders only in settings', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-toolbar-'))
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
  await page.evaluate(() =>
    localStorage.setItem('hibi:toolbar', JSON.stringify({ autoHide: false })),
  )
  await page.reload()
  page.setDefaultTimeout(7000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const rich = page.getByRole('textbox', { name: /document editor/i })
  const bar = page.getByRole('navigation', { name: /editor toolbar/i })
  const action = (id) => bar.locator(`[data-toolbar-id="format.${id}"]`)
  const run = async (id) => {
    if (
      !(await action(id).evaluate(
        (element) =>
          !element.closest('.toolbar-menu') ||
          element.closest('.toolbar-menu').matches(':popover-open'),
      ))
    )
      await bar
        .getByRole('button', {
          name: /^more formatting actions$/i,
          exact: true,
        })
        .click()
    await action(id).click()
  }
  const read = () =>
    page.evaluate(() => window.hibi.getDocument()).then((doc) => doc.markdown)
  const waitForMarkdown = (value) =>
    waitForAsync(
      page,
      async (value) => (await window.hibi.getDocument()).markdown === value,
      value,
    )
  await rich.fill('hello')
  assert.deepEqual(
    await action('bold').evaluate((button) => ({
      border: getComputedStyle(button).borderTopWidth,
      background: getComputedStyle(button).backgroundColor,
    })),
    { border: '0px', background: 'rgba(0, 0, 0, 0)' },
  )
  assert.equal(
    await bar.evaluate((element) => getComputedStyle(element).borderTopWidth),
    '1px',
  )
  await page.setViewportSize({ width: 480, height: 720 })
  const more = bar.getByRole('button', {
    name: /^more formatting actions$/i,
    exact: true,
  })
  await more.waitFor()
  await more.click()
  const overflow = page.getByRole('menu', {
    name: /^more formatting actions$/i,
    exact: true,
  })
  await overflow.waitFor()
  assert.equal(
    await overflow.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= innerWidth
    }),
    true,
  )
  await page.keyboard.press('ArrowDown')
  assert.equal(
    await page.evaluate(
      () => !!document.activeElement.closest('.toolbar-menu'),
    ),
    true,
  )
  await page.keyboard.press('Escape')
  await overflow.waitFor({ state: 'hidden' })
  assert.equal(
    await more.evaluate((button) => button === document.activeElement),
    true,
  )
  await more.click()
  await rich.click()
  await overflow.waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 1000, height: 720 })
  await rich.press('Control+a')
  await run('bold')
  await waitForMarkdown('**hello**')
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-toolbar-id="format.bold"]')
        ?.getAttribute('aria-pressed') === 'true',
  )
  assert.equal(await action('bold').getAttribute('aria-pressed'), 'true')
  await page.waitForFunction(
    () =>
      getComputedStyle(
        document.querySelector(
          '.editor-toolbar [data-toolbar-id="format.bold"]',
        ),
      ).backgroundColor !== 'rgba(0, 0, 0, 0)',
  )
  assert.notEqual(
    await action('bold').evaluate(
      (button) => getComputedStyle(button).backgroundColor,
    ),
    'rgba(0, 0, 0, 0)',
  )
  await run('undo')
  await waitForMarkdown('hello')
  await run('redo')
  await waitForMarkdown('**hello**')
  await run('bold')
  await waitForMarkdown('hello')
  await run('link')
  const link = page.getByRole('dialog', { name: /^insert link$/i, exact: true })
  await link
    .getByLabel(/^link destination$/i, { exact: true })
    .fill('https://example.com')
  await link.getByRole('button', { name: /^insert$/i, exact: true }).click()
  await link.waitFor({ state: 'hidden' })
  await waitForMarkdown('[hello](https://example.com)')
  await run('unlink')
  await waitForMarkdown('hello')
  for (const level of [1, 2, 3, 4, 5, 6]) {
    await run(`heading-${level}`)
    await waitForMarkdown(`${'#'.repeat(level)} hello`)
  }
  await run('paragraph')
  await waitForMarkdown('hello')
  await run('table')
  await rich.locator('table').waitFor()
  assert.equal(await rich.locator('tr').count(), 3)
  await run('row-after')
  assert.equal(await rich.locator('tr').count(), 4)
  await run('column-after')
  assert.equal(await rich.locator('tr').first().locator('th,td').count(), 3)
  await run('table-delete')
  assert.equal(await rich.locator('table').count(), 0)

  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.waitFor()
  for (const [id, expected] of [
    ['bold', '**hello**'],
    ['italic', '*hello*'],
    ['strike', '~~hello~~'],
    ['inline-code', '`hello`'],
    ['heading-6', '###### hello'],
    ['bullet-list', '- hello'],
    ['numbered-list', '1. hello'],
    ['checklist', '- [ ] hello'],
    ['quote', '> hello'],
  ]) {
    await source.fill('hello')
    await source.press('Control+a')
    await run(id)
    await waitForMarkdown(expected)
    await run('undo')
    await waitForMarkdown('hello')
  }
  await source.fill('first\nsecond')
  await source.press('Control+a')
  await run('numbered-list')
  await waitForMarkdown('1. first\n2. second')
  await run('undo')
  await waitForMarkdown('first\nsecond')
  await source.press('Control+a')
  await run('code-block')
  assert.match(await read(), /^```\nfirst\nsecond\n```/)
  await source.fill('image here')
  await source.press('Control+a')
  await writeFile(
    join(profile, 'sample.gif'),
    Buffer.from(
      'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      'base64',
    ),
  )
  await app.evaluate(({ dialog }, profile) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [`${profile}/sample.gif`],
    })
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: `${profile}/note.md`,
    })
  }, profile)
  await run('image')
  await waitForMarkdown('![sample](assets/sample.gif)')
  assert.equal(
    await page.getByRole('dialog', { name: /insert image/i }).count(),
    0,
  )
  await source.fill('split text')
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await source.click()
  await source.press('Control+a')
  await run('italic')
  await waitForMarkdown('*split text*')
  await rich.locator('em').waitFor()
  await mkdir('test-results', { recursive: true })
  await page.screenshot({
    path: 'test-results/markdown-toolbar.png',
    animations: 'disabled',
  })

  const toolbarOrder = () =>
    bar
      .locator(':scope > button[data-toolbar-id]')
      .evaluateAll((buttons) =>
        buttons.map((button) => button.dataset.toolbarId),
      )
  const originalOrder = await toolbarOrder()
  assert.equal(await bar.locator('[draggable="true"]').count(), 0)
  assert.equal(
    await bar.evaluate((element) =>
      getComputedStyle(element).getPropertyValue('-webkit-app-region'),
    ),
    'no-drag',
  )
  for (const target of [action('bold'), action('bold').locator('svg')]) {
    await target.hover()
    assert.equal(
      await target.evaluate((element) => getComputedStyle(element).cursor),
      'pointer',
    )
  }
  await bar.evaluate((element) => {
    window.toolbarDragStarts = 0
    element.addEventListener('dragstart', () => window.toolbarDragStarts++)
  })
  await action('italic').dragTo(action('undo'), {
    targetPosition: { x: 1, y: 10 },
  })
  assert.equal(await read(), '*split text*')
  assert.deepEqual(await toolbarOrder(), originalOrder)
  assert.equal(await page.evaluate(() => window.toolbarDragStarts), 0)
  assert.equal(
    await action('bold').evaluate((button) => {
      const event = new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
      })
      button.dispatchEvent(event)
      return event.defaultPrevented
    }),
    true,
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
  await page.locator('.toolbar-order summary').click()
  const order = page.getByRole('list', { name: /toolbar order/i })
  const row = (id) => order.locator(`[data-toolbar-id="format.${id}"]`)
  await row('italic').dragTo(row('undo'), { targetPosition: { x: 1, y: 10 } })
  assert.equal(
    await order.locator('li').first().getAttribute('data-toolbar-id'),
    'format.italic',
  )
  await row('bold').dragTo(row('italic'), { targetPosition: { x: 10, y: 1 } })
  assert.equal(
    await order.locator('li').first().getAttribute('data-toolbar-id'),
    'format.bold',
  )
  await page
    .getByRole('button', { name: /^move bold later$/i, exact: true })
    .click()
  assert.equal(
    await order.locator('li').first().getAttribute('data-toolbar-id'),
    'format.italic',
  )
  const boldTile = row('bold').getByRole('button')
  await boldTile.press('Alt+ArrowLeft')
  await page.waitForFunction(
    () =>
      document.activeElement?.closest('li')?.dataset.toolbarId ===
      'format.bold',
  )
  assert.equal(
    await order.locator('li').first().getAttribute('data-toolbar-id'),
    'format.bold',
  )
  await boldTile.press('Alt+ArrowRight')
  assert.equal(
    await order.locator('li').first().getAttribute('data-toolbar-id'),
    'format.italic',
  )
  await mkdir('test-results', { recursive: true })
  await page.screenshot({
    path: 'test-results/toolbar-order.png',
    animations: 'disabled',
  })
  await page.reload()
  await bar.waitFor()
  assert.equal(
    await bar
      .locator('button[data-toolbar-id^="format."]')
      .first()
      .getAttribute('data-toolbar-id'),
    'format.italic',
  )
  assert.deepEqual(errors, [])
})

test('select all stays in the active pane after changing views or clicking line numbers', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-select-all-'))
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
  page.setDefaultTimeout(7000)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page.evaluate(() => localStorage.setItem('line-numbers', 'true'))
  await page.reload()
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.fill('first\nsecond\nlast')
  const select = async () => {
    await pressShortcut(
      app,
      process.platform === 'darwin' ? 'Meta+a' : 'Control+a',
    )
    await page.waitForFunction(() =>
      window.getSelection()?.toString().includes('last'),
    )
    return page.evaluate(() => {
      const selection = window.getSelection()
      const parent = (node) =>
        node instanceof Element ? node : node?.parentElement
      return {
        anchor: parent(selection.anchorNode)?.closest('.cm-content, .tiptap')
          ?.className,
        focus: parent(selection.focusNode)?.closest('.cm-content, .tiptap')
          ?.className,
        text: selection.toString(),
      }
    })
  }
  for (const mode of ['source view', 'side-by-side']) {
    await page
      .getByRole('button', { name: uiName(mode, true), exact: true })
      .click()
    await page.waitForFunction(() =>
      document.activeElement?.classList.contains('cm-content'),
    )
    let selected = await select()
    assert.match(selected.anchor, /cm-content/)
    assert.match(selected.focus, /cm-content/)
    assert.equal(selected.text.match(/first/g).length, 1)
    assert.doesNotMatch(selected.text, /\d/)
    await page.locator('.cm-lineNumbers .cm-gutterElement').last().click()
    selected = await select()
    assert.match(selected.anchor, /cm-content/)
    assert.match(selected.focus, /cm-content/)
    await page
      .getByRole('textbox', { name: /markdown editor/i })
      .press('Control+a')
    assert.equal(
      await page.evaluate(() => window.getSelection().toString()),
      selected.text,
    )
  }
  await rich.click()
  const selected = await select()
  assert.match(selected.anchor, /tiptap/)
  assert.match(selected.focus, /tiptap/)
  assert.equal(selected.text.match(/first/g).length, 1)
})
