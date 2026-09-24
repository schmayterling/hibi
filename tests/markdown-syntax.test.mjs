import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { Marked } from 'marked'
import { alertMarkdown } from '../src/addons/markdown/alerts.ts'
import {
  detectTextExtras,
  textExtrasMarkdown,
} from '../src/addons/text-extras/syntax.ts'
import { markdownSyntax } from '../src/renderer/src/markdown-syntax.ts'
import { installSyntaxPreferences } from '../src/renderer/src/syntax-parser.ts'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut, replaceRichText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'
import { uiName } from './ui.mjs'

test('syntax controls preserve raw tokens in both lexer and export paths', () => {
  const parser = installSyntaxPreferences(
    new Marked({ gfm: true }, alertMarkdown, textExtrasMarkdown),
  )
  const unregister = markdownSyntax.register('test', {
    id: 'alerts',
    label: 'alerts',
    group: 'test',
    level: 'block',
    matches: (token) => token.type === 'githubAlert',
  })
  const source =
    '# one\n\n## two\n\n**bold** and *italic*\n\n> [!WARNING]\n> keep **this**'
  try {
    for (const id of ['core.heading-1', 'core.bold', 'test.alerts'])
      markdownSyntax.setEnabled(id, false)
    const html = parser.parse(source)
    assert.match(html, /hibi-literal-block"># one/)
    assert.match(html, /<h2>two<\/h2>/)
    assert.match(html, /hibi-literal-inline">\*\*bold\*\*/)
    assert.match(html, /<em>italic<\/em>/)
    assert.ok(html.includes('&gt; [!WARNING]\n&gt; keep **this**'))
    const tokens = new parser.Lexer(parser.defaults).lex(source)
    assert.equal(tokens[0].type, 'hibiLiteralBlock')
    assert.equal(tokens.at(-1).type, 'hibiLiteralBlock')
    markdownSyntax.setEnabled('core.bold', true)
    assert.match(parser.parse('**bold**'), /<strong>bold<\/strong>/)
  } finally {
    for (const id of ['core.heading-1', 'core.bold', 'test.alerts'])
      markdownSyntax.setEnabled(id, true)
    unregister()
  }
})

test('subscript and discord small text preserve code, strike, and ordinary text', () => {
  const parser = new Marked({ gfm: true }, textExtrasMarkdown)
  assert.match(
    parser.parse('H~2~O ~~strike~~'),
    /H<sub>2<\/sub>O <del>strike<\/del>/,
  )
  assert.match(
    parser.parse('-# small **text**'),
    /class="markdown-subtext">small <strong>text<\/strong>/,
  )
  assert.equal(detectTextExtras('`~2~`\n\n```md\n-# code\n```'), false)
  assert.equal(detectTextExtras('H~2~O'), true)
  for (const source of [
    '-#no space',
    'before -# ordinary',
    ' ~ bad~',
    '~bad ~',
  ])
    assert.doesNotMatch(parser.parse(source), /<sub>|markdown-subtext/)
})

test('syntax settings preserve edits, update rich formatting, and discover addon features', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-markdown-syntax-'))
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
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  await pressShortcut(app, `${mod}+Shift+]`)
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  const initial =
    '# one\n\n## two\n\n**bold** H~2~O ~~strike~~\n\n-# small **text**\n\n> [!WARNING]\n> hello'
  await source.fill(initial)
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await rich.locator('sub').waitFor()
  assert.equal(
    await rich.locator('.markdown-subtext').innerText(),
    'small text',
  )
  assert.equal(await rich.locator('s').innerText(), 'strike')
  const settings = async () => {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: /^syntax$/i, exact: true }).click()
  }
  await settings()
  for (const name of ['heading 1', 'bold', 'alerts', 'subscript', 'small text'])
    await page
      .getByRole('checkbox', { name: uiName(name, true), exact: true })
      .uncheck()
  await page.waitForFunction(
    () =>
      !document.querySelector(
        '.tiptap h1, .tiptap strong, .tiptap sub, .tiptap .github-alert, .tiptap .markdown-subtext',
      ),
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    initial,
  )
  await page
    .getByRole('button', { name: /^back to app$/i, exact: true })
    .click()
  assert.equal(await rich.locator('h2').innerText(), 'two')
  assert.match(await rich.innerText(), /\*\*bold\*\* H~2~O/)
  assert.equal(await rich.getAttribute('contenteditable'), 'false')
  await pressShortcut(app, `${mod}+Shift+[`)
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.editor?.isEditable,
  )
  await replaceRichText(
    page,
    rich.locator('.hibi-literal-block').filter({ hasText: /# one/i }),
    '# changed',
  )
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('# changed'),
  )
  const edited = (await page.evaluate(() => window.hibi.getDocument())).markdown
  assert.ok(edited.includes('**bold** H~2~O'))
  assert.ok(edited.includes('> [!WARNING]\n> hello'))
  await pressShortcut(app, `${mod}+Shift+\\`)
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.editor?.isEditable === false,
  )
  await settings()
  for (const name of ['heading 1', 'bold', 'alerts', 'subscript', 'small text'])
    await page
      .getByRole('checkbox', { name: uiName(name, true), exact: true })
      .check()
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.locator('#addon-math').click()
  await page.getByRole('tab', { name: /^syntax$/i, exact: true }).click()
  await page
    .getByRole('checkbox', { name: /^inline math$/i, exact: true })
    .waitFor()
  await page
    .getByRole('button', { name: /^back to app$/i, exact: true })
    .click()
  // Schema changes recreate the editor asynchronously; wait for the edited content.
  await rich
    .locator('h1')
    .filter({ hasText: /^changed$/ })
    .waitFor()
    .catch(async (cause) => {
      const state = await page.evaluate(async () => ({
        markdown: (await window.hibi.getDocument()).markdown,
        disabled: localStorage.getItem('hibi:markdown-syntax-disabled'),
        rich: document.querySelector('.tiptap')?.innerHTML,
      }))
      throw new Error(`syntax did not settle: ${JSON.stringify(state)}`, {
        cause,
      })
    })
  assert.equal(
    await rich.locator('h1').innerText(),
    'changed',
    JSON.stringify({
      main: (await page.evaluate(() => window.hibi.getDocument())).markdown,
      source: await source.innerText(),
    }),
  )
  assert.equal(await rich.locator('sub').innerText(), '2')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    edited,
  )
  await settings()
  await page.getByRole('checkbox', { name: /^bold$/i, exact: true }).click()
  await page.reload()
  await settings()
  assert.equal(
    await page
      .getByRole('checkbox', { name: /^bold$/i, exact: true })
      .isChecked(),
    false,
  )
  await page.getByRole('checkbox', { name: /^bold$/i, exact: true }).click()
  await page
    .getByRole('button', { name: /^back to app$/i, exact: true })
    .click()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    edited,
  )
  await pressShortcut(app, `${mod}+Shift+[`)
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.editor?.isEditable,
  )
  // Keep the detected flavor present while exercising rich input rules.
  // Set the editor selection directly; DOM selection changes are asynchronous.
  await rich.evaluate((element) => {
    element.editor.commands.focus('end')
  })
  await rich.press('Enter')
  await rich.press('Enter')
  await rich.pressSequentially('H~3~O')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('H~3~O'),
  )
  await rich.press('Enter')
  await rich.pressSequentially('-# typed small')
  await rich
    .locator('.markdown-subtext')
    .filter({ hasText: /typed small/i })
    .waitFor()
  await rich.press('Enter')
  await rich.pressSequentially('normal again')
  assert.equal(await rich.locator('p').last().innerText(), 'normal again')
  assert.deepEqual(errors, [])
})
