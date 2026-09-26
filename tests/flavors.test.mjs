import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { mathFlavor } from '../src/addons/math/syntax.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('math detection respects code, escaped delimiters, and currency spacing', () => {
  for (const source of ['$x^2$', '$$\nx^2\n$$', '$2+2$'])
    assert.equal(mathFlavor.detect(source), true)
  for (const source of [
    '`$x$`',
    '```tex\n$x$\n```',
    '\\$x$',
    'costs $5 and $10',
    '$ incomplete',
  ])
    assert.equal(mathFlavor.detect(source), false)
})

test('flavors auto-detect, persist overrides, render/edit math, and export it offline', {
  timeout: 45000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-flavors-')),
    root = join(temp, 'notes')
  await mkdir(root)
  const file = join(root, 'math.md'),
    output = join(temp, 'docs.html')
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
  await app.evaluate(
    ({ dialog }, { file, root, output }) => {
      dialog.showOpenDialog = async (_window, options) => ({
        canceled: false,
        filePaths: [options.properties.includes('openDirectory') ? root : file],
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
    { file, root, output },
  )
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const choose = async (query) => {
    await pressShortcut(app, `${mod}+k`)
    const input = page.getByRole('combobox', { name: /search commands/i })
    await input.fill(query)
    await page.getByRole('option').first().waitFor()
    await input.press('Enter')
    await page
      .getByRole('dialog', { name: /command palette/i })
      .waitFor({ state: 'hidden' })
  }
  await waitForDocumentEditor(app, page)
  await pressShortcut(app, `${mod}+Shift+]`)
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  const initial =
    '# math\n\ninline $x^2$\n\n$$\n\\frac{1}{2}\n$$\n\n`$literal$`\n\n```javascript\nconst answer = 42\n```'
  const hiddenText = await page.locator('.tiptap').textContent()
  await source.fill(initial)
  await page
    .locator('.source-pane .hibi-token-keyword')
    .filter({ hasText: /const/i })
    .waitFor()
  await page
    .locator('[data-status-id="flavor"]')
    .filter({ hasText: /math/i })
    .waitFor()
  assert.equal(
    await page.locator('.tiptap').textContent(),
    hiddenText,
    'source typing must not refresh the hidden rich document',
  )
  assert.equal(await page.locator('.tiptap .katex').count(), 0)
  await choose('enable latex')
  // Enabling a flavor does not parse the hidden rich document in source view.
  await pressShortcut(app, `${mod}+Shift+[`)
  await page.waitForFunction(
    () => document.querySelectorAll('.tiptap .katex').length === 2,
  )
  const fonts = await page.evaluate(async () => {
    const main = await document.fonts.load('16px KaTeX_Main')
    const math = await document.fonts.load('italic 16px KaTeX_Math')
    return {
      main: main.length,
      math: math.length,
      family: getComputedStyle(document.querySelector('.katex')).fontFamily,
    }
  })
  assert.ok(
    fonts.main > 0 && fonts.math > 0,
    'math fonts must be declared and load locally',
  )
  assert.match(fonts.family, /KaTeX_Main/)
  await page.waitForFunction(() => document.fonts.check('16px KaTeX_Main'))
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    initial,
  )
  await page
    .locator('.rich-pane .hibi-token-keyword')
    .filter({ hasText: /const/i })
    .waitFor()
  await page.locator('[data-type="inline-math"]').click()
  const dialog = page.getByRole('dialog', { name: /^math$/i, exact: true })
  await dialog.getByLabel(/^latex$/i, { exact: true }).fill('x^3')
  await dialog.getByRole('button', { name: /^apply$/i, exact: true }).click()
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('$x^3$'),
  )
  await choose('use github markdown flavor')
  await page.evaluate(() => {
    window.beforeSaveEditor = document.querySelector('.tiptap')
  })
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  await page.waitForFunction(
    () => document.querySelector('.app').getAttribute('aria-busy') === 'false',
  )
  assert.equal(
    await page.evaluate(
      () => window.beforeSaveEditor === document.querySelector('.tiptap'),
    ),
    true,
  )
  const saved = await readFile(file, 'utf8')
  await pressShortcut(app, `${mod}+Shift+o`)
  await page.getByRole('button', { name: /new workspace file/i }).waitFor()
  await choose('export workspace to html')
  await page
    .getByRole('dialog', { name: /^export workspace$/i })
    .getByRole('button', { name: /^export$/i })
    .click()
  await page.getByText(/exported 1 page\b/i).waitFor()
  const html = await readFile(output, 'utf8')
  assert.match(html, /Khan Academy/)
  assert.match(html, /data:font\/woff2;base64/)
  const nextWindow = app.waitForEvent('window')
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
  const site = await nextWindow
  const external = []
  site.on('request', (request) => {
    if (/^https?:/.test(request.url())) external.push(request.url())
  })
  await site.locator('.katex').first().waitFor()
  assert.equal(await site.locator('.katex').count(), 2)
  assert.ok(
    await site.evaluate(
      async () =>
        (await document.fonts.load('italic 16px KaTeX_Math')).length > 0,
    ),
  )
  assert.match(
    await site
      .locator('.katex')
      .first()
      .evaluate((element) => getComputedStyle(element).fontFamily),
    /KaTeX_Main/,
  )
  assert.equal(
    await site.locator('pre .hibi-token-keyword').innerText(),
    'const',
  )
  assert.equal(await site.locator('pre .hibi-token-number').innerText(), '42')
  assert.deepEqual(external, [])
  await site.close()
  await page.locator('[data-status-id="flavor"]').click()
  const picker = page.getByRole('dialog', {
    name: /^markdown flavor$/i,
    exact: true,
  })
  await picker.getByLabel(/^detect extra syntax$/i, { exact: true }).uncheck()
  await page.keyboard.press('Escape')
  await picker.waitFor({ state: 'hidden' })
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    saved,
  )
  assert.equal(await page.locator('.tiptap .katex').count(), 0)
  await pressShortcut(app, `${mod}+o`)
  await page.waitForFunction(
    () =>
      document.querySelector('.tiptap')?.getAttribute('contenteditable') ===
      'false',
  )
  assert.equal(await page.locator('.tiptap .katex').count(), 0)
  await choose('automatically detect markdown flavor')
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('.tiptap .katex').length === 2,
    )
  } catch (error) {
    const state = await page.evaluate(async () => ({
      flavor: document.querySelector('[data-status-id="flavor"]')?.textContent,
      mathBlocks: document.querySelectorAll('.tiptap .katex').length,
      editorReady: document
        .querySelector('.tiptap')
        ?.getAttribute('contenteditable'),
      source: (await window.hibi.getDocument()).markdown,
    }))
    throw new Error(
      `Automatic flavor did not render math: ${JSON.stringify(state)}`,
      {
        cause: error,
      },
    )
  }
})
