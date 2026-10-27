import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import {
  clickMenu,
  pressShortcut,
  replaceRichText,
  replaceSourceText,
  splitTab,
} from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

async function launchTargetProbe(t, engine) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-target-bridge-'))
  const folder = join(profile, 'installed-addons', 'target-probe')
  await mkdir(folder, { recursive: true })
  const first = join(profile, 'first.md')
  const second = join(profile, 'second.md')
  await writeFile(first, '# one')
  await writeFile(second, '# two')
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'target-probe',
      name: 'Target probe',
      description: 'Document target bridge test addon.',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      defaultEnabled: true,
      startup: 'background',
      capabilities: [],
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(folder, 'index.js'),
    `export default () => ({
      start(context) {
        context.commands.register({
          id: 'deferred-update',
          label: 'Deferred update',
          async run() {
            const probe = window.targetProbe
            probe.started = true
            await new Promise(resolve => { probe.release = resolve })
            try {
              context.editor.updateMarkdown(source => source + '\\nfrom command')
              probe.result = 'applied'
            } catch (error) {
              probe.result = error.message
            }
          },
        })
        context.commands.register({
          id: 'sync-update',
          label: 'Sync update',
          run() {
            context.editor.updateMarkdown(source => source + '\\nfrom sync command')
          },
        })
        window.targetProbe = {
          list: () => context.documents.listOpen(),
          read: target => context.documents.readSource(target),
          edit: request => context.documents.applyEdits(request),
          save: target => context.documents.save(target),
          begin() {
            this.started = false
            this.result = null
            this.release = null
            void context.commands.execute('deferred-update').catch(error => {
              this.result = error.message
            })
          },
          sync: () => context.commands.execute('sync-update'),
          background: () => context.editor.updateMarkdown(source => source + '\\nfrom background'),
        }
      },
      stop() { delete window.targetProbe },
    })`,
  )
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'target-probe': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.releaseTargetSelection?.()
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  if (engine === 'codemirror') page.setDefaultTimeout(7000)
  await selectFormattedEngine(app, page, engine)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page.waitForFunction(() => !!window.targetProbe)
  async function open(file) {
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      })
    }, file)
    await clickMenu(app, 'Open…')
  }
  const openTarget = async (file) => {
    await open(file)
    const name = file === first ? 'first.md' : 'second.md'
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      name,
    )
    await waitForDocumentEditor(app, page)
    return page.evaluate(
      (name) =>
        window.targetProbe.list().find((document) => document.name === name)
          .target,
      name,
    )
  }
  return { app, page, first, second, open, openTarget }
}

