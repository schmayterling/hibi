import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  testFormattedEngines as it,
  selectFormattedEngine,
} from './formatted-engine.mjs'
import { waitForAsync } from './poll.mjs'

async function openSite(t, folder, snapshot) {
  const html = join(folder, 'docs.html')
  const template = await readFile('out/site/template.html', 'utf8')
  await writeFile(
    html,
    template.replace('__HIBI_WORKSPACE_DATA__', () =>
      JSON.stringify(snapshot).replaceAll('<', '\\u003c'),
    ),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const desktop = await app.firstWindow()
  if (t.formattedEngine)
    await selectFormattedEngine(app, desktop, t.formattedEngine)
  const nextWindow = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, html) => {
    const window = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    void window.loadFile(html)
  }, html)
  const page = await nextWindow
  await page.setViewportSize({ width: 1440, height: 900 })
  return { app, page }
}

test('documentation breadcrumbs, outline, pagination, and phone navigation', {
  timeout: 45000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-site-'))
  const paragraph = 'a short paragraph for this section.\n\n'.repeat(9)
  const snapshot = {
    name: 'hibi documentation',
    appearance: {
      mode: 'dark',
      light: 'vscode-light',
      dark: 'catppuccin-mocha',
    },
    pages: [
      {
        path: 'README.md',
        markdown: '# welcome\n\na quiet place for your documentation.',
      },
      {
        path: 'guides/start.md',
        markdown: `# getting started\n\n## introduction\n\n${paragraph}## install\n\n\`\`\`sh\n${'long-command-'.repeat(30)}\n\`\`\`\n\n| option | value |\n| --- | --- |\n| long | ${'table-value-'.repeat(40)} |\n\n${paragraph}## usage\n\n### first step\n\n${paragraph}### next step\n\n${paragraph}`,
      },
      { path: 'guides/next.md', markdown: '# next steps\n\nkeep writing.' },
    ],
  }
  const template = await readFile('out/site/template.html', 'utf8')
  for (const name of ['catppuccin', 'vscode', 'nord'])
    assert.ok(
      template.includes(await readFile(`docs/licenses/${name}.md`, 'utf8')),
    )
  const { page } = await openSite(t, folder, snapshot)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('heading', { name: /^welcome$/i, exact: true }).waitFor()
  const headerSurface = await page
    .locator('.documentation-site')
    .evaluate((el) => ({
      background: getComputedStyle(el, '::before').backgroundColor,
      page: getComputedStyle(document.body).backgroundColor,
      layer: Number(getComputedStyle(el, '::before').zIndex),
      sidebarLayer: Number(
        getComputedStyle(document.querySelector('.site-layout .sidebar-slot'))
          .zIndex,
      ),
    }))
  assert.equal(headerSurface.background, headerSurface.page)
  assert.ok(headerSurface.layer < headerSurface.sidebarLayer)
  assert.equal(
    await page.locator('html').getAttribute('data-colorscheme'),
    'catppuccin-mocha',
  )
  await page
    .getByRole('button', { name: /^color scheme$/i, exact: true })
    .click()
  const appearance = page.getByRole('dialog', {
    name: /^appearance$/i,
    exact: true,
  })
  await appearance
    .getByRole('combobox', { name: /^appearance$/i, exact: true })
    .selectOption('light')
  assert.equal(
    await page.locator('html').getAttribute('data-colorscheme'),
    'vscode-light',
  )
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
  )
  assert.equal(await page.getByRole('dialog').count(), 1)
  await page.keyboard.press('Escape')
  await appearance.waitFor({ state: 'hidden' })
  await page.reload()
  await page.getByRole('heading', { name: /^welcome$/i, exact: true }).waitFor()
  assert.equal(
    await page.locator('html').getAttribute('data-colorscheme'),
    'vscode-light',
  )
  assert.equal(await page.locator('.sidebar-header').count(), 0)
  const pagination = page.getByRole('navigation', { name: /page navigation/i })
  await pagination.getByRole('link', { name: /next getting started/i }).click()
  await page
    .getByRole('heading', { name: /^getting started$/i, exact: true })
    .waitFor()
  const breadcrumbs = page.getByRole('navigation', { name: /breadcrumbs/i })
  assert.ok(
    await breadcrumbs.evaluate((element) =>
      Boolean(element.closest('.site-header')),
    ),
  )
  assert.match(
    await breadcrumbs.innerText(),
    /hibi documentation.*guides.*getting started/s,
  )
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.sidebar').getBoundingClientRect()
    const controls = document
      .querySelector('.site-navigation-controls')
      .getBoundingClientRect()
    const breadcrumbs = document
      .querySelector('.site-breadcrumbs')
      .getBoundingClientRect()
    return (
      Math.abs(controls.right - sidebar.right) < 1 &&
      breadcrumbs.left > sidebar.right
    )
  })
  assert.equal(await page.locator('.site-path').count(), 0)
  await page.locator('.site-outline').waitFor()
  const usage = page
    .locator('.site-outline')
    .getByRole('link', { name: /^usage$/i, exact: true })
  await usage.click()
  await page.waitForFunction(() => location.hash.includes('anchor=usage'))
  const aligned = () => {
    const root = document.querySelector('.site-content').getBoundingClientRect()
    const heading = document.querySelector('#doc-usage').getBoundingClientRect()
    return heading.top >= root.top && heading.top < root.top + 60
  }
  await page.waitForFunction(aligned)
  await page.waitForFunction(
    () =>
      document.querySelector('.site-outline a[aria-current]')?.textContent ===
      'usage',
  )
  await page
    .locator('.site-content')
    .evaluate((element) => element.scrollTo(0, 0))
  await usage.click()
  await page.waitForFunction(aligned)
  assert.equal(
    await pagination.evaluate(
      (element) => getComputedStyle(element).borderTopWidth,
    ),
    '1px',
  )
  await pagination.getByRole('link', { name: /next next steps/i }).click()
  await page
    .getByRole('heading', { name: /^next steps$/i, exact: true })
    .waitFor()
  await pagination
    .getByRole('link', { name: /previous getting started/i })
    .click()
  await page
    .getByRole('heading', { name: /^getting started$/i, exact: true })
    .waitFor()
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/documentation-desktop.png' })
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 })
    await page
      .getByRole('button', { name: /^color scheme$/i, exact: true })
      .click()
    await appearance.waitFor()
    assert.equal(
      await appearance.evaluate((el) => el.scrollWidth <= el.clientWidth),
      true,
    )
    await page.keyboard.press('Escape')
    await appearance.waitFor({ state: 'hidden' })
    await page.locator('.site-outline-mobile').waitFor()
    await page.waitForFunction(
      () =>
        innerWidth > 700 ||
        document
          .querySelector('.documentation-site')
          .getAttribute('data-sidebar') === 'false',
    )
    const bounds = await page.evaluate(() => {
      const content = document.querySelector('.site-content')
      const header = document.querySelector('.site-header')
      return {
        width: innerWidth,
        page: document.documentElement.scrollWidth,
        content: content.clientWidth,
        scroll: content.scrollWidth,
        header: header.clientWidth,
        headerScroll: header.scrollWidth,
      }
    })
    assert.equal(bounds.page, width)
    assert.equal(bounds.scroll, bounds.content, JSON.stringify(bounds))
    assert.equal(bounds.headerScroll, bounds.header, JSON.stringify(bounds))
    const outline = page.locator('.site-outline-mobile')
    await outline.locator('summary').click()
    await outline.getByRole('link', { name: /^usage$/i, exact: true }).click()
    assert.equal(await outline.evaluate((element) => element.open), false)
    await page.waitForFunction(aligned)
    if (width <= 700) {
      await page.getByRole('button', { name: /toggle navigation/i }).click()
      await page.waitForFunction(
        () => document.querySelector('.site-content').inert,
      )
      assert.equal(
        await page
          .getByRole('treeitem', { name: /^welcome$/i, exact: true })
          .evaluate((element) => element.getBoundingClientRect().height),
        44,
      )
      await page.mouse.click(width - 12, 180)
      await page.waitForFunction(
        () =>
          document
            .querySelector('.documentation-site')
            .getAttribute('data-sidebar') === 'false',
      )
      await page.getByRole('button', { name: /toggle navigation/i }).click()
      await page.keyboard.press('Escape')
      await page.waitForFunction(
        () =>
          document
            .querySelector('.documentation-site')
            .getAttribute('data-sidebar') === 'false',
      )
      await page.getByRole('button', { name: /toggle navigation/i }).click()
      await page
        .getByRole('treeitem', { name: /^welcome$/i, exact: true })
        .click()
      await page
        .getByRole('heading', { name: /^welcome$/i, exact: true })
        .waitFor()
      assert.equal(
        await page.locator('.documentation-site').getAttribute('data-sidebar'),
        'false',
      )
      await pagination
        .getByRole('link', { name: /next getting started/i })
        .click()
      await page
        .getByRole('heading', { name: /^getting started$/i, exact: true })
        .waitFor()
      if (width === 390)
        await page.screenshot({ path: 'test-results/documentation-mobile.png' })
    }
  }
  assert.deepEqual(errors, [])
})

