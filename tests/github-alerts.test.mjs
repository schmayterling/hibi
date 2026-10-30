import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { Marked } from 'marked'
import { exportOptions } from '../src/addons/documentation/options.ts'
import { prepareSite, siteFiles } from '../src/addons/documentation/site.ts'
import {
  alertMarkdown,
  alertToken,
  alertTypes,
} from '../src/addons/markdown/alerts.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  testFormattedEngines as it,
  selectFormattedEngine,
} from './formatted-engine.mjs'
import {
  pressShortcut,
  replaceRichText,
  replaceSourceText,
} from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('Markdown callouts preserve quote boundaries, titles and fold markers', () => {
  const parser = new Marked(alertMarkdown)
  for (const type of alertTypes) {
    const source = `> [!${type.toUpperCase()}]\n> **hello**\ncontinued\n>\n> - first\n> - second\n\nafter`
    const token = alertToken(source)
    assert.equal(token.alertType, type)
    assert.ok(!token.raw.includes('after'))
    const html = parser.parse(source)
    assert.match(html, new RegExp(`data-alert="${type}"`))
    assert.match(html, /<strong>hello<\/strong>\ncontinued/)
    assert.match(html, /<ul>/)
    assert.match(html, /<\/blockquote>\n<p>after<\/p>/)
    assert.ok(!html.includes('[!'))
  }
  for (const source of [
    '> ordinary quote',
    '> [!WARNING',
    '```md\n> [!WARNING]\n> hello\n```',
  ])
    assert.ok(!parser.parse(source).includes('data-alert='))
  assert.match(parser.parse('> [!NOTE]'), /data-alert="note"/)
  assert.match(
    parser.parse('> [!QUESTION]- Custom title\n> Answer'),
    /data-alert="question"/,
  )
  assert.match(
    parser.parse('> [!QUESTION]- Custom title\n> Answer'),
    /data-fold="-"/,
  )
  assert.match(
    parser.parse('> [!QUESTION]- Custom title\n> Answer'),
    /Custom title/,
  )
})

test('github alert markers survive sanitized site export', async () => {
  const markdown = '> [!WARNING]- Custom title\n> Stay alert.'
  const parser = new Marked(alertMarkdown)
  const rendered = parser.parse(markdown)
  const site = prepareSite(
    {
      name: 'Notes',
      pages: [{ path: 'README.md', markdown, html: rendered }],
    },
    exportOptions(),
  )
  assert.match(site.pages[0].html, /data-alert="warning"/)
  assert.match(site.pages[0].html, /data-fold="-"/)
  const template = await readFile('out/site/template.html', 'utf8')
  const files = await siteFiles(template, site)
  const article = files
    .get('index.html')
    .match(/<article class="tiptap">([\s\S]*?)<\/article>/)?.[1]
  assert.match(article, /class="github-alert"/)
  assert.match(article, /data-alert="warning"/)
  assert.match(article, /data-fold="-"/)
  const hostile = prepareSite(
    {
      name: 'Notes',
      pages: [
        {
          path: 'README.md',
          markdown,
          html: '<blockquote class="github-alert" data-alert="<script>" data-fold="x" onmouseover="window.attack=true">fake</blockquote>',
        },
      ],
    },
    exportOptions(),
  )
  assert.doesNotMatch(hostile.pages[0].html, /data-alert|data-fold|onmouseover/)
})

test('foldable callouts survive sanitized site export as disclosures', () => {
  const page = (html) =>
    prepareSite(
      { name: 'Notes', pages: [{ path: 'README.md', markdown: '', html }] },
      exportOptions(),
    ).pages[0].html
  const html = page(
    [
      '<details class="github-alert" data-alert="tip" data-fold="-"><summary class="github-alert-title">Closed tip</summary><div class="github-alert-body"><p>Hidden body.</p></div></details>',
      '<details class="github-alert" data-alert="note" data-fold="+" open=""><summary class="github-alert-title">Open note</summary><div class="github-alert-body"><p>Shown body.</p></div></details>',
    ].join('\n'),
  )
  assert.match(
    html,
    /<details class="github-alert" data-alert="tip" data-fold="-"><summary class="github-alert-title">Closed tip<\/summary>/,
  )
  assert.match(
    html,
    /<details class="github-alert" open data-alert="note" data-fold="\+"><summary class="github-alert-title">Open note<\/summary>/,
  )
  const hostile = page(
    '<details class="github-alert" data-alert="<script>" data-fold="x" ontoggle="window.attack=true" open>fake</details>',
  )
  assert.doesNotMatch(hostile, /data-alert|data-fold|ontoggle/)
  assert.match(hostile, /<details class="github-alert" open/)
})