test('installed addon edits inactive documents and guards deferred legacy commands', {
  timeout: 60000,
}, async (t) => {
  const { app, page, first, second, open } = await launchTargetProbe(
    t,
    'tiptap',
  )
  await open(first)
  await page.waitForFunction(() =>
    window.targetProbe.list().some(({ name }) => name === 'first.md'),
  )
  const firstTarget = await page.evaluate(
    () =>
      window.targetProbe.list().find(({ name }) => name === 'first.md').target,
  )
  await open(second)
  await page.waitForFunction(() =>
    window.targetProbe.list().some(({ name }) => name === 'second.md'),
  )
  const source = await page.evaluate(
    (target) => window.targetProbe.read(target),
    firstTarget,
  )
  assert.equal(source.status, 'read')
  assert.equal(source.source, '# one')
  const result = await page.evaluate(
    (target) =>
      window.targetProbe.edit({
        requestId: 'inactive-first',
        target,
        changes: [{ from: 2, to: 5, expectedText: 'one', insert: 'ONE' }],
      }),
    source.target,
  )
  assert.equal(result.status, 'applied')
  const saved = await page.evaluate(
    (target) => window.targetProbe.save(target),
    { ...source.target, contentVersion: result.contentVersion },
  )
  assert.ok(['saved', 'clean'].includes(saved.status))
  assert.equal(await readFile(first, 'utf8'), '# ONE')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).name,
    'second.md',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '# two',
  )
  await page.getByRole('tab', { name: 'first.md' }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === '# ONE',
    undefined,
    { timeout: 30000 },
  )
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.isContentEditable,
  )
  const richEdit = await page.evaluate((target) => {
    const read = window.targetProbe.read(target)
    return window.targetProbe.edit({
      requestId: 'active-rich',
      target: read.target,
      changes: [{ from: 2, to: 5, expectedText: 'ONE', insert: 'One' }],
    })
  }, firstTarget)
  assert.equal(richEdit.status, 'applied')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '# One',
  )
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await page.waitForFunction(
    () =>
      document.querySelector(
        '.editor-panes.mode-markdown[data-source-ready="true"] .source-pane:not([inert]) .cm-content',
      )?.isContentEditable,
  )
  const sourceEdit = await page.evaluate((target) => {
    const read = window.targetProbe.read(target)
    return window.targetProbe.edit({
      requestId: 'active-source',
      target: read.target,
      changes: [{ from: 2, to: 5, expectedText: 'One', insert: 'ONE' }],
    })
  }, firstTarget)
  assert.equal(sourceEdit.status, 'applied')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '# ONE',
  )

  await app.evaluate(({ ipcMain }) => {
    const channel = 'document:select-tab'
    const select = ipcMain._invokeHandlers.get(channel)
    ipcMain._invokeHandlers.set(channel, async (...args) => {
      ipcMain._invokeHandlers.set(channel, select)
      await new Promise((resolve) => {
        globalThis.releaseTargetSelection = resolve
      })
      return select(...args)
    })
  })
  await page.evaluate(() => window.targetProbe.begin())
  await page.waitForFunction(() => window.targetProbe.started)
  await page.getByRole('tab', { name: 'second.md' }).click()
  await waitForAsync(app, () => !!globalThis.releaseTargetSelection)
  const resumed = (async () => {
    await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
    await page.evaluate(() => window.targetProbe.release())
  })()
  try {
    // The old source editor stays visible while the target tab is pending.
    await page
      .getByRole('textbox', { name: 'Markdown editor', exact: true })
      .waitFor()
    assert.equal(await page.locator('.app').getAttribute('aria-busy'), 'true')
    const pending = await page.evaluate(async () => ({
      document: await window.hibi.getDocument(),
      result: window.targetProbe.result,
    }))
    assert.equal(pending.document.name, 'first.md')
    assert.equal(pending.document.markdown, '# ONE')
    assert.equal(pending.result, null)
  } finally {
    await app.evaluate(() => globalThis.releaseTargetSelection())
    await resumed
  }
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).name,
    'second.md',
  )
  await page.waitForFunction(() => window.targetProbe.result !== null)
  assert.match(
    await page.evaluate(() => window.targetProbe.result),
    /command target is no longer available/i,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '# two',
  )

  await page.evaluate(() => window.targetProbe.begin())
  await page.waitForFunction(() => window.targetProbe.started)
  await page.evaluate(() => window.targetProbe.release())
  await page.waitForFunction(() => window.targetProbe.result !== null)
  assert.equal(await page.evaluate(() => window.targetProbe.result), 'applied')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === '# two\nfrom command',
    undefined,
    { timeout: 30000 },
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '# two\nfrom command',
  )

  await page.evaluate(() => window.targetProbe.sync())
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown ===
      '# two\nfrom command\nfrom sync command',
    undefined,
    { timeout: 30000 },
  )
  await page.evaluate(() => window.targetProbe.background())
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown ===
      '# two\nfrom command\nfrom sync command\nfrom background',
    undefined,
    { timeout: 30000 },
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '# two\nfrom command\nfrom sync command\nfrom background',
  )

  await page.getByRole('tab', { name: 'first.md' }).click()
  await page.getByRole('button', { name: 'normal', exact: true }).click()
  await page.waitForFunction(
    () =>
      document.querySelector('.editor-panes.mode-normal .tiptap')
        ?.isContentEditable,
  )
  const secondId = await page
    .getByRole('tab', { name: 'second.md' })
    .evaluate((tab) => tab.closest('[data-tab-key]').dataset.tabKey)
  await splitTab(app, page, secondId)
  const left = page.locator('.editor-page[data-side="left"]')
  const right = page.locator('.editor-page[data-side="right"]')
  const leftRich = left.locator('.rich-pane .tiptap')
  await leftRich.waitFor()
  await right.locator('.rich-pane .tiptap').waitFor()
  await page.waitForFunction(
    () =>
      document
        .querySelector('.editor-page[data-side="right"]')
        ?.getAttribute('data-active') === 'true',
  )
  assert.equal(await left.locator('.source-pane[inert] .cm-content').count(), 1)
  assert.equal(await leftRich.getAttribute('contenteditable'), 'true')
  const inactiveRichEdit = await page.evaluate((target) => {
    const read = window.targetProbe.read(target)
    return window.targetProbe.edit({
      requestId: 'inactive-mounted-rich',
      target: read.target,
      changes: [{ from: 2, to: 5, expectedText: 'ONE', insert: 'Uno' }],
    })
  }, firstTarget)
  assert.equal(inactiveRichEdit.status, 'applied')
  assert.match(await leftRich.innerText(), /Uno/)
  assert.equal(await right.getAttribute('data-active'), 'true')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).name,
    'second.md',
  )

  await leftRich.click()
  await waitForAsync(
    page,
    async () =>
      document
        .querySelector('.editor-page[data-side="left"]')
        ?.getAttribute('data-active') === 'true' &&
      (await window.hibi.getDocument()).name === 'first.md',
    undefined,
    { timeout: 30000 },
  )
  await page.getByRole('button', { name: 'side-by-side', exact: true }).click()
  await page.waitForFunction(
    () =>
      document
        .querySelector(
          '.editor-page[data-side="left"] .editor-panes.mode-side-by-side',
        )
        ?.getAttribute('data-source-ready') === 'true',
  )
  assert.equal(await left.locator('.source-pane[inert]').count(), 0)
  assert.equal(await leftRich.getAttribute('contenteditable'), 'false')
  await leftRich.focus()
  assert.equal(
    await leftRich.evaluate((element) => element === document.activeElement),
    true,
  )
  const previewFocusedSourceEdit = await page.evaluate((target) => {
    const read = window.targetProbe.read(target)
    return window.targetProbe.edit({
      requestId: 'preview-focused-mounted-source',
      target: read.target,
      changes: [{ from: 2, to: 5, expectedText: 'Uno', insert: 'ONE' }],
    })
  }, firstTarget)
  assert.equal(previewFocusedSourceEdit.status, 'applied')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '# ONE',
  )
  assert.equal(
    await leftRich.evaluate((element) => element === document.activeElement),
    true,
  )
})

