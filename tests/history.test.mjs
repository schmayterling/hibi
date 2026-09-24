import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { electron } from './electron.mjs'
import { pressShortcut, replaceRichText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('local history snapshots on save, previews, and restores without overwriting disk', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-history-'))
  const file = join(profile, 'note.md')
  await writeFile(file, 'original')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.historyWriteGate?.release()
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, file)
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${mod}+o`)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'original',
  )
  await page.waitForFunction(
    () =>
      document.querySelector('.tiptap')?.textContent === 'original' &&
      document.querySelector('.tiptap')?.getAttribute('contenteditable') ===
        'true',
  )
  await replaceRichText(page, rich, 'saved change')
  await waitForAsync(page, async () => {
    const document = await window.hibi.getDocument()
    return document.dirty && document.markdown === 'saved change'
  })
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(
    page,
    async () => (await window.hibi.listVersions()).length === 2,
  )
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), 'saved change')
  const versions = await page.evaluate(() => window.hibi.listVersions())
  assert.equal(
    await page.evaluate((id) => window.hibi.previewVersion(id), versions[1].id),
    'original',
  )
  await pressShortcut(app, `${mod}+s`)
  await page.waitForFunction(
    () => document.querySelector('.app').getAttribute('aria-busy') !== 'true',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.listVersions())).length,
    2,
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.previewVersion('../../note.md')),
    /This saved version is no longer available\./,
  )
  await pressShortcut(app, `${mod}+k`)
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('version history')
  await page.getByRole('option').first().waitFor()
  await page.keyboard.press('Enter')
  const history = page.getByRole('dialog', {
    name: /^version history$/i,
    exact: true,
  })
  await history
    .getByRole('navigation', { name: /saved versions/i })
    .getByRole('button')
    .last()
    .click()
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="version preview" i]').textContent ===
      'original',
  )
  await history.getByRole('button', { name: /restore to editor/i }).click()
  await waitForAsync(page, async () => {
    const doc = await window.hibi.getDocument()
    return doc.dirty && doc.markdown === 'original'
  })
  assert.equal(await readFile(file, 'utf8'), 'saved change')
  await history.waitFor({ state: 'hidden' })
  await page.waitForFunction(
    () =>
      document.querySelector('.app').getAttribute('aria-busy') === 'false' &&
      document.querySelector('.tiptap')?.textContent === 'original' &&
      document.querySelector('.tiptap')?.getAttribute('contenteditable') ===
        'true',
  )
  await replaceRichText(page, rich, 'unsaved buffer')
  await waitForAsync(page, async () => {
    const document = await window.hibi.getDocument()
    return document.dirty && document.markdown === 'unsaved buffer'
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 2 })
  })
  assert.equal(
    await page.evaluate((id) => window.hibi.restoreVersion(id), versions[1].id),
    null,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'unsaved buffer',
  )
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  // Hold the history commit so reads can prove they wait for the save.
  await app.evaluate(() => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const { syncBuiltinESMExports } = process.getBuiltinModule('node:module')
    const rename = fs.rename
    let release = () => {}
    let reached = false
    fs.rename = async (from, to) => {
      if (String(to).endsWith('index.json')) {
        reached = true
        await new Promise((resolve) => {
          release = resolve
        })
      }
      return rename(from, to)
    }
    syncBuiltinESMExports()
    globalThis.historyWriteGate = {
      get reached() {
        return reached
      },
      release: () => {
        fs.rename = rename
        syncBuiltinESMExports()
        release()
      },
    }
  })
  await page.evaluate(() => {
    window.historySave = window.hibi.saveDocument(false)
  })
  const started = performance.now()
  while (!(await app.evaluate(() => globalThis.historyWriteGate.reached))) {
    assert.ok(
      performance.now() - started < 10000,
      'history write did not pause',
    )
    await delay(20)
  }
  await page.evaluate((id) => {
    window.historyList = window.hibi.listVersions()
    window.historyPreview = window.hibi.previewVersion(id)
  }, versions[1].id)
  assert.deepEqual(
    await page.evaluate(() =>
      Promise.all(
        [window.historyList, window.historyPreview].map((read) =>
          Promise.race([
            read.then(() => 'resolved'),
            new Promise((resolve) => setTimeout(() => resolve('pending'), 250)),
          ]),
        ),
      ),
    ),
    ['pending', 'pending'],
  )
  await app.evaluate(() => globalThis.historyWriteGate.release())
  assert.equal((await page.evaluate(() => window.historySave)).dirty, false)
  const [savedVersions, preview] = await page.evaluate(() =>
    Promise.all([window.historyList, window.historyPreview]),
  )
  assert.equal(savedVersions.length, 3)
  assert.equal(preview, 'original')
})