test('workspace HTML export shows foldable callouts as disclosures, open for +', {
  timeout: 60000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-alert-folds-'))
  const root = join(temp, 'notes')
  await mkdir(root)
  const output = join(temp, 'doc.html')
  await writeFile(
    join(root, 'folds.md'),
    [
      '> [!TIP]- Closed tip',
      '> Hidden tip body.',
      '',
      '> [!NOTE]+ Open note',
      '> Shown note body.',
      '>',
      '> > [!WARNING]- Nested warning',
      '> > Nested warning body.',
      '',
      '> [!CAUTION] Fixed caution',
      '> Fixed caution body.',
      '',
    ].join('\n'),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  await waitForDocumentEditor(app, page)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await app.evaluate(
    ({ dialog }, { root, output }) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [root],
      })
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: output,
      })
      dialog.showMessageBox = async () => ({ response: 1 })
    },
    { root, output },
  )
  await pressShortcut(app, `${mod}+Shift+o`)
  await page.getByRole('button', { name: /new workspace file/i }).waitFor()
  await pressShortcut(app, `${mod}+k`)
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('export workspace to html')
  await page.getByRole('option').first().click()
  await page
    .getByRole('dialog', { name: /^export workspace$/i })
    .getByRole('button', { name: /^export$/i })
    .click()
  await page.getByText(/exported 1 page\b/i).waitFor()
  const next = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, output) => {
    const window = new BrowserWindow({
      show: false,
      focusable: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    void window.loadFile(output)
  }, output)
  const site = await next
  const callout = (type) => site.locator(`.github-alert[data-alert="${type}"]`)
  await callout('tip').waitFor({ state: 'attached' })
  const shape = (type) =>
    callout(type).evaluate((element) => ({
      tag: element.localName,
      open: element.open ?? null,
      title: element.querySelector(':scope > .github-alert-title')?.localName,
      bar: getComputedStyle(element).borderLeftWidth,
    }))
  assert.deepEqual(await shape('tip'), {
    tag: 'details',
    open: false,
    title: 'summary',
    bar: '3px',
  })
  assert.deepEqual(await shape('note'), {
    tag: 'details',
    open: true,
    title: 'summary',
    bar: '3px',
  })
  assert.deepEqual(await shape('warning'), {
    tag: 'details',
    open: false,
    title: 'summary',
    bar: '3px',
  })
  assert.deepEqual(await shape('caution'), {
    tag: 'blockquote',
    open: null,
    title: 'p',
    bar: '3px',
  })
  const shown = (text) => site.getByText(text, { exact: true }).isVisible()
  assert.equal(await shown('Hidden tip body.'), false)
  assert.equal(await shown('Shown note body.'), true)
  assert.equal(await shown('Nested warning body.'), false)
  assert.equal(await shown('Fixed caution body.'), true)
  // A print shows what folds.
  await site.emulateMedia({ media: 'print' })
  assert.equal(await shown('Hidden tip body.'), true)
  assert.equal(await shown('Nested warning body.'), true)
  assert.equal(
    await callout('tip')
      .locator('summary')
      .evaluate((summary) => getComputedStyle(summary).listStyleType),
    'none',
  )
  await site.emulateMedia({ media: 'screen' })
  await callout('tip').locator('summary').click()
  assert.equal(await shown('Hidden tip body.'), true)
  await site.close()
})