test('exported site applies layout options, addon themes, and heading search', {
  timeout: 45000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-site-'))
  const { page } = await openSite(t, folder, {
    name: 'custom site',
    appearance: { mode: 'dark', light: 'vscode-light', dark: 'hibi-dark' },
    pages: [
      { path: 'a.md', markdown: '# alpha\n\n## install steps\n\nrun it.' },
      { path: 'guides/setup.md', markdown: '# setup\n\nconfigure.' },
      { path: 'guides/README.md', markdown: '# guides overview\n\nstart.' },
      { path: 'README.md', markdown: '# welcome\n\nhello.' },
    ],
    options: {
      homePage: 'a.md',
      footer: 'Made with care.',
      contentWidth: 'wide',
      outline: false,
      theme: { mode: 'dark', light: 'vscode-light', dark: 'addon-night' },
    },
    colorschemes: [
      {
        id: 'addon-night',
        name: 'Addon night',
        appearance: 'dark',
        author: 'test',
        license: { name: 'MIT', text: 'MIT License' },
        colors: {
          background: '#101010',
          surface: '#202020',
          ink: '#eeeeee',
          muted: '#aaaaaa',
          accent: '#ff8800',
          border: '#333333',
        },
      },
    ],
    addons: [
      { id: 'demo', name: 'Demo', css: '.site-footer{letter-spacing:3px}' },
    ],
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('heading', { name: /^alpha$/i, exact: true }).waitFor()
  assert.equal(
    await page.locator('html').getAttribute('data-colorscheme'),
    'addon-night',
  )
  const footer = page.locator('.site-footer')
  assert.equal(await footer.innerText(), 'Made with care.')
  assert.equal(
    await footer.evaluate((element) => getComputedStyle(element).letterSpacing),
    '3px',
  )
  assert.equal(await page.locator('.site-outline').count(), 0)
  assert.equal(
    await page
      .locator('.site-document-layout')
      .evaluate((element) => getComputedStyle(element).maxWidth),
    '1380px',
  )
  const tree = page.getByRole('tree')
  await tree
    .getByRole('treeitem', { name: /guides overview/i })
    .first()
    .click()
  assert.deepEqual(await tree.getByRole('treeitem').allInnerTexts(), [
    'alpha',
    'welcome',
    'guides overview',
    'guides overview',
    'setup',
  ])
  const pagination = page.getByRole('navigation', { name: /page navigation/i })
  await page.getByRole('treeitem', { name: /^alpha$/i, exact: true }).click()
  await pagination.getByRole('link', { name: /next welcome/i }).waitFor()
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
  )
  await page.keyboard.type('install')
  await page.getByRole('option', { name: /install steps.*alpha/i }).waitFor()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() =>
    location.hash.includes('anchor=install-steps'),
  )
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/documentation-custom.png' })
  assert.deepEqual(errors, [])
})

