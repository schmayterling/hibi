import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { codeHtml, codeLanguages } from '../src/renderer/src/code-languages.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

test('language loading deduplicates aliases and respects disabled preferences during import', async (t) => {
  const changes = []
  t.after(
    codeLanguages.subscribe((names) => {
      if (names.size) changes.push([...names].sort())
    }),
  )
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
  // Arrivals name only the changed language; a parser loaded while disabled publishes nothing.
  assert.deepEqual(changes, [
    ['rs', 'rust'],
    ['py', 'python'],
  ])
  codeLanguages.setEnabled('python', true)
  assert.ok(codeLanguages.resolve('py'))
  assert.deepEqual(changes.at(-1), ['py', 'python'])
  assert.match(codeHtml('def sample(): return 1', 'py'), /hibi-token-keyword/)
})

test('production entry keeps editor implementations behind demand imports', async () => {
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
    /src\/renderer\/src\/(?:Editor|SourceEditor|FormatEditor)\.tsx/,
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
  assert.ok(
    chunks.some((chunk) =>
      chunk.modules.includes('src/renderer/src/FormatEditor.tsx'),
    ),
  )
})

test('startup catalog stays within the main byte budget and leaves notices and authors lazy', async () => {
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
  const initial = chunks.filter((chunk) => reached.has(chunk.file))
  // Catalog baseline: 689137 bytes, plus 318 bytes for declarative styles/themes (#218).
  const bytes = initial.reduce((sum, chunk) => sum + chunk.bytes, 0)
  assert.ok(bytes <= 689455, `startup catalog grew to ${bytes} bytes`)
  const modules = initial.flatMap((chunk) => chunk.modules).join('\n')
  assert.doesNotMatch(
    modules,
    /addons\/authors\.ts|addons\/[^/]+\/(?:manifest\.ts|hibi-addon\.json)|docs\/licenses\//,
  )
  assert.doesNotMatch(
    modules,
    /addons\/[^/]+\/(?:index\.(?:tsx?|m?js)|Settings\.tsx|[^/]+\.md)|addons\/sdk(?:\.ts|-ui\.ts)|hibi-addon-catalog\/details|@codemirror\//,
  )
  assert.doesNotMatch(
    chunks.flatMap((chunk) => chunk.modules).join('\n'),
    /src\/(?:user)?addons\/[^/]+\/native\.tsx?/,
  )
  assert.doesNotMatch(modules, /src\/renderer\/src\/window-desktop\.ts/)
  assert.ok(
    chunks.some(
      (chunk) =>
        !reached.has(chunk.file) &&
        chunk.modules.includes('src/renderer/src/window-desktop.ts'),
    ),
  )
  const code = (
    await Promise.all(
      // Vite discards the report's empty javascript facades for css-only chunks.
      initial
        .filter((chunk) => chunk.bytes > 1)
        .map((chunk) => readFile(join('out/renderer', chunk.file), 'utf8')),
    )
  ).join('\n')
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: resolve('.'),
    server: { middlewareMode: true },
    appType: 'custom',
  })
  try {
    const { readAddonPackages } = await server.ssrLoadModule(
      '/scripts/addon-packages.ts',
    )
    const packages = await readAddonPackages()
    let notices = 0
    for (const { manifest } of packages) {
      for (const author of manifest.authors ?? [])
        for (const identity of [author.discordId, author.github].filter(
          Boolean,
        ))
          assert.equal(
            code.includes(identity),
            false,
            `startup contains author details: ${manifest.id}`,
          )
      for (const license of manifest.licenses ?? []) {
        const lines = license.text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length >= 40)
        assert.ok(
          lines.length,
          `missing notice probe: ${manifest.id}/${license.id}`,
        )
        assert.equal(
          lines.every(
            (line) =>
              code.includes(line) ||
              code.includes(JSON.stringify(line).slice(1, -1)),
          ),
          false,
          `startup contains bundled license text: ${manifest.id}/${license.id}`,
        )
        notices++
      }
    }
    assert.ok(notices > 0)
  } finally {
    await server.close()
  }
  assert.ok(
    chunks.some((chunk) =>
      chunk.modules.some((module) =>
        module.includes('hibi-addon-catalog/details'),
      ),
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
  assert.doesNotMatch(initial, /hibi-addon-catalog\/details/)
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
  assert.doesNotMatch(initial, /src\/renderer\/src\/FormatEditor\.tsx/)
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
  await page
    .locator('.addon-list [data-discord-id="297656178358616064"]')
    .waitFor()
  assert.match(await loadedModules(), /hibi-addon-catalog\/details/)
  await page
    .getByRole('searchbox', { name: 'Filter addons', exact: true })
    .fill('angelo')
  await page.getByRole('checkbox', { name: 'Vim', exact: true }).waitFor()
  assert.doesNotMatch(await loadedModules(), /src\/addons\/vim\/index\./)
  assert.doesNotMatch(
    await loadedModules(),
    /src\/addons\/(?:math|typst|mdx)\/index\./,
  )
})

test('default diagrams start with markdown documents and load pele only for a diagram', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-startup-mermaid-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
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
  const chunks = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const session = await page.context().newCDPSession(page)
  const files = new Set()
  session.on('Debugger.scriptParsed', ({ url }) => {
    if (url.startsWith('app://hibi/')) files.add(new URL(url).pathname.slice(1))
  })
  await session.send('Debugger.enable')
  const loaded = () =>
    chunks
      .filter((chunk) => files.has(chunk.file))
      .flatMap((chunk) => chunk.modules)
  assert.match(loaded().join('\n'), /src\/addons\/mermaid\/index\.tsx/)
  assert.doesNotMatch(
    loaded().join('\n'),
    /node_modules\/(?:pele|mermaid|@mermaid-js)\/|@codemirror\//,
  )
  const note = join(profile, 'diagram.md')
  await writeFile(note, '```mermaid\nflowchart LR\n  A --> B\n```\n')
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, note)
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+o' : 'Control+o',
  )
  await page.locator('.mermaid-block .mermaid-diagram > svg').waitFor()
  // Pele's core loads with the first diagram; other diagram types stay unloaded.
  const pele = chunks
    .flatMap((chunk) => chunk.modules)
    .filter((module) => module.includes('node_modules/pele/'))
  const loadedPele = loaded().filter((module) =>
    module.includes('node_modules/pele/'),
  )
  assert.ok(loadedPele.some((module) => module.endsWith('/esm/lazy.js')))
  assert.ok(
    loadedPele.length < pele.length / 2,
    `${loadedPele.length} of ${pele.length} pele modules loaded`,
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
  }))
  assert.ok(order.format >= order.ready, JSON.stringify(order))
  // Formats start from an idle callback that can run before the editor
  // commits its editable state, so wait for that state instead of sampling it.
  await waitForDocumentEditor(app, page)
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