it('github alerts edit in rich view, preview in split, and export with markers and theme colors', {
  timeout: 45000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-alerts-'))
  const root = join(temp, 'notes')
  await mkdir(root)
  const file = join(root, 'alerts.md'),
    output = join(temp, 'doc.html')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
  })
  let cdp
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await cdp?.detach()
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine)
  const cm = t.formattedEngine === 'codemirror'
  if (cm) {
    cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  }
  page.setDefaultTimeout(6500)
  const errors = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error('Renderer error:', error.stack)
  })
  page.on('console', (message) => {
    if (message.type() === 'error')
      console.error('Renderer console:', message.text())
  })
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const read = () =>
    page.evaluate(async () => (await window.hibi.getDocument()).markdown)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  await rich.pressSequentially('> [!WARNING]')
  await rich.press('Enter')
  await rich
    .locator(cm ? '.hibi-lp-alert-warning' : '[data-alert="warning"]')
    .first()
    .waitFor()
  await rich.pressSequentially('typed body')
  assert.match(await read(), /> \[!WARNING\]\n> typed body/)
  await pressShortcut(app, `${mod}+Shift+]`)
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  const initial = alertTypes
    .map(
      (type) =>
        `> [!${type.toUpperCase()}]\n> **hello ${type}**\n>\n> - first\n> - second`,
    )
    .join('\n\n')
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(page, source, initial)
  await pressShortcut(app, `${mod}+Shift+\\`)
  await page.waitForFunction(
    (cm) =>
      document.querySelectorAll(
        cm ? '.rich-pane .hibi-lp-alert-title' : '.tiptap .github-alert',
      ).length === 5,
    cm,
  )
  assert.equal(await read(), initial)
  await page
    .locator('[data-status-id="flavor"]')
    .filter({ hasText: /github markdown/i })
    .waitFor()
  const warning = rich.locator(
    cm ? '.cm-line.hibi-lp-alert-warning' : '[data-alert="warning"]',
  )
  assert.equal(
    await warning.locator(cm ? '.hibi-lp-strong' : 'strong').innerText(),
    'hello warning',
  )
  assert.equal(
    cm
      ? await warning.and(rich.locator('.hibi-lp-list-item')).count()
      : await warning.locator('li').count(),
    2,
  )
  assert.equal(
    await warning
      .first()
      .evaluate(
        (element, cm) =>
          cm
            ? getComputedStyle(element, '::before')
                .backgroundSize.split(',')[0]
                .trim()
                .split(' ')[0]
            : getComputedStyle(element).borderLeftWidth,
        cm,
      ),
    '3px',
  )
  // Accepted difference: the codemirror split pane stays editable; the rich editor previews read-only.
  assert.equal(
    await rich.getAttribute('contenteditable'),
    cm ? 'true' : 'false',
  )
  await pressShortcut(app, `${mod}+Shift+[`)
  if (cm) await rich.and(page.locator('[contenteditable="true"]')).waitFor()
  else
    await page.waitForFunction(
      () => document.querySelector('.tiptap')?.editor?.isEditable,
    )
  if (cm) {
    await rich.evaluate((element) => {
      const view = element.cmTile.root.view
      const text = '**hello warning**'
      const from = view.state.doc.toString().indexOf(text)
      if (from < 0) throw new Error('The warning fixture is not in the editor.')
      view.dispatch({ selection: { anchor: from, head: from + text.length } })
      view.focus()
    })
    await page.keyboard.insertText('edited warning')
  } else
    await replaceRichText(
      page,
      warning.locator('.github-alert-body > p'),
      'edited warning',
    )
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('edited warning'),
  )
  const edited = await read()
  for (const type of alertTypes)
    assert.ok(edited.includes(`[!${type.toUpperCase()}]`))
  await pressShortcut(app, `${mod}+Shift+\\`)
  await page.waitForFunction(
    (cm) =>
      (cm || document.querySelector('.tiptap')?.editor?.isEditable === false) &&
      document
        .querySelector('.source-pane .cm-content')
        ?.textContent.includes('edited warning'),
    cm,
  )
  if (cm)
    assert.match((await warning.allTextContents()).join('\n'), /edited warning/)
  else
    assert.equal(
      await warning.locator('.github-alert-body > p').innerText(),
      'edited warning',
    )
  await app.evaluate(
    ({ dialog }, { root, file, output }) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [root],
      })
      dialog.showSaveDialog = async (_window, options) => ({
        canceled: false,
        filePath:
          options.filters[0].extensions.length === 1 &&
          options.filters[0].extensions.includes('html')
            ? output
            : file,
      })
      dialog.showMessageBox = async () => ({ response: 1 })
    },
    { root, file, output },
  )
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  await page.waitForFunction(() =>
    document
      .querySelector('.document-name')
      ?.textContent?.includes('alerts.md'),
  )
  assert.equal(await readFile(file, 'utf8'), edited)
  await pressShortcut(app, `${mod}+Shift+o`)
  await page.getByRole('button', { name: /new workspace file/i }).waitFor()
  await pressShortcut(app, `${mod}+k`)
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('export workspace to html')
  await page.getByRole('option').first().click()
  await page
    .getByRole('dialog', { name: /^export workspace$/i })
    .getByRole('button', { name: /^export$/i })
    .click()
  await page.getByText(/exported 1 page\b/i).waitFor()
  const next = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, output) => {
    const window = new BrowserWindow({
      show: false,
      focusable: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    void window.loadFile(output)
  }, output)
  const site = await next
  await site.locator('[data-alert="warning"]').waitFor()
  assert.equal(await site.locator('.github-alert').count(), 5)
  assert.equal(
    await site
      .locator('[data-alert="warning"]')
      .evaluate((element) => getComputedStyle(element).borderLeftWidth),
    '3px',
  )
  assert.match(
    await site.locator('[data-alert="warning"]').innerText(),
    /edited warning/,
  )
  await site.close()
  assert.equal(await read(), edited)
  await rich
    .locator(cm ? '.hibi-lp-alert-warning' : '[data-alert="warning"]')
    .first()
    .waitFor()
  assert.deepEqual(errors, [])
})
