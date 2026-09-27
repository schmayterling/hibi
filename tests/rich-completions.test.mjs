import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('rich completions replace exact plain text in one undo step and retract on disposal', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-rich-completions-'))
  const folder = join(profile, 'installed-addons', 'completion-probe')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'completion-probe',
      name: 'Completion probe',
      description: 'Rich completion adapter test.',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      startup: 'background',
      capabilities: [],
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(folder, 'index.js'),
    `export default () => ({
    async start(context) {
      window.completionCalls = 0
      window.completionUnsafeRange = false
      window.completionReplacement = 'hello'
      const dispose = await context.editor.registerCompletionProvider(async (request) => {
        if (request.editor !== 'rich') return []
        window.completionCalls++
        if (!request.before.endsWith('hel')) return []
        return [{
          label: 'hello',
          detail: 'plain text',
          insertText: window.completionReplacement,
          from: window.completionUnsafeRange ? 0 : request.selection.head - 3,
          to: request.selection.head,
        }]
      })
      window.stopCompletionProbe = dispose
      window.completionProbeReady = true
    },
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
    JSON.stringify({
      'completion-probe': true,
    }),
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
  page.setDefaultTimeout(8000)
  const rich = page.locator('.rich-pane .tiptap[contenteditable="true"]')
  await rich.waitFor()
  await page.waitForFunction(() => window.completionProbeReady === true)
  await rich.click()
  await page.keyboard.type('hel')
  const menu = page.getByRole('listbox', { name: 'Completions' })
  await menu.getByRole('option', { name: /hello/ }).waitFor()
  await page.keyboard.press('Enter')
  await menu.waitFor({ state: 'hidden' })
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown.trim() === 'hello',
  )
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`,
  )
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown.trim() === 'hel',
  )
  await page.evaluate(() => {
    window.completionReplacement = '[[proof-note]]'
  })
  await page.keyboard.press('Control+Space')
  await menu.getByRole('option', { name: /hello/ }).waitFor()
  await page.keyboard.press('Enter')
  await menu.waitFor({ state: 'hidden' })
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown.trim() === '[[proof-note]]',
  )
  assert.equal(
    await rich.locator('a[data-wiki-link="proof-note"]').innerText(),
    'proof-note',
  )
  await rich.evaluate((element) => element.editor.commands.undo())
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown.trim() === 'hel',
  )
  await rich.evaluate((element) => element.editor.commands.redo())
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown.trim() === '[[proof-note]]',
  )
  await rich.evaluate((element) => {
    const editor = element.editor
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.view.focus()
  })
  await page.keyboard.insertText('x')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown.trim() === '[[proof-note]]x',
  )
  await rich.evaluate((element) => element.editor.commands.undo())
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown.trim() === '[[proof-note]]',
  )
  await rich.evaluate((element) => element.editor.commands.undo())
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown.trim() === 'hel',
  )
  await page.evaluate(() => {
    window.completionReplacement = 'hello'
  })
  await page.keyboard.press('Control+Space')
  await menu.getByRole('option', { name: /hello/ }).waitFor()
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown.trim(),
    'hel',
  )
  const beforeUnsafe = await page.evaluate(() => {
    window.completionUnsafeRange = true
    return window.completionCalls
  })
  await page.keyboard.press('Control+Space')
  await page.waitForFunction(
    (before) => window.completionCalls > before,
    beforeUnsafe,
  )
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  await menu.waitFor({ state: 'hidden' })
  await page.evaluate(() => {
    window.completionUnsafeRange = false
  })
  await page.keyboard.press('Control+Space')
  await menu.getByRole('option', { name: /hello/ }).waitFor()
  await page.evaluate(() => window.stopCompletionProbe())
  await menu.waitFor({ state: 'hidden' })
  const calls = await page.evaluate(() => window.completionCalls)
  await page.keyboard.type('x')
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  assert.equal(await page.evaluate(() => window.completionCalls), calls)
})