// The installed API 2 bridge is shared by engines; keep its native CM contracts
// independent so a formatted adapter failure cannot hide source or command guards.
const targetWord = (page, target, requestId, expectedText, insert) =>
  page.evaluate(
    ({ target, requestId, expectedText, insert }) => {
      const read = window.targetProbe.read(target)
      return window.targetProbe.edit({
        requestId,
        target: read.target,
        changes: [{ from: 2, to: 5, expectedText, insert }],
      })
    },
    { target, requestId, expectedText, insert },
  )

const acceptedMarkdown = (page) =>
  page.evaluate(async () => {
    await window.hibi.flushDocumentChanges()
    return (await window.hibi.getDocument()).markdown
  })

test('codemirror: inactive addon target edits save exact source without changing active input or focus', {
  timeout: 60000,
}, async (t) => {
  const { app, page, first, second, openTarget } = await launchTargetProbe(
    t,
    'codemirror',
  )
  const target = await openTarget(first)
  await openTarget(second)
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await rich.focus()
  const read = await page.evaluate(
    (target) => window.targetProbe.read(target),
    target,
  )
  assert.equal(read.status, 'read')
  assert.equal(read.source, '# one')
  const edit = await targetWord(page, read.target, 'cm-inactive', 'one', 'ONE')
  assert.equal(edit.status, 'applied')
  const saved = await page.evaluate(
    (target) => window.targetProbe.save(target),
    { ...read.target, contentVersion: edit.contentVersion },
  )
  assert.ok(['saved', 'clean'].includes(saved.status))
  assert.equal(await readFile(first, 'utf8'), '# ONE')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).name,
    'second.md',
  )
  assert.equal(await acceptedMarkdown(page), '# two')
  assert.equal(
    await rich.evaluate((element) => element === document.activeElement),
    true,
  )
  await rich.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  await page.keyboard.insertText('!')
  assert.equal(await acceptedMarkdown(page), '# two!')
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  assert.equal(await acceptedMarkdown(page), '# two')
  assert.equal(await readFile(first, 'utf8'), '# ONE')
  await page.getByRole('tab', { name: 'first.md', exact: true }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === '# ONE',
    undefined,
    { timeout: 30000 },
  )
  await waitForDocumentEditor(app, page)
  assert.equal(await acceptedMarkdown(page), '# ONE')
  assert.equal(
    await rich.locator('[role="heading"][aria-level="1"]').innerText(),
    'ONE',
  )
})

test('codemirror: active formatted addon target edits keep canonical source and native history', {
  timeout: 60000,
}, async (t) => {
  const { app, page, first, openTarget } = await launchTargetProbe(
    t,
    'codemirror',
  )
  const target = await openTarget(first)
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await replaceRichText(page, rich, '# ONE')
  assert.equal(await acceptedMarkdown(page), '# ONE')
  const edit = await targetWord(
    page,
    target,
    'cm-active-formatted',
    'ONE',
    'One',
  )
  assert.equal(edit.status, 'applied')
  assert.equal(await acceptedMarkdown(page), '# One')
  await rich.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  await page.keyboard.insertText('!')
  assert.equal(await acceptedMarkdown(page), '# One!')
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  assert.equal(await acceptedMarkdown(page), '# One')
})