it('app and exported site share heading destinations and retain legacy links', {
  timeout: 30000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-heading-anchors-'))
  const texts = ['api_v2', 'title', 'title', 'é 日本語', '!!!', 'apiv2']
  const anchors = ['api_v2', 'title', 'title-1', 'é-日本語', '', 'apiv2-1']
  const html = texts.map((text) => `<h2>${text}</h2>`).join('')
  const { app, page } = await openSite(t, folder, {
    name: 'heading destinations',
    pages: [
      {
        path: 'README.md',
        markdown: texts.map((text) => `## ${text}`).join('\n\n'),
      },
    ],
  })
  await page.locator('.tiptap h2').first().waitFor()
  const desktop = await app.firstWindow()
  desktop.setDefaultTimeout(7000)
  await waitForDocumentEditor(app, desktop)
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const rich = desktop.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  const markdown = `[${anchors.map((anchor, index) => `jump ${index}](#${encodeURIComponent(anchor)})`).join(' [')} [legacy jump](#apiv2)\n\n${texts.map((text) => `## ${text}`).join('\n\n')}`
  if (t.formattedEngine === 'codemirror')
    // Typing over a formatted selection is literal text, so write the source.
    await rich.evaluate((element, markdown) => {
      const view = element.cmTile.root.view
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: markdown },
      })
    }, markdown)
  else
    await rich.evaluate(
      (element, html) => {
        element.editor.commands.setContent(html)
      },
      `<p>${anchors
        .map(
          (anchor, index) =>
            `<a href="#${encodeURIComponent(anchor)}">jump ${index}</a>`,
        )
        .join(' ')} <a href="#apiv2">legacy jump</a></p>${html}`,
    )

  const assertDesktopTarget = async (index) => {
    if (t.formattedEngine === 'tiptap') {
      assert.deepEqual(
        await desktop.evaluate(() => globalThis.headingTargets),
        [index],
      )
      return
    }
    const heading = [...markdown.matchAll(/^## /gm)][index]
    const from = heading.index + heading[0].length
    await waitForAsync(
      desktop,
      (from) =>
        document.querySelector('.rich-pane .cm-content').cmTile.root.view.state
          .selection.main.head === from,
      from,
    )
    assert.equal(
      await rich.evaluate((element, from) => {
        const view = element.cmTile.root.view
        const caret = view.coordsAtPos(from)
        const pane = element.closest('.rich-pane').getBoundingClientRect()
        return (
          !!caret &&
          caret.top >= pane.top - 1 &&
          caret.bottom <= pane.bottom + 1
        )
      }, from),
      true,
      'the requested heading is visible after link activation',
    )
    assert.equal(
      (await desktop.evaluate(() => window.hibi.getDocument())).markdown,
      markdown,
    )
  }

  for (const window of t.formattedEngine === 'tiptap'
    ? [desktop, page]
    : [page])
    await window.evaluate(() => {
      globalThis.headingTargets = []
      HTMLElement.prototype.scrollIntoView = function () {
        const heading = this.closest('h1,h2,h3,h4,h5,h6')
        if (heading)
          globalThis.headingTargets.push(
            [...document.querySelectorAll('.tiptap h2')].indexOf(heading),
          )
      }
    })

  await t.test(
    'site assigns canonical ids without losing legacy ids',
    async () => {
      assert.deepEqual(
        await page
          .locator('.tiptap h2')
          .evaluateAll((headings) => headings.map((heading) => heading.id)),
        anchors.map((anchor) => `doc-${anchor}`),
      )
      for (const [anchor, index] of [
        ['api_v2', 0],
        ['title-1', 2],
        ['apiv2', 0],
        ['apiv2-1', 5],
        ['doc-apiv2', 0],
        ['doc-apiv2-1', 5],
      ]) {
        await page.evaluate((anchor) => {
          globalThis.headingTargets = []
          location.hash = new URLSearchParams({ page: 'README.md', anchor })
        }, anchor)
        await page.waitForFunction(() => globalThis.headingTargets.length > 0)
        assert.equal(
          await page.evaluate(() => globalThis.headingTargets.at(-1)),
          index,
        )
      }
      assert.equal(
        await page
          .locator('[id]')
          .evaluateAll(
            (elements) =>
              new Set(elements.map((element) => element.id)).size ===
              elements.length,
          ),
        true,
      )
    },
  )

  await t.test(
    'app resolves the same canonical and legacy destinations',
    async () => {
      for (const index of [0, 1, 2, 3, 5]) {
        await desktop.evaluate(() => {
          globalThis.headingTargets = []
        })
        await rich
          .getByRole('link', { name: `jump ${index}`, exact: true })
          .click({ modifiers: ['Shift'] })
        await assertDesktopTarget(index)
      }
      await desktop.evaluate(() => {
        globalThis.headingTargets = []
      })
      await rich
        .getByRole('link', { name: 'legacy jump', exact: true })
        .click({ modifiers: ['Shift'] })
      await assertDesktopTarget(0)
    },
  )
})

