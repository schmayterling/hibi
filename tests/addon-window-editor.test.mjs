import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { electron } from './electron.mjs'

test('addon window boot code loads no addon module before taking the bridge', async () => {
  const chunks = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]))
  const entry = chunks.find((chunk) =>
    chunk.modules.includes('src/renderer/src/addon-window.tsx'),
  )
  assert.ok(entry?.entry)
  const reached = new Set()
  const visit = (file) => {
    if (reached.has(file)) return
    reached.add(file)
    for (const dependency of byFile.get(file)?.imports ?? []) visit(dependency)
  }
  visit(entry.file)
  // Manifests are addon code too; an eager one could otherwise take the bridge first.
  const addonModules = () =>
    [...reached]
      .flatMap((file) => byFile.get(file).modules)
      .filter((module) => /^src\/(?:user)?addons\/[^/]+\//.test(module))
  assert.deepEqual(addonModules(), [])
  // Resolving an owner must not import the editor's flavor sidecars either.
  for (const module of [
    '\0virtual:hibi-addon-catalog/windows',
    'src/renderer/src/addon-definition.ts',
  ]) {
    const chunk = chunks.find((chunk) => chunk.modules.includes(module))
    assert.ok(chunk, module)
    visit(chunk.file)
  }
  assert.deepEqual(addonModules(), [])
})

test('addon windows host the editor without desktop privileges', {
  timeout: 45000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-addon-window-editor-'))
  const profile = join(root, 'profile')
  await mkdir(profile)
  // Quick note is a background addon with a global shortcut; it must not start in the window.
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'ui-preview': true, 'quick-note': true, mermaid: true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page.evaluate(() =>
    window.hibi.openAddonWindow('ui-preview', {
      id: 'editor',
      titleBar: 'hibi',
    }),
  )
  const findPreview = () =>
    app.windows().find((item) => item.url().endsWith('/addon-window.html'))
  while (!findPreview()) await setTimeout(30)
  const preview = findPreview()
  const editor = preview.locator('.tiptap[contenteditable="true"]')
  await editor.waitFor()
  assert.equal(await preview.locator('.editor-toolbar').count(), 1)
  // Mermaid also opens its own diagram files, but Markdown notes still start it.
  await preview
    .locator('style[data-addon-style="mermaid.preview"]')
    .waitFor({ state: 'attached' })
  assert.equal(
    await preview.getByRole('region', { name: 'Preview note' }).count(),
    1,
  )

  await editor.click()
  await preview.keyboard.type('# Title')
  await preview.keyboard.press('Enter')
  await preview.keyboard.type('Body')
  await preview.locator('.tiptap h1').getByText('Title').waitFor()
  await preview.locator('.tiptap p').getByText('Body').waitFor()

  // Slash transforms that rewrite the whole note apply to the window's note.
  await preview.keyboard.press('Enter')
  await preview.keyboard.type('/front')
  await preview
    .getByRole('listbox', { name: /slash commands/i })
    .getByRole('option', { name: /frontmatter add page properties/i })
    .click()
  await preview
    .getByRole('region', { name: /frontmatter properties/i })
    .waitFor()
  await preview.locator('.tiptap h1').getByText('Title').waitFor()

  // Preferences saved in the main window apply to open windows.
  assert.equal(await editor.getAttribute('spellcheck'), 'true')
  await page.evaluate(() => {
    localStorage.setItem('spell-check', 'false')
    localStorage.setItem('hibi:toolbar', JSON.stringify({ mode: 'text' }))
  })
  await preview.locator('.tiptap[spellcheck="false"]').waitFor()
  await preview.locator('.editor-toolbar[data-mode="text"]').waitFor()
  await page.evaluate(() => {
    localStorage.removeItem('spell-check')
    localStorage.removeItem('hibi:toolbar')
  })
  await preview.locator('.tiptap[spellcheck="true"]').waitFor()

  // Addons started for the editor cannot take the owner's bridge from the global.
  await assert.rejects(
    preview.evaluate(() => window.hibiAddonWindow.invoke('save', {})),
    /bridge is closed/,
  )
  assert.equal(
    await preview.evaluate(() => window.hibiAddonWindow.seal() ?? null),
    null,
  )

  // The window's desktop stand-in answers locally or refuses.
  assert.equal(await preview.evaluate(() => window.hibi.getWorkspace()), null)
  await assert.rejects(
    preview.evaluate(() => window.hibi.readWorkspaceText('notes.md')),
    /not available in this window/,
  )
  await assert.rejects(
    preview.evaluate(() => window.hibi.invokeAddon('quick-note', 'save', {})),
    /not available in this window/,
  )
  assert.equal(
    await preview.locator('.toast').count(),
    0,
    'background addons such as quick note did not start in the window',
  )

  // The window opens in the user's default view, here the source editor.
  await page.evaluate(async () => {
    localStorage.setItem('default-view', 'markdown')
    await window.hibi.closeAddonWindow('ui-preview', 'editor')
  })
  while (findPreview()) await setTimeout(30)
  await page.evaluate(() =>
    window.hibi.openAddonWindow('ui-preview', { id: 'editor' }),
  )
  while (!findPreview()) await setTimeout(30)
  const source = findPreview()
  await source.locator('.cm-content[contenteditable="true"]').waitFor()
  assert.equal(
    await source.locator('.cm-content[contenteditable="true"]').isVisible(),
    true,
  )
  await page.evaluate(() =>
    window.hibi.closeAddonWindow('ui-preview', 'editor'),
  )
  while (findPreview()) await setTimeout(30)

  // Window ids are looked up as own keys, so inherited names render nothing.
  await page.evaluate(() =>
    window.hibi.openAddonWindow('ui-preview', { id: 'constructor' }),
  )
  const findInherited = async () => {
    for (const item of app.windows())
      if (
        item.url().endsWith('/addon-window.html') &&
        (await item.evaluate(() => window.hibiAddonWindow.context())).id ===
          'constructor'
      )
        return item
  }
  while (!(await findInherited())) await setTimeout(30)
  await (await findInherited())
    .getByRole('alert')
    .getByText('This addon window is unavailable.')
    .waitFor()

  await page.evaluate(() =>
    window.hibi.closeAddonWindow('ui-preview', 'constructor'),
  )
  while (findPreview()) await setTimeout(30)

  // Settings changes in the main window stop and start addons in editor windows,
  // including hidden kept-alive ones.
  await page.evaluate(() =>
    window.hibi.openAddonWindow('ui-preview', {
      id: 'editor',
      keepAlive: true,
    }),
  )
  while (!findPreview()) await setTimeout(30)
  const kept = findPreview()
  const extras = kept.locator(
    'style[data-addon-style="text-extras.text-extras"]',
  )
  await kept.locator('.cm-content[contenteditable="true"]').waitFor()
  await extras.waitFor({ state: 'attached' })
  await page.evaluate(() => window.hibi.setAddonEnabled('text-extras', false))
  await extras.waitFor({ state: 'detached' })
  await page.evaluate(() =>
    window.hibi.closeAddonWindow('ui-preview', 'editor'),
  )
  assert.equal(findPreview(), kept, 'the kept-alive window is only hidden')
  await page.evaluate(() => window.hibi.setAddonEnabled('text-extras', true))
  await extras.waitFor({ state: 'attached' })

  // The main document is untouched by edits in the window.
  assert.equal(
    await page.evaluate(async () => (await window.hibi.getDocument()).markdown),
    '',
  )
})