test('codemirror: active source addon target edits keep the native source and its history', {
  timeout: 60000,
}, async (t) => {
  const { app, page, first, openTarget } = await launchTargetProbe(
    t,
    'codemirror',
  )
  const target = await openTarget(first)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await replaceSourceText(page, source, '# One')
  assert.equal(await acceptedMarkdown(page), '# One')
  const edit = await targetWord(page, target, 'cm-active-source', 'One', 'ONE')
  assert.equal(edit.status, 'applied')
  assert.equal(await acceptedMarkdown(page), '# ONE')
  assert.equal(
    await source.evaluate((element) =>
      element.cmTile.root.view.state.doc.toString(),
    ),
    '# ONE',
  )
  await source.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  await page.keyboard.insertText('!')
  assert.equal(await acceptedMarkdown(page), '# ONE!')
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  assert.equal(await acceptedMarkdown(page), '# ONE')
})

test('codemirror: a deferred legacy command rejects a target switched while tab selection is pending', {
  timeout: 60000,
}, async (t) => {
  const { app, page, first, second, openTarget } = await launchTargetProbe(
    t,
    'codemirror',
  )
  await openTarget(first)
  await openTarget(second)
  await page.getByRole('tab', { name: 'first.md', exact: true }).click()
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await replaceSourceText(page, source, '# ONE')
  assert.equal(await acceptedMarkdown(page), '# ONE')
  await app.evaluate(({ ipcMain }) => {
    const channel = 'document:select-tab'
    const select = ipcMain._invokeHandlers.get(channel)
    ipcMain._invokeHandlers.set(channel, async (...args) => {
      ipcMain._invokeHandlers.set(channel, select)
      await new Promise((resolve) => {
        globalThis.releaseTargetSelection = resolve
      })
      return select(...args)
    })
  })
  await page.evaluate(() => window.targetProbe.begin())
  await page.waitForFunction(() => window.targetProbe.started)
  await page.getByRole('tab', { name: 'second.md', exact: true }).click()
  await waitForAsync(app, () => !!globalThis.releaseTargetSelection)
  try {
    await source.waitFor()
    assert.equal(await page.locator('.app').getAttribute('aria-busy'), 'true')
    const pending = await page.evaluate(async () => ({
      document: await window.hibi.getDocument(),
      result: window.targetProbe.result,
    }))
    assert.equal(pending.document.name, 'first.md')
    assert.equal(pending.document.markdown, '# ONE')
    assert.equal(pending.result, null)
  } finally {
    await app.evaluate(() => globalThis.releaseTargetSelection())
  }
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await page.evaluate(() => window.targetProbe.release())
  await page.waitForFunction(() => window.targetProbe.result !== null)
  assert.match(
    await page.evaluate(() => window.targetProbe.result),
    /command target is no longer available/i,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).name,
    'second.md',
  )
  assert.equal(await acceptedMarkdown(page), '# two')
})

test('codemirror: same-target deferred, synchronous and background legacy commands apply exact source', {
  timeout: 60000,
}, async (t) => {
  const { app, page, second, openTarget } = await launchTargetProbe(
    t,
    'codemirror',
  )
  await openTarget(second)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await source.focus()
  await page.evaluate(() => window.targetProbe.begin())
  await page.waitForFunction(() => window.targetProbe.started)
  await page.evaluate(() => window.targetProbe.release())
  await page.waitForFunction(() => window.targetProbe.result !== null)
  assert.equal(await page.evaluate(() => window.targetProbe.result), 'applied')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === '# two\nfrom command',
  )
  assert.equal(await acceptedMarkdown(page), '# two\nfrom command')
  await page.evaluate(() => window.targetProbe.sync())
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown ===
      '# two\nfrom command\nfrom sync command',
  )
  assert.equal(
    await acceptedMarkdown(page),
    '# two\nfrom command\nfrom sync command',
  )
  await page.evaluate(() => window.targetProbe.background())
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown ===
      '# two\nfrom command\nfrom sync command\nfrom background',
  )
  assert.equal(
    await acceptedMarkdown(page),
    '# two\nfrom command\nfrom sync command\nfrom background',
  )
  assert.equal(
    await source.evaluate((element) => element === document.activeElement),
    true,
  )
})

