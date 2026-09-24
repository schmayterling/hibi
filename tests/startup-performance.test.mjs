import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { codeHtml, codeLanguages } from '../src/renderer/src/code-languages.ts'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

test('language loading deduplicates aliases and respects disabled preferences during import', async () => {
  assert.equal(codeLanguages.resolve('rust'), null)
  const [rust, alias] = await Promise.all([
    codeLanguages.ensure('rust'),
    codeLanguages.ensure('rs'),
  ])
  assert.ok(rust)
  assert.equal(rust, alias)
  assert.equal(codeLanguages.resolve('python'), null)
  codeLanguages.setEnabled('python', false)
  await codeLanguages.settle()
  assert.equal(codeLanguages.resolve('py'), null)
  codeLanguages.setEnabled('python', true)
  assert.ok(codeLanguages.resolve('py'))
  assert.match(codeHtml('def sample(): return 1', 'py'), /hibi-token-keyword/)
})

test('production entry keeps rich and source editor implementations behind demand imports', async () => {
  const chunks = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]))
  const reached = new Set()
  const visit = (file) => {
    if (reached.has(file)) return
    reached.add(file)
    for (const dependency of byFile.get(file)?.imports ?? []) visit(dependency)
  }
  for (const chunk of chunks) if (chunk.entry) visit(chunk.file)
  const initial = chunks
    .filter((chunk) => reached.has(chunk.file))
    .flatMap((chunk) => chunk.modules)
    .join('\n')
  assert.doesNotMatch(
    initial,
    /src\/renderer\/src\/(?:Editor|SourceEditor)\.tsx/,
  )
  assert.doesNotMatch(initial, /node_modules\/@tiptap\//)
  assert.ok(
    chunks.some((chunk) =>
      chunk.modules.includes('src/renderer/src/Editor.tsx'),
    ),
  )
  assert.ok(
    chunks.some((chunk) =>
      chunk.modules.includes('src/renderer/src/SourceEditor.tsx'),
    ),
  )
})

test('shared format registration does not statically load source parsers', async () => {
  const chunks = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]))
  const reached = new Set()
  const visit = (file) => {
    if (reached.has(file)) return
    reached.add(file)
    for (const dependency of byFile.get(file)?.imports ?? []) visit(dependency)
  }
  const entry = chunks.find((chunk) =>
    chunk.modules.includes('src/addons/_shared/format-renderer.tsx'),
  )
  assert.ok(entry)
  visit(entry.file)
  const modules = chunks
    .filter((chunk) => reached.has(chunk.file))
    .flatMap((chunk) => chunk.modules)
    .join('\n')
  assert.doesNotMatch(modules, /node_modules\/@codemirror\//)
  assert.doesNotMatch(modules, /src\/addons\/_shared\/format-language\.ts/)
})

