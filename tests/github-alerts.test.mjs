import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { Marked } from 'marked'
import {
  alertMarkdown,
  alertToken,
  alertTypes,
} from '../src/addons/markdown/alerts.ts'
import { electron } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
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

test('github alerts edit in rich view, preview in split, and export with markers and theme colors', {
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
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
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
  await rich.locator('[data-alert="warning"]').waitFor()
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
  await source.fill(initial)
  await pressShortcut(app, `${mod}+Shift+\\`)
  await page.waitForFunction(
    () => document.querySelectorAll('.tiptap .github-alert').length === 5,
  )
  assert.equal(await read(), initial)
  await page
    .locator('[data-status-id="flavor"]')
    .filter({ hasText: /github markdown/i })
    .waitFor()
  const warning = rich.locator('[data-alert="warning"]')
  assert.equal(await warning.locator('strong').innerText(), 'hello warning')
  assert.equal(await warning.locator('li').count(), 2)
  assert.equal(
    await warning.evaluate(
      (element) => getComputedStyle(element).borderLeftWidth,
    ),
    '3px',
  )
  assert.equal(
    await rich.evaluate((element) => element.editor.isEditable),
    false,
  )
  await pressShortcut(app, `${mod}+Shift+[`)
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.editor?.isEditable,
  )
  await warning.locator('.github-alert-body > p').fill('edited warning')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('edited warning'),
  )
  const edited = await read()
  for (const type of alertTypes)
    assert.ok(edited.includes(`[!${type.toUpperCase()}]`))
  await pressShortcut(app, `${mod}+Shift+\\`)
  await page.waitForFunction(
    () =>
      document.querySelector('.tiptap')?.editor?.isEditable === false &&
      document
        .querySelector('.cm-content')
        ?.textContent.includes('edited warning'),
  )
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
  await rich.locator('[data-alert="warning"]').waitFor()
  assert.deepEqual(errors, [])
})
