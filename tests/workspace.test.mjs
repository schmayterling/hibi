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
import { checkSidebarResize } from './sidebar-resize.mjs'
import { uiName } from './ui.mjs'

test('nested workspace editing, addon lifecycle, and offline static export', {
  timeout: 60000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-workspace-'))
  const folder = join(directory, 'docs')
  const output = join(directory, 'index.html')
  await mkdir(join(folder, 'guides', 'advanced'), { recursive: true })
  await writeFile(
    join(folder, 'page.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>',
  )
  await writeFile(
    join(folder, 'README.md'),
    '# welcome\n\n[nested guide](guides/advanced/setup.md#installation)\n\n<script>window.compromised = true</script>\n\n<img src="https://example.com/tracker" onerror="window.compromised=true">\n\n[bad](javascript:alert(1))\n\nreplace tokens: $& $$',
  )
  await writeFile(
    join(folder, 'guides', 'advanced', 'setup.md'),
    '# installation\n\nconfigure quantumwidgets here.\n\n![local page](../../page.svg)\n\n- final list item',
  )
  await writeFile(join(directory, 'outside.md'), 'outside-secret')
  await symlink(join(directory, 'outside.md'), join(folder, 'linked.md'))
  await symlink(directory, join(folder, 'escape'))
  await writeFile(join(folder, '.secret.md'), 'hidden-secret')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(directory, 'profile')}`],
    colorScheme: null,
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      })
    })
    await app.close()
    await rm(directory, { recursive: true, force: true })
  })
  await app.evaluate(
    ({ dialog }, data) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [data.folder],
      })
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: data.output,
      })
    },
    { folder, output },
  )
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page.getByRole('button', { name: /toggle workspace sidebar/i }).click()
  await page
    .getByRole('button', { name: /^open workspace$/i, exact: true })
    .click()
  await page.getByRole('treeitem', { name: /^guides$/i, exact: true }).click()
  await page.getByRole('treeitem', { name: /^advanced$/i, exact: true }).click()
  await page
    .getByRole('treeitem', { name: /^setup\.md$/i, exact: true })
    .click()
  await page
    .getByRole('heading', { name: /^installation$/i, exact: true })
    .waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getWorkspace())).activePath,
    'guides/advanced/setup.md',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).dirty,
    false,
  )
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+f' : 'Control+f',
  )
  await page
    .getByRole('textbox', { name: /^find in document$/i, exact: true })
    .fill('final list item')
  await page.waitForFunction(
    () => document.querySelector('.find-bar output')?.textContent === '1/1',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).dirty,
    false,
  )
  await page
    .getByRole('textbox', { name: /^find in document$/i, exact: true })
    .press('Escape')
  assert.equal(
    await page
      .getByRole('treeitem', { name: /^linked\.md$/i, exact: true })
      .count(),
    0,
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.openWorkspaceFile('../outside.md')),
    /Choose a supported document inside this workspace\./,
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.openWorkspaceFile('linked.md')),
    /Symbolic links cannot be opened from a workspace\./,
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.openWorkspaceFile('escape/outside.md')),
    /outside/,
  )
  await page
    .getByRole('textbox', { name: /document editor/i })
    .fill('unsaved workspace draft')
  assert.equal(
    await page.locator('.workspace-sidebar').getAttribute('data-open'),
    'true',
  )
  const draft = (await page.evaluate(() => window.hibi.getDocument())).markdown
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 2,
      checkboxChecked: false,
    })
  })
  await page
    .getByRole('treeitem', { name: /^README\.md$/i, exact: true })
    .click()
  await page.getByRole('tab', { name: /^setup\.md$/i, exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.app').getAttribute('aria-busy') === 'false',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    draft,
  )
  await clickMenu(app, 'Save')
  await page
    .getByRole('status', { name: /unsaved changes/i })
    .waitFor({ state: 'hidden' })
  assert.equal(
    await readFile(join(folder, 'guides', 'advanced', 'setup.md'), 'utf8'),
    draft,
  )
  await writeFile(
    join(folder, 'guides', 'advanced', 'setup.md'),
    '# installation\n\nconfigure quantumwidgets here.\n\n![local page](../../page.svg)',
  )
  await page
    .getByRole('treeitem', { name: /^README\.md$/i, exact: true })
    .click()
  await page.getByRole('heading', { name: /^welcome$/i, exact: true }).waitFor()

  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  const enabled = page.getByRole('checkbox', {
    name: /^export$/i,
    exact: true,
  })
  await enabled.click()
  await page.waitForFunction(
    () => !document.querySelector('#addon-documentation').checked,
  )
  await page.waitForFunction(() =>
    window.hibi
      .getAddonStates()
      .then((states) =>
        states.some((addon) => addon.id === 'documentation' && !addon.enabled),
      ),
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.invokeAddon('documentation', 'export')),
    /Enable this addon in Settings → Addons first\./,
  )
  await enabled.click()
  await page.waitForFunction(
    () => document.querySelector('#addon-documentation').checked,
  )
  await page.waitForFunction(() =>
    window.hibi
      .getAddonStates()
      .then((states) =>
        states.some((addon) => addon.id === 'documentation' && addon.enabled),
      ),
  )
  await assert.rejects(
    page.evaluate(() =>
      window.hibi.invokeAddon('documentation', 'constructor'),
    ),
    /This addon does not support the requested action\./,
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()
  assert.equal(
    await page.locator('.workspace-sidebar .sidebar-footer').count(),
    0,
  )
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
  )
  const exportSearch = page.getByRole('combobox', { name: /search commands/i })
  await exportSearch.fill('export workspace to html')
  await exportSearch.press('Enter')
  await page
    .getByRole('dialog', { name: /^export workspace$/i })
    .getByRole('button', { name: /^export$/i, exact: true })
    .click()
  await page
    .getByRole('status')
    .filter({ hasText: /exported 2 pages/i })
    .waitFor()
  for (const kind of ['notice', 'error']) {
    if (kind === 'error') {
      await app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = async () => {
          throw new Error('could not open example file')
        }
      })
      await clickMenu(app, 'Open…')
    }
    await page.waitForFunction((kind) => {
      const notice = document
        .querySelector(
          `.toast[data-variant="${kind === 'error' ? 'error' : 'info'}"]`,
        )
        ?.getBoundingClientRect()
      return notice && Math.abs(notice.bottom - innerHeight + 16) < 1
    }, kind)
    const geometry = await page.evaluate(
      (kind) => ({
        right:
          innerWidth -
          document
            .querySelector(
              `.toast[data-variant="${kind === 'error' ? 'error' : 'info'}"]`,
            )
            .closest('.sonner')
            .getBoundingClientRect().right,
        editorTop: document
          .querySelector('.editor-surface')
          .getBoundingClientRect().top,
      }),
      kind,
    )
    assert.equal(geometry.right, 16)
    assert.equal(geometry.editorTop, 36)
    await page
      .getByRole('button', {
        name: uiName(`dismiss ${kind}`, true),
        exact: true,
      })
      .click()
  }
  const html = await readFile(output, 'utf8')
  const exported = JSON.parse(
    html.match(
      /<script id="workspace-data" type="application\/json">([\s\S]*?)<\/script>/,
    )[1],
  )
  assert.deepEqual(exported.appearance, {
    mode: 'system',
    light: 'hibi-light',
    dark: 'hibi-dark',
  })
  assert.ok(!html.includes('outside-secret') && !html.includes('hidden-secret'))
  assert.ok(
    html.includes('data:font/woff2;base64,') ||
      html.includes('data:application/font-woff;base64,') ||
      html.includes('data:font/woff;base64,'),
  )

  const nextWindow = app.waitForEvent('window')
  const viewerId = await app.evaluate(({ BrowserWindow }, output) => {
    const viewer = new BrowserWindow({
      width: 1000,
      height: 760,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    void viewer.loadFile(output)
    return viewer.id
  }, output)
  const site = await nextWindow
  const siteErrors = []
  site.on('pageerror', (error) => siteErrors.push(error.message))
  await site.getByRole('heading', { name: /^welcome$/i, exact: true }).waitFor()
  await site.getByText(/^replace tokens: \$& \$\$$/i, { exact: true }).waitFor()
  assert.equal(await site.evaluate(() => typeof window.hibi), 'undefined')
  assert.equal(await site.locator('[contenteditable="true"]').count(), 0)
  assert.equal(await site.locator('.view-switch').count(), 0)
  for (const viewportWidth of [1000, 480]) {
    await site.setViewportSize({ width: viewportWidth, height: 720 })
    if (viewportWidth <= 700) {
      await site.waitForFunction(
        () =>
          document
            .querySelector('.documentation-site')
            .getAttribute('data-sidebar') === 'false',
      )
      await site.getByRole('button', { name: /toggle navigation/i }).click()
      await site.waitForFunction(
        () =>
          document.querySelector('.sidebar').getBoundingClientRect().x === 0,
      )
    }
    for (const opening of [false, true]) {
      const samples = await site.evaluate(async () => {
        document.querySelector('[aria-label="toggle navigation" i]').click()
        const samples = []
        const start = performance.now()
        while (performance.now() - start < 320) {
          await new Promise(requestAnimationFrame)
          const sidebar = document.querySelector('.sidebar')
          const content = document.querySelector('.site-content')
          const bounds = sidebar.getBoundingClientRect()
          samples.push({
            x: bounds.x,
            right: bounds.right,
            width: sidebar.offsetWidth,
            top: bounds.top,
            bottom: bounds.bottom,
            height: innerHeight,
            contentX: content.getBoundingClientRect().x,
            contentWidth: content.offsetWidth,
            visibility: getComputedStyle(sidebar).visibility,
          })
        }
        return samples
      })
      assert.ok(samples.some(({ x }) => x > -255 && x < -1))
      assert.ok(
        samples.every(
          ({ width, top, bottom, height }) =>
            width === 256 && top === 0 && bottom === height,
        ),
      )
      assert.ok(
        samples
          .filter(({ x }) => x > -255 && x < -1)
          .every(({ visibility }) => visibility === 'visible'),
      )
      assert.ok(
        samples.every(
          ({ right, contentX }) =>
            Math.abs(contentX - (viewportWidth > 700 ? right : 0)) < 1,
        ),
        JSON.stringify({
          viewportWidth,
          opening,
          mismatches: samples
            .filter(
              ({ right, contentX }) =>
                Math.abs(contentX - (viewportWidth > 700 ? right : 0)) >= 1,
            )
            .slice(0, 3),
        }),
      )
      assert.equal(
        new Set(samples.map(({ contentWidth }) => contentWidth)).size,
        1,
      )
      assert.ok(Math.abs(samples.at(-1).x - (opening ? 0 : -256)) < 1)
    }
  }
  await site.setViewportSize({ width: 1000, height: 760 })
  await checkSidebarResize(site, 256, '.site-content', () => site.reload())
  assert.equal(await site.evaluate(() => window.compromised), undefined)
  assert.equal(await site.locator('article img').getAttribute('src'), null)
  assert.equal(
    await site.getByText(/^bad$/i, { exact: true }).getAttribute('href'),
    null,
  )
  await site.context().setOffline(true)
  await site.getByRole('link', { name: /^nested guide$/i, exact: true }).click()
  await site
    .getByRole('heading', { name: /^installation$/i, exact: true })
    .waitFor()
  assert.match(site.url(), /page=guides%2Fadvanced%2Fsetup.md/)
  await site.waitForFunction(() => {
    const image = document.querySelector('article img[alt="local page"]')
    return (
      image?.complete &&
      image.naturalWidth === 16 &&
      image.src.startsWith('data:image/svg+xml;base64,')
    )
  })
  await site
    .getByRole('treeitem', { name: /^installation$/i, exact: true })
    .waitFor()
  await site.getByRole('treeitem', { name: /^welcome$/i, exact: true }).click()
  await site
    .getByRole('treeitem', { name: /^welcome$/i, exact: true, selected: true })
    .waitFor()
  await site.waitForFunction(
    () =>
      document.querySelector('.sidebar-selection').getAnimations().length === 0,
  )
  const beforeSelection = await site
    .locator('.sidebar-selection')
    .evaluate((element) => element.getBoundingClientRect().top)
  const selection = await site
    .getByRole('treeitem', { name: /^installation$/i, exact: true })
    .evaluate(async (button) => {
      button.click()
      const frames = []
      const start = performance.now()
      while (performance.now() - start < 230) {
        await new Promise(requestAnimationFrame)
        const selected = document.querySelector(
          '[role="treeitem"][aria-selected="true"]',
        )
        frames.push({
          top: document
            .querySelector('.sidebar-selection')
            .getBoundingClientRect().top,
          background: getComputedStyle(selected).backgroundColor,
        })
      }
      return {
        frames,
        target: document
          .querySelector('[role="treeitem"][aria-selected="true"]')
          .getBoundingClientRect().top,
      }
    })
  assert.ok(
    selection.frames.some(
      ({ top }) =>
        top > Math.min(beforeSelection, selection.target) &&
        top < Math.max(beforeSelection, selection.target),
    ),
    JSON.stringify({ beforeSelection, ...selection }),
  )
  assert.equal(selection.frames.at(-1).top, selection.target)
  assert.ok(
    selection.frames.every(
      ({ background }) => background === 'rgba(0, 0, 0, 0)',
    ),
  )
  await site.keyboard.press(
    process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
  )
  const search = site.getByRole('combobox', { name: /search commands/i })
  const siteKeyStyle = (element) => {
    const style = getComputedStyle(element)
    return [
      style.height,
      style.minWidth,
      style.fontFamily,
      style.fontSize,
      style.borderRadius,
    ]
  }
  assert.deepEqual(
    await site.locator('.site-search kbd').first().evaluate(siteKeyStyle),
    await site.locator('.palette-footer kbd').first().evaluate(siteKeyStyle),
  )
  await site.mouse.click(12, 400)
  await site.getByRole('dialog').waitFor({ state: 'hidden' })
  await site.getByRole('button', { name: /search documentation/i }).click()
  await search.waitFor()
  await search.fill('instalation')
  await site
    .getByRole('option')
    .filter({ hasText: /installation/i })
    .waitFor()
  await search.fill('quantumwidgets')
  await site
    .getByRole('option')
    .filter({ hasText: /installation/i })
    .waitFor()
  await search.press('Enter')
  await site.getByRole('dialog').waitFor({ state: 'hidden' })
  await mkdir('test-results', { recursive: true })
  await site.screenshot({ path: 'test-results/exported-documentation.png' })
  await site.context().setOffline(false)
  assert.deepEqual(siteErrors, [])
  assert.deepEqual(errors, [])
  await app.evaluate(
    ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(),
    viewerId,
  )
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
  )
  await page.getByRole('dialog', { name: /command palette/i }).waitFor()
})
