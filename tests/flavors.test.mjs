import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { mathFlavor } from '../src/addons/math/syntax.ts'
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
  splitTab,
} from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'
import { renameDocument } from './rename.mjs'

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

it('flavors auto-detect, persist overrides, render/edit math, and export it offline', {
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
  const cm = t.formattedEngine === 'codemirror'
  if (cm) {
    await page.waitForURL('app://hibi/', { waitUntil: 'commit' })
    await page.evaluate(() => localStorage.setItem('markdown-markers', 'false'))
  }
  await selectFormattedEngine(app, page, t.formattedEngine)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
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
    '# math\n\ninline $x^2$\n\ntext $$x$$\n\ntext $$x$$ more\n\n$$\n\\frac{1}{2}\n$$\n\n`$literal$`\n\n```javascript\nconst answer = 42\n```'
  const hiddenText = await page
    .locator('.rich-pane [aria-label="Document editor"]')
    .textContent()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(page, source, initial)
  await page
    .locator('.source-pane .hibi-token-keyword')
    .filter({ hasText: /const/i })
    .waitFor()
  await page
    .locator('[data-status-id="flavor"]')
    .filter({ hasText: /math/i })
    .waitFor()
  await t.test(
    'source typing does not refresh the hidden formatted document',
    async () => {
      assert.equal(
        await page
          .locator('.rich-pane [aria-label="Document editor"]')
          .textContent(),
        hiddenText,
        'source typing must not refresh the hidden rich document',
      )
    },
  )
  await t.test('source typing does not render hidden math', async () => {
    assert.equal(
      await page
        .locator('.rich-pane [aria-label="Document editor"] .katex')
        .count(),
      0,
    )
  })
  await choose('enable latex')
  // Enabling a flavor does not parse the hidden rich document in source view.
  await pressShortcut(app, `${mod}+Shift+[`)
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '.rich-pane [aria-label="Document editor"] .katex',
      ).length === 2,
  )
  assert.equal(
    await page
      .locator('.rich-pane [aria-label="Document editor"] .katex-display')
      .count(),
    1,
  )
  for (const text of ['text $$x$$', 'text $$x$$ more'])
    assert.equal(
      await page
        .locator('.rich-pane [aria-label="Document editor"] :is(p, .cm-line)')
        .getByText(text, { exact: true })
        .textContent(),
      text,
    )
  assert.equal(
    await page.locator('[data-type="inline-math"] .katex-display').count(),
    0,
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
  await t.test(
    'formatted flavor renders code syntax highlighting',
    async () => {
      await page
        .locator('.rich-pane .hibi-token-keyword')
        .filter({ hasText: /const/i })
        .waitFor()
    },
  )
  await waitForDocumentEditor(app, page)
  if (cm)
    await page
      .locator('[data-type="inline-math"] button[aria-label="Edit equation"]')
      .click()
  else await page.locator('[data-type="inline-math"]').click()
  const dialog = page.getByRole('dialog', { name: /^math$/i, exact: true })
  await dialog.getByLabel(/^latex$/i, { exact: true }).fill('x^3')
  await dialog.getByRole('button', { name: /^apply$/i, exact: true }).click()
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('$x^3$'),
  )
  await choose('use github markdown flavor')
  await page.evaluate(() => {
    window.beforeSaveEditor = document.querySelector(
      '.rich-pane [aria-label="Document editor"]',
    )
  })
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  await page.waitForFunction(
    () => document.querySelector('.app').getAttribute('aria-busy') === 'false',
  )
  assert.equal(
    await page.evaluate(
      () =>
        window.beforeSaveEditor ===
        document.querySelector('.rich-pane [aria-label="Document editor"]'),
    ),
    true,
  )
  const saved = await readFile(file, 'utf8')
  assert.equal(saved, initial.replace('$x^2$', '$x^3$'))
  // Saving the draft to a file keeps its flavor choice under the new document id.
  assert.equal(
    await page.evaluate(
      async () =>
        JSON.parse(
          localStorage.getItem(
            `hibi:flavor:${(await window.hibi.getDocument()).id}`,
          ),
        ).dialect,
    ),
    'markdown.github',
  )
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
  assert.equal(
    await page
      .locator('.rich-pane [aria-label="Document editor"] .katex')
      .count(),
    0,
  )
  await pressShortcut(app, `${mod}+o`)
  await page.waitForFunction(
    () =>
      document
        .querySelector('.rich-pane [aria-label="Document editor"]')
        ?.getAttribute('contenteditable') === 'false',
  )
  assert.equal(
    await page
      .locator('.rich-pane [aria-label="Document editor"] .katex')
      .count(),
    0,
  )
  await choose('automatically detect markdown flavor')
  try {
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '.rich-pane [aria-label="Document editor"] .katex',
        ).length === 2,
    )
  } catch (error) {
    const state = await page.evaluate(async () => ({
      flavor: document.querySelector('[data-status-id="flavor"]')?.textContent,
      mathBlocks: document.querySelectorAll(
        '.rich-pane [aria-label="Document editor"] .katex',
      ).length,
      editorReady: document
        .querySelector('.rich-pane [aria-label="Document editor"]')
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

it('math source bytes survive source and visual view round trips and saving', {
  timeout: 45000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-math-source-'))
  const file = join(root, 'math.md')
  const original =
    'anchor\n\ntext $$x$$\n\ntext $$x$$ more\n\n\\$$x$$\n\n$$z$$\n\n   $$y$$\n\n$$\nx\n$$\n'.replaceAll(
      '\n',
      '\r\n',
    )
  await writeFile(file, original)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`, file],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const cm = t.formattedEngine === 'codemirror'
  if (cm) {
    await page.waitForURL('app://hibi/', { waitUntil: 'commit' })
    await page.evaluate(() => localStorage.setItem('markdown-markers', 'false'))
  }
  await selectFormattedEngine(app, page, t.formattedEngine)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  page.setDefaultTimeout(7000)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await waitForDocumentEditor(app, page)
  await pressShortcut(app, `${mod}+k`)
  const input = page.getByRole('combobox', { name: /search commands/i })
  await input.fill('enable latex')
  await page.getByRole('option').first().waitFor()
  await input.press('Enter')
  await page
    .getByRole('dialog', { name: /command palette/i })
    .waitFor({ state: 'hidden' })
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '.rich-pane [aria-label="Document editor"] .katex-display',
      ).length === 3,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    original,
  )
  const rich = page.locator('.rich-pane [aria-label="Document editor"]')
  await pressShortcut(app, `${mod}+Shift+]`)
  await page.getByRole('textbox', { name: /markdown editor/i }).waitFor()
  await pressShortcut(app, `${mod}+Shift+[`)
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '.rich-pane [aria-label="Document editor"] .katex-display',
      ).length === 3,
  )
  assert.equal(
    await rich.getByText('$$x$$', { exact: true }).textContent(),
    '$$x$$',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    original,
  )
  const written = (await stat(file)).mtimeMs
  await pressShortcut(app, `${mod}+s`)
  // The document is already clean: wait for the write, then for the editor to
  // leave the save's busy state so the math click is not ignored.
  while ((await stat(file)).mtimeMs === written) await setTimeout(30)
  await page
    .locator(
      '.app[aria-busy="false"] .rich-pane [aria-label="Document editor"][contenteditable="true"]',
    )
    .waitFor()
  assert.equal(await readFile(file, 'utf8'), original)

  if (cm)
    await rich
      .locator('[data-type="block-math"]')
      .first()
      .getByRole('button', { name: 'Edit equation', exact: true })
      .click()
  else await rich.locator('[data-type="block-math"]').first().click()
  const dialog = page.getByRole('dialog', { name: /^math$/i, exact: true })
  await dialog.getByLabel(/^latex$/i, { exact: true }).fill('z+1')
  await dialog.getByRole('button', { name: /^apply$/i, exact: true }).click()
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('z+1'),
  )
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  const saved = await readFile(file, 'utf8')
  assert.equal(
    saved,
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
  )
  await pressShortcut(app, `${mod}+Shift+]`)
  await page.getByRole('textbox', { name: /markdown editor/i }).waitFor()
  await pressShortcut(app, `${mod}+Shift+[`)
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '.rich-pane [aria-label="Document editor"] .katex-display',
      ).length === 3,
  )
  assert.equal(
    await rich.getByText('$$x$$', { exact: true }).textContent(),
    '$$x$$',
  )
})

it('split focus preserves each file flavor', {
  timeout: 45000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-split-flavors-'))
  const files = ['a.md', 'b.md', 'c.md'].map((name) => join(root, name))
  for (const file of files) await writeFile(file, '> [!NOTE]\n> own flavor\n')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const cm = t.formattedEngine === 'codemirror'
  if (cm) {
    await page.waitForURL('app://hibi/', { waitUntil: 'commit' })
    await page.evaluate(() => localStorage.setItem('markdown-markers', 'false'))
  }
  await selectFormattedEngine(app, page, t.formattedEngine)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  page.setDefaultTimeout(7000)
  await waitForDocumentEditor(app, page)
  const open = async (file) => {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      basename(file),
    )
    await page.waitForFunction(
      () =>
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
    )
    return page.evaluate(() => window.hibi.getDocument())
  }
  const selectDialect = async (dialect) => {
    await page.locator('[data-status-id="flavor"]').click()
    const picker = page.getByRole('dialog', {
      name: /^markdown flavor$/i,
      exact: true,
    })
    await picker.getByLabel(/^markdown dialect$/i).selectOption(dialect)
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'hidden' })
  }

  const a = await open(files[0])
  const b = await open(files[1])
  await selectDialect('markdown')
  await splitTab(app, page, a.tabId)
  await page.locator('.editor-page[data-side="right"]').waitFor()
  const c = await open(files[2])
  await selectDialect('markdown.github')
  await page
    .locator(
      cm
        ? '.editor-page[data-side="right"] .hibi-lp-alert-title'
        : '.editor-page[data-side="right"] .github-alert',
    )
    .waitFor()
  await page
    .locator('.editor-page[data-side="left"] .split-tab-heading')
    .click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    b.tabId,
  )
  await page.waitForFunction(
    () => document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
  )
  assert.deepEqual(
    await page.evaluate(
      ({ bId, cId }) => [
        JSON.parse(localStorage.getItem(`hibi:flavor:${bId}`)),
        JSON.parse(localStorage.getItem(`hibi:flavor:${cId}`)),
      ],
      { bId: b.id, cId: c.id },
    ),
    [
      { dialect: 'markdown', syntax: 'auto' },
      { dialect: 'markdown.github', syntax: 'auto' },
    ],
  )
  await page.getByRole('button', { name: 'Close split' }).click()
  await page.waitForFunction(
    () => document.querySelectorAll('.editor-page[data-side]').length === 0,
  )
  assert.equal(
    await page
      .locator(
        cm
          ? '.rich-pane .hibi-lp-alert-title'
          : '.rich-pane [aria-label="Document editor"] .github-alert',
      )
      .count(),
    0,
  )
  const beforeRename = await page.evaluate(() => window.hibi.getDocument())
  await renameDocument(app, page, 'renamed')
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).id !== id,
    beforeRename.id,
  )
  // The renderer copies the flavor choice when it receives the rename reply.
  await page.waitForFunction(
    () => document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
  )
  assert.deepEqual(
    await page.evaluate(async () =>
      JSON.parse(
        localStorage.getItem(
          `hibi:flavor:${(await window.hibi.getDocument()).id}`,
        ),
      ),
    ),
    { dialect: 'markdown', syntax: 'auto' },
  )
})

it('rich editor survives document-only syntax and rebuilds for flavor changes', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-rich-rebuild-'))
  const addon = join(profile, 'installed-addons', 'syntax-probe')
  await mkdir(addon, { recursive: true })
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'syntax-probe',
      name: 'Syntax probe',
      kind: 'extension',
      description: 'Document syntax fixture',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      capabilities: [],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['index.js', 'hibi-addon.json'],
      source: 'local',
    }),
  )
  await writeFile(
    join(addon, 'index.js'),
    'export default () => ({ start(context) { window.syntaxProbe = context.editor } })',
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'syntax-probe': true }),
  )
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
  const cm = t.formattedEngine === 'codemirror'
  if (cm) {
    await page.waitForURL('app://hibi/', { waitUntil: 'commit' })
    await page.evaluate(() => localStorage.setItem('markdown-markers', 'false'))
  }
  await selectFormattedEngine(app, page, t.formattedEngine)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  page.setDefaultTimeout(7000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(() => !!window.syntaxProbe)
  const editor = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await replaceRichText(page, editor, 'Keep this draft.')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'Keep this draft.',
  )
  const checkDraft = async () => {
    await waitForDocumentEditor(app, page)
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      'Keep this draft.',
    )
    assert.equal(await editor.textContent(), 'Keep this draft.')
    assert.equal(await editor.getAttribute('contenteditable'), 'true')
  }
  const sameView = () =>
    page.evaluate(
      () =>
        document.querySelector('.rich-pane .cm-content')?.cmTile.root.view ===
        window.richEditor,
    )
  const remember = () =>
    page.evaluate((cm) => {
      const element = document.querySelector(
        '.rich-pane [aria-label="Document editor"]',
      )
      window.richEditor = cm ? element.cmTile.root.view : element.editor
    }, cm)
  const subscript = async (expected) => {
    if (cm) {
      await page.evaluate(() =>
        window.syntaxProbe.updateMarkdown(() => 'Keep this draft. ~probe~'),
      )
      await waitForAsync(
        page,
        async () =>
          (await window.hibi.getDocument()).markdown ===
          'Keep this draft. ~probe~',
      )
      await page.waitForFunction(
        (expected) =>
          !!document.querySelector('.rich-pane .hibi-lp-subscript') ===
          expected,
        expected,
      )
      await page.evaluate(() =>
        window.syntaxProbe.updateMarkdown(() => 'Keep this draft.'),
      )
      await checkDraft()
      return
    }
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector('.rich-pane [aria-label="Document editor"]')
          ?.editor?.extensionManager.extensions.some(
            (extension) => extension.name === 'subscript',
          ) === expected,
      expected,
    )
  }
  await remember()
  // Format addons such as rst register preview-only syntax after the editor is ready.
  await page.evaluate(async () => {
    window.syntaxProbe.registerDocumentSyntax({
      id: 'preview',
      label: 'Probe preview',
      group: 'Probe',
      level: 'block',
    })
    // React applies store updates in microtasks, so a rebuild lands before this task.
    await new Promise((resolve) => setTimeout(resolve))
  })
  assert.equal(
    cm
      ? await sameView()
      : await page.evaluate(() => !window.richEditor.isDestroyed),
    true,
    'document-only syntax keeps the rich editor',
  )
  if (cm) await checkDraft()
  for (const enabled of [false, true]) {
    await clickMenu(app, 'Settings')
    await page
      .getByRole('tab', { name: /^addon manager$/i, exact: true })
      .click()
    await page.locator('#addon-text-extras').click()
    await page.waitForFunction(
      (enabled) =>
        document.querySelector('#addon-text-extras').checked === enabled,
      enabled,
    )
    await page.getByRole('button', { name: /^back to app$/i }).click()
    if (cm) assert.equal(await sameView(), true)
    else await page.waitForFunction(() => window.richEditor.isDestroyed)
    await subscript(enabled)
    await waitForDocumentEditor(app, page)
    assert.equal(await editor.textContent(), 'Keep this draft.')
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      'Keep this draft.',
    )
    await remember()
  }
  await clickMenu(app, 'Command palette')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette
    .getByRole('combobox', { name: /search commands/i })
    .fill('Use plain Markdown flavor')
  await palette
    .getByRole('option', { name: /Use plain Markdown flavor/i })
    .press('Enter')
  if (cm) {
    await palette.waitFor({ state: 'hidden' })
    await waitForAsync(page, async () => {
      const snapshot = await window.hibi.getDocument()
      const choice = JSON.parse(
        localStorage.getItem(`hibi:flavor:${snapshot.id}`),
      )
      return choice?.dialect === 'markdown' && choice.syntax?.length === 0
    })
    assert.equal(await sameView(), true)
    await subscript(false)
    await checkDraft()
  } else await page.waitForFunction(() => window.richEditor.isDestroyed)
  await waitForDocumentEditor(app, page)
  await remember()
  await page.evaluate(async () => {
    window.syntaxProbe.registerFlavor({
      id: 'unchosen',
      name: 'Unchosen',
      kind: 'syntax',
      description: 'Flavor outside the explicit choice',
      detect: () => false,
    })
    // Two frames cover the store update, the render and the editor effects.
    for (let frame = 0; frame < 2; frame++)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    await new Promise((resolve) => setTimeout(resolve))
  })
  assert.equal(
    cm
      ? await sameView()
      : await page.evaluate(() => !window.richEditor.isDestroyed),
    true,
    'a flavor outside the explicit choice keeps the rich editor',
  )
  if (cm) await checkDraft()
  assert.equal(await editor.textContent(), 'Keep this draft.')
  if (cm) {
    await editor.press('End')
    assert.equal(
      await editor.evaluate((element) => document.activeElement === element),
      true,
    )
    await page.keyboard.insertText('!')
    await waitForAsync(
      page,
      async () =>
        (await window.hibi.getDocument()).markdown === 'Keep this draft.!',
    )
  }
  assert.deepEqual(errors, [])
})