test('addons that failed in a hidden window recover when toggled in settings', {
  timeout: 45000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-addon-window-retry-'))
  const profile = join(root, 'profile')
  await mkdir(profile)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'ui-preview': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  // Text extras fails its first start in the window, as a transient error would.
  await app.context().addInitScript(() => {
    if (!location.href.endsWith('/addon-window.html')) return
    window.failExtras = true
    const insert = Node.prototype.insertBefore
    Node.prototype.insertBefore = function (node, child) {
      if (
        window.failExtras &&
        node?.dataset?.addonStyle === 'text-extras.text-extras'
      )
        throw new Error('transient failure')
      return insert.call(this, node, child)
    }
  })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page.evaluate(() =>
    window.hibi.openAddonWindow('ui-preview', {
      id: 'editor',
      keepAlive: true,
    }),
  )
  const find = () =>
    app.windows().find((item) => item.url().endsWith('/addon-window.html'))
  while (!find()) await setTimeout(30)
  const kept = find()
  await kept.locator('.tiptap[contenteditable="true"]').waitFor()
  const extras = kept.locator(
    'style[data-addon-style="text-extras.text-extras"]',
  )
  assert.equal(await extras.count(), 0)
  await page.evaluate(() =>
    window.hibi.closeAddonWindow('ui-preview', 'editor'),
  )
  await kept.evaluate(() => {
    window.failExtras = false
  })
  await page.evaluate(async () => {
    await window.hibi.setAddonEnabled('text-extras', false)
    await window.hibi.setAddonEnabled('text-extras', true)
  })
  await extras.waitFor({ state: 'attached' })
})
