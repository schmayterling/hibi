import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('vim cursor stays hidden behind the startup screen', {
  timeout: 30000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-vim-startup-'))
  const profile = join(folder, 'profile')
  let app
  const close = async () => {
    if (!app) return
    await app.close()
    app = null
  }
  const launch = async () => {
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(6000)
    await page.locator('.titlebar').waitFor()
    return page
  }
  t.after(async () => {
    await close()
    await rm(folder, { recursive: true, force: true })
  })

  let page = await launch()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^editor$/i, exact: true }).click()
  await page
    .getByLabel('Default view', { exact: true })
    .selectOption('markdown')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.locator('#addon-vim').click()
  await close()

  page = await launch()
  await page.getByRole('region', { name: /start writing/i }).waitFor()
  const cursor = page.locator('.cm-fat-cursor')
  await cursor.waitFor({ state: 'attached' })
  assert.equal(
    await cursor.evaluate((element) => getComputedStyle(element).visibility),
    'hidden',
  )
})

test('plugin pages, metadata, shared controls, and full source vim editing', {
  timeout: 60000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-vim-'))
  const fixture = join(folder, 'note.md')
  const initial = 'alpha beta gamma\nsecond line\nthird line'
  await writeFile(fixture, initial)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  if (process.platform === 'darwin')
    assert.equal(
      await app.evaluate(({ systemPreferences }) =>
        systemPreferences.getUserDefault('ApplePressAndHoldEnabled', 'boolean'),
      ),
      false,
    )
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, fixture) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [fixture],
    })
  }, fixture)
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await clickMenu(app, 'Open…')
  await page.waitForFunction(() =>
    document.querySelector('.tiptap')?.textContent.includes('alpha'),
  )
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.waitFor()
  const read = async () =>
    (await page.evaluate(() => window.hibi.getDocument())).markdown
  const toggleAddon = async (id, enabled) => {
    const checkbox = page.locator(`#addon-${id}`)
    if ((await checkbox.isChecked()) !== enabled) await checkbox.click()
    await page.waitForFunction(
      ({ id, enabled }) =>
        document.querySelector(`#addon-${id}`).checked === enabled,
      { id, enabled },
    )
  }
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^editor$/i, exact: true }).click()
  await mkdir('test-results', { recursive: true })
  await page.screenshot({
    path: 'test-results/settings-buttons.png',
    animations: 'disabled',
  })
  assert.equal(
    await page
      .getByRole('button', { name: /reset to 48 px/i })
      .evaluate((el) => getComputedStyle(el).borderTopWidth),
    '1px',
  )
  await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
  await page.screenshot({
    path: 'test-results/settings-chevron.png',
    animations: 'disabled',
  })
  assert.equal(
    await page
      .getByRole('combobox', { name: /cursor style/i })
      .evaluate((el) => getComputedStyle(el).appearance),
    'none',
  )
  assert.equal(
    await page.locator('#settings-appearance .select-control > svg').count(),
    await page.locator('#settings-appearance .select-control > select').count(),
  )
  const footer = await page.locator('.settings-versions').evaluate((el) => ({
    bottom: el.getBoundingClientRect().bottom,
    height: innerHeight,
    text: el.textContent,
  }))
  assert.ok(footer.bottom > footer.height - 80)
  assert.match(footer.text, /Hibi 0\.1\.0.*Electron 44\.3\.0/)
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  assert.ok(
    (await page
      .locator('#settings-addons [data-discord-id="1262793452236570667"]')
      .count()) >= 6,
  )
  await toggleAddon('frontmatter', false)
  assert.equal(
    await page
      .getByRole('tab', { name: /^frontmatter$/i, exact: true })
      .count(),
    0,
  )
  await page.getByRole('tab', { name: /^markdown$/i, exact: true }).waitFor()
  await toggleAddon('vim', true)
  await page
    .locator('style[data-addon-style="vim.editor"]')
    .waitFor({ state: 'attached' })
  await page.getByRole('tab', { name: /^vim$/i, exact: true }).click()
  await page.waitForFunction(() => {
    const selected = document.querySelector(
      '.settings-sidebar [aria-selected="true"]',
    )
    const marker = document.querySelector(
      '.settings-sidebar .sidebar-selection',
    )
    return (
      Math.abs(
        selected.getBoundingClientRect().top -
          marker.getBoundingClientRect().top,
      ) < 1
    )
  })
  assert.deepEqual(
    await page.locator('.settings-sidebar .sidebar-section').allTextContents(),
    ['Editing', 'Interface', 'Addons', 'Addon settings'],
  )
  await page.getByRole('checkbox', { name: /show vim status/i }).uncheck()
  await page.getByRole('checkbox', { name: /show vim status/i }).check()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page.waitForFunction(
    () =>
      document.querySelector('[data-vim-plugin="true"]') ||
      document.querySelector('.toast[data-variant="error"]')?.textContent,
  )
  assert.deepEqual(
    await page.locator('.toast[data-variant="error"]').allTextContents(),
    [],
  )
  await page
    .getByRole('status')
    .filter({ hasText: /vim · normal/i })
    .waitFor()
  const statusBounds = await page
    .locator('.app-statusbar')
    .evaluate((element) => ({
      left: element.getBoundingClientRect().left,
      bottom: element.getBoundingClientRect().bottom,
      height: innerHeight,
      pageLeft: document
        .querySelector('.editor-surface')
        .getBoundingClientRect().left,
      sidebarBottom: document
        .querySelector('.workspace-sidebar')
        .getBoundingClientRect().bottom,
    }))
  assert.equal(statusBounds.left, statusBounds.pageLeft)
  assert.equal(statusBounds.bottom, statusBounds.height)
  assert.equal(statusBounds.sidebarBottom, statusBounds.height)
  for (const open of [true, false]) {
    await page
      .getByRole('button', { name: /toggle workspace sidebar/i })
      .click()
    await page.waitForFunction(
      (open) =>
        document.querySelector('.app-statusbar').getBoundingClientRect()
          .left === (open ? 256 : 0),
      open,
    )
    assert.equal(
      await page
        .locator('.app-statusbar')
        .evaluate(
          (el) =>
            el.getBoundingClientRect().left ===
            document.querySelector('.editor-surface').getBoundingClientRect()
              .left,
        ),
      true,
    )
  }
  assert.equal(await read(), initial)
  await source.press('Escape')
  const pendingCommand = page.locator(
    '.app-statusbar [data-tooltip="pending vim command" i]',
  )
  const lastCommand = page.locator(
    '.app-statusbar [data-tooltip="last vim command" i]',
  )
  await source.pressSequentially('2')
  assert.equal(await pendingCommand.innerText(), '2')
  await source.pressSequentially('2')
  assert.equal(await pendingCommand.innerText(), '22')
  await source.pressSequentially('k')
  assert.equal(await lastCommand.innerText(), '22k')
  await source.press('Enter')
  assert.equal(await lastCommand.innerText(), '22k')
  await source.pressSequentially('d')
  assert.equal(await pendingCommand.innerText(), 'd')
  await source.press('Escape')
  assert.equal(await lastCommand.innerText(), '22k')
  assert.equal(await read(), initial)
  await source.pressSequentially('gg0dw')
  assert.equal(await lastCommand.innerText(), 'dw')
  assert.match(await read(), /^beta gamma/)
  await source.press('u')
  assert.equal(await read(), initial)
  await source.press('Control+r')
  assert.match(await read(), /^beta gamma/)
  await source.press('u')
  await source.pressSequentially('gg0"ayyGp')
  assert.equal((await read()).match(/alpha beta gamma/g).length, 2)
  await source.press('u')
  await source.pressSequentially('gg0ciw')
  await page
    .getByRole('status')
    .filter({ hasText: /vim · insert/i })
    .waitFor()
  await page.keyboard.type('omega')
  assert.equal(await lastCommand.innerText(), 'ciw')
  await page.keyboard.press('Escape')
  await source.pressSequentially('w.')
  assert.match(await read(), /^omega omega gamma/)
  const ex = async (command) => {
    await source.pressSequentially(':')
    const input = page.locator('.cm-vim-panel input')
    await input.fill(command)
    await page.waitForFunction(
      (command) =>
        document.querySelector(
          '.app-statusbar [data-tooltip="pending vim command" i]',
        )?.textContent === `:${command}`,
      command,
    )
    await input.press('Enter')
    assert.equal(await lastCommand.innerText(), `:${command}`)
  }
  await ex('%s/omega/alpha/g')
  assert.match(await read(), /^alpha alpha gamma/)
  await source.pressSequentially('gg0qaA')
  await page.keyboard.type('!')
  await page.keyboard.press('Escape')
  await source.pressSequentially('qj@a')
  assert.match(await read(), /second line!/)
  await source.pressSequentially('gg0vww')
  await page
    .getByRole('status')
    .filter({ hasText: /vim · visual/i })
    .waitFor()
  await page
    .locator('.cm-selectionBackground')
    .first()
    .waitFor({ state: 'attached' })
  await source.press('Escape')
  const beforeSearch = await read()
  const beforePrompt = await lastCommand.innerText()
  await source.press('/')
  await page.locator('.cm-vim-panel input').fill('cancel this')
  assert.equal(await pendingCommand.innerText(), '/cancel this')
  await page.locator('.cm-vim-panel input').press('Escape')
  assert.equal(await lastCommand.innerText(), beforePrompt)
  await source.press('/')
  await page.locator('.cm-vim-panel input').fill('second')
  assert.equal(await pendingCommand.innerText(), '/second')
  await page.locator('.cm-vim-panel input').press('Enter')
  assert.equal(await lastCommand.innerText(), '/second')
  assert.equal(await read(), beforeSearch)
  await ex('w')
  await page
    .getByRole('status', { name: /unsaved changes/i })
    .waitFor({ state: 'hidden' })
  assert.equal(await readFile(fixture, 'utf8'), await read())
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains('cm-content'),
  )
  assert.equal(
    await source.evaluate((element) => element === document.activeElement),
    true,
  )
  await page.mouse.move(450, 18)
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('.titlebar')).opacity === '1',
  )
  await page.screenshot({
    path: 'test-results/vim-status.png',
    animations: 'disabled',
  })
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^vim$/i, exact: true }).click()
  await page.getByRole('checkbox', { name: /show vim status/i }).uncheck()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  assert.equal(await page.locator('[data-status-id^="vim."]').count(), 0)
  await clickMenu(app, 'Settings')
  await page.getByRole('checkbox', { name: /show vim status/i }).check()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  assert.equal(await lastCommand.innerText(), ':w')
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  const unavailable = page.locator('[data-status-id="vim.unavailable"]')
  await unavailable.waitFor()
  assert.equal(await unavailable.innerText(), 'Vim · off')
  assert.match(
    await unavailable.getAttribute('data-tooltip'),
    /Switch to source or side-by-side view to use Vim\./,
  )
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await unavailable.waitFor({ state: 'hidden' })
  await page
    .getByRole('status')
    .filter({ hasText: /vim · normal/i })
    .waitFor()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await toggleAddon('vim', false)
  assert.equal(
    await page.locator('style[data-addon-style="vim.editor"]').count(),
    0,
  )
  assert.equal(
    await page.getByRole('tab', { name: /^vim$/i, exact: true }).count(),
    0,
  )
  await page.getByRole('tab', { name: /^markdown$/i, exact: true }).waitFor()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page.waitForFunction(() => !document.querySelector('[data-vim-plugin]'))
  assert.equal(await page.locator('[data-status-id^="vim."]').count(), 0)
  const beforePlain = await read()
  await source.press('End')
  await source.pressSequentially(' plain')
  assert.ok((await read()).includes(' plain'))
  await source.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  assert.equal(await read(), beforePlain)
  assert.deepEqual(errors, [])
})
