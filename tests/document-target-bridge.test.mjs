import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('installed addon edits inactive documents and guards deferred legacy commands', {
  timeout: 60000,
}, async (t) => {
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
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
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
  await page.waitForFunction(
    async () => (await window.hibi.getDocument()).markdown === '# ONE',
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
    () => document.querySelector('.cm-content')?.isContentEditable,
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

  await page.evaluate(() => window.targetProbe.begin())
  await page.waitForFunction(() => window.targetProbe.started)
  await page.getByRole('tab', { name: 'second.md' }).click()
  await page.evaluate(() => window.targetProbe.release())
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
  await page.waitForFunction(
    async () =>
      (await window.hibi.getDocument()).markdown === '# two\nfrom command',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '# two\nfrom command',
  )

  await page.evaluate(() => window.targetProbe.sync())
  await page.waitForFunction(
    async () =>
      (await window.hibi.getDocument()).markdown ===
      '# two\nfrom command\nfrom sync command',
  )
  await page.evaluate(() => window.targetProbe.background())
  await page.waitForFunction(
    async () =>
      (await window.hibi.getDocument()).markdown ===
      '# two\nfrom command\nfrom sync command\nfrom background',
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
  await page.locator(`[data-tab-key="${secondId}"] .tab-split`).click()
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
  await page.waitForFunction(
    async () =>
      document
        .querySelector('.editor-page[data-side="left"]')
        ?.getAttribute('data-active') === 'true' &&
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