test('outline scroll tracking reads nearby geometry on a thousand-heading page', {
  timeout: 45000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-site-outline-scale-'))
  const { page } = await openSite(t, folder, {
    name: 'outline scale',
    pages: [
      {
        path: 'README.md',
        markdown:
          '# Top\n\n' +
          Array.from(
            { length: 1000 },
            (_, i) => `## Section ${i}\n\nsection text\n\n`,
          ).join(''),
      },
    ],
  })
  await page.getByRole('button', { name: /^toggle navigation$/i }).waitFor()
  await page.evaluate(() => {
    window.headingRectReads = 0
    const rect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (...args) {
      if (this.matches('article h2')) window.headingRectReads++
      return rect.apply(this, args)
    }
    const scroller = document.querySelector('.site-content')
    const heading = document.getElementById('doc-section-900')
    scroller.scrollTop +=
      heading.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      24
  })
  await page
    .locator('.site-outline a[aria-current="location"]')
    .filter({ hasText: /^Section 900$/ })
    .waitFor()
  assert.ok((await page.evaluate(() => window.headingRectReads)) <= 4)
  await page.evaluate(() => {
    document.querySelector('.site-content').scrollTop = 0
  })
  await page
    .locator('.site-outline a[aria-current="location"]')
    .filter({ hasText: /^Section 0$/ })
    .waitFor()
  assert.ok((await page.evaluate(() => window.headingRectReads)) <= 4)
})