test('codemirror: mounted inactive target edits keep the other document and its native focus', {
  timeout: 60000,
}, async (t) => {
  const { app, page, first, second, openTarget } = await launchTargetProbe(
    t,
    'codemirror',
  )
  const target = await openTarget(first)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(
    page,
    page.getByRole('textbox', { name: 'Markdown editor', exact: true }),
    '# ONE',
  )
  assert.equal(await acceptedMarkdown(page), '# ONE')
  await page.getByRole('button', { name: 'normal', exact: true }).click()
  await waitForDocumentEditor(app, page)
  await openTarget(second)
  const secondId = (await page.evaluate(() => window.hibi.getDocument())).tabId
  await page.getByRole('tab', { name: 'first.md', exact: true }).click()
  await waitForDocumentEditor(app, page)
  // Reopening the tab remounts this host; retain source in the current mount.
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await page.getByRole('button', { name: 'normal', exact: true }).click()
  await waitForDocumentEditor(app, page)
  await splitTab(app, page, secondId)
  const left = page.locator('.editor-page[data-side="left"]')
  const right = page.locator('.editor-page[data-side="right"]')
  const leftRich = left.locator('.rich-pane .cm-content')
  const rightRich = right.locator('.rich-pane .cm-content')
  await leftRich.waitFor()
  await rightRich.waitFor()
  await rightRich.focus()
  await page.waitForFunction(
    () =>
      document.querySelector('.editor-page[data-side="right"]')?.dataset
        .active === 'true',
  )
  assert.equal(await left.locator('.source-pane[inert] .cm-content').count(), 1)
  assert.equal(await leftRich.getAttribute('contenteditable'), 'true')
  const inactive = await targetWord(
    page,
    target,
    'cm-inactive-mounted',
    'ONE',
    'Uno',
  )
  assert.equal(inactive.status, 'applied')
  await leftRich.filter({ hasText: 'Uno' }).waitFor()
  assert.match(await leftRich.innerText(), /Uno/)
  assert.equal(await right.getAttribute('data-active'), 'true')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).name,
    'second.md',
  )
  assert.equal(
    await rightRich.evaluate((element) => element === document.activeElement),
    true,
  )
})

test('codemirror: split-focused target edits retain native focus in the editable formatted pane', {
  timeout: 60000,
}, async (t) => {
  const { app, page, first, second, openTarget } = await launchTargetProbe(
    t,
    'codemirror',
  )
  const target = await openTarget(first)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(
    page,
    page.getByRole('textbox', { name: 'Markdown editor', exact: true }),
    '# Uno',
  )
  assert.equal(await acceptedMarkdown(page), '# Uno')
  await page.getByRole('button', { name: 'normal', exact: true }).click()
  await waitForDocumentEditor(app, page)
  await openTarget(second)
  const secondId = (await page.evaluate(() => window.hibi.getDocument())).tabId
  await page.getByRole('tab', { name: 'first.md', exact: true }).click()
  await waitForDocumentEditor(app, page)
  await splitTab(app, page, secondId)
  const left = page.locator('.editor-page[data-side="left"]')
  const leftRich = left.locator('.rich-pane .cm-content')
  await leftRich.waitFor()
  await leftRich.click()
  await waitForAsync(
    page,
    async () =>
      document.querySelector('.editor-page[data-side="left"]')?.dataset
        .active === 'true' &&
      (await window.hibi.getDocument()).name === 'first.md',
  )
  await page.getByRole('button', { name: 'side-by-side', exact: true }).click()
  await page.waitForFunction(
    () =>
      document
        .querySelector(
          '.editor-page[data-side="left"] .editor-panes.mode-side-by-side',
        )
        ?.getAttribute('data-source-ready') === 'true',
  )
  assert.equal(await left.locator('.source-pane[inert]').count(), 0)
  // The formatted split pane keeps native editing and target focus.
  assert.equal(await leftRich.getAttribute('contenteditable'), 'true')
  await leftRich.focus()
  assert.equal(
    await leftRich.evaluate((element) => element === document.activeElement),
    true,
  )
  const split = await targetWord(page, target, 'cm-split-focused', 'Uno', 'ONE')
  assert.equal(split.status, 'applied')
  assert.equal(await acceptedMarkdown(page), '# ONE')
  assert.equal(
    await leftRich.evaluate((element) => element === document.activeElement),
    true,
  )
  await leftRich.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  await page.keyboard.insertText('!')
  assert.equal(await acceptedMarkdown(page), '# ONE!')
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  assert.equal(await acceptedMarkdown(page), '# ONE')
})