test('blank startup leaves disabled runtimes and closed settings unloaded and source unmounted', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-startup-performance-'))
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
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .waitFor()
  await page.evaluate(
    () => new Promise((resolve) => requestIdleCallback(resolve)),
  )
  assert.equal(
    await page.evaluate(() => document.activeElement?.matches('.tiptap')),
    true,
  )
  assert.equal(await page.locator('.cm-editor').count(), 0)
  const chunks = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const session = await page.context().newCDPSession(page)
  const files = new Set()
  session.on('Debugger.scriptParsed', ({ url }) => {
    if (url.startsWith('app://hibi/')) files.add(new URL(url).pathname.slice(1))
  })
  await session.send('Debugger.enable')
  const loadedModules = async () => {
    return chunks
      .filter((chunk) => files.has(chunk.file))
      .flatMap((chunk) => chunk.modules)
      .join('\n')
  }
  const initial = await loadedModules()
  assert.match(initial, /src\/renderer\/src\/main\.tsx/)
  assert.doesNotMatch(
    initial,
    /src\/addons\/(?:math|typst|mdx|graph|git|word-count|block-drag|diagnostics)\/index\./,
  )
  assert.doesNotMatch(
    initial,
    /src\/renderer\/src\/(?:SettingsScreen|VersionHistory)\.tsx/,
  )
  assert.doesNotMatch(initial, /@codemirror\//)
  assert.doesNotMatch(initial, /src\/renderer\/src\/SourceEditor\.tsx/)
  await page.evaluate(() => {
    const editor = document.querySelector('.editor-surface')
    const height = editor.getBoundingClientRect().height
    window.paletteLayout = { resized: false, loading: false }
    window.paletteResize = new ResizeObserver(() => {
      if (editor.getBoundingClientRect().height !== height)
        window.paletteLayout.resized = true
    })
    window.paletteResize.observe(editor)
    window.paletteMutations = new MutationObserver((records) => {
      if (
        records.some((record) =>
          [...record.addedNodes].some(
            (node) => node.nodeType === 1 && node.matches('.loading-screen'),
          ),
        )
      )
        window.paletteLayout.loading = true
    })
    window.paletteMutations.observe(document.querySelector('.app'), {
      childList: true,
    })
  })
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
  )
  const search = page.getByRole('combobox', { name: 'Search commands' })
  await search.waitFor()
  await page
    .locator('.command-palette')
    .evaluate((element) =>
      Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      ),
    )
  assert.deepEqual(
    await page.evaluate(() => {
      window.paletteResize.disconnect()
      window.paletteMutations.disconnect()
      return window.paletteLayout
    }),
    { resized: false, loading: false },
  )
  await search.fill('properties by default')
  await page
    .getByRole('option', { name: /expand properties by default/i })
    .waitFor()
  await search.press('Escape')
  await page.locator('.command-palette').waitFor({ state: 'hidden' })
  await clickMenu(app, 'Settings')
  assert.match(await loadedModules(), /src\/renderer\/src\/SettingsScreen\.tsx/)
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  assert.doesNotMatch(
    await loadedModules(),
    /src\/addons\/(?:math|typst|mdx)\/index\./,
  )
})

test('unrelated enabled formats defer source parsers until first source use', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-startup-formats-'))
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ rst: true, html: true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.waitForFunction(
    () => performance.getEntriesByName('hibi:addon:rst').length,
  )
  const order = await page.evaluate(() => ({
    ready: performance.getEntriesByName('hibi:editing-capabilities')[0]
      ?.startTime,
    format: performance.getEntriesByName('hibi:addon:rst')[0]?.startTime,
    editable:
      document.querySelector('.tiptap')?.isContentEditable &&
      !document.querySelector('.tiptap')?.closest('[inert]'),
  }))
  assert.equal(order.editable, true)
  assert.ok(order.format >= order.ready, JSON.stringify(order))
  await page.waitForFunction(
    () => performance.getEntriesByName('hibi:addon:html').length,
  )
  const chunks = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const session = await page.context().newCDPSession(page)
  const files = new Set()
  session.on('Debugger.scriptParsed', ({ url }) => {
    if (url.startsWith('app://hibi/')) files.add(new URL(url).pathname.slice(1))
  })
  await session.send('Debugger.enable')
  const modules = () =>
    chunks
      .filter((chunk) => files.has(chunk.file))
      .flatMap((chunk) => chunk.modules)
      .join('\n')
  assert.doesNotMatch(
    modules(),
    /src\/addons\/_shared\/format-language\.ts|@codemirror\//,
  )
  const file = join(profile, 'note.html')
  await writeFile(file, '<h1>hello</h1>\r\n')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+o' : 'Control+o',
  )
  await page
    .getByRole('textbox', { name: 'HTML editor', exact: true })
    .waitFor()
  await page.locator('.source-pane .hibi-token-type').first().waitFor()
  assert.match(modules(), /src\/addons\/_shared\/format-language\.ts/)
  assert.match(modules(), /node_modules\/@codemirror\/lang-html\//)
  assert.doesNotMatch(modules(), /node_modules\/@codemirror\/lang-markdown\//)
  assert.doesNotMatch(
    modules(),
    /node_modules\/@codemirror\/legacy-modes\/mode\/(?:stex|textile|r)\./,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '<h1>hello</h1>\r\n',
  )
})
