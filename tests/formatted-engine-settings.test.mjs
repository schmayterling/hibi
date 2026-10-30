import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, replaceRichText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const formatted = '.rich-pane .hibi-formatted .cm-content'
const toggleName = { name: 'Enable exotic butter', exact: true }

async function openSettings(app, page) {
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Editor', exact: true }).click()
  await page.getByRole('checkbox', toggleName).scrollIntoViewIfNeeded()
}

test('editor engine setting preserves pending edits and switches both engines', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-engine-settings-'))
  const file = join(profile, 'note.md')
  await writeFile(file, 'on disk')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        globalThis.releaseEngineJournal?.()
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await waitForDocumentEditor(app, page)
  const rich = () =>
    page.getByRole('textbox', {
      name: 'Document editor',
      exact: true,
    })
  const toggle = page.getByRole('checkbox', toggleName)
  const settings = () => openSettings(app, page)
  const back = async () => {
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await page.locator('.settings-screen').waitFor({ state: 'hidden' })
  }
  const source = async (expected) => {
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      expected,
    )
    assert.equal(await rich().innerText(), expected)
    assert.equal(await readFile(file, 'utf8'), 'on disk')
  }
  // A fresh profile stores no choice and opens the CodeMirror formatted view.
  await page.locator(formatted).waitFor()
  assert.equal(await page.locator('.rich-pane .tiptap').count(), 0)
  await source('on disk')
  await settings()
  assert.equal(await toggle.isChecked(), true)
  assert.equal(
    await page
      .locator('#settings-editor [data-setting-id]')
      .last()
      .getAttribute('data-setting-id'),
    'exotic-butter',
  )
  await page
    .getByRole('heading', { name: 'Editor engine', exact: true })
    .waitFor()
  assert.doesNotMatch(
    await page.locator('[data-setting-id="exotic-butter"]').textContent(),
    /experimental/i,
  )
  await page.evaluate(() => {
    const set = Storage.prototype.setItem
    window.restoreEngineStorage = () => {
      Storage.prototype.setItem = set
    }
    Storage.prototype.setItem = function (key, value) {
      if (key === 'hibi:formatted-engine')
        throw new Error('Engine preference could not be stored')
      return set.call(this, key, value)
    }
  })
  await toggle.click()
  await page.getByText('Could not switch editor', { exact: true }).waitFor()
  assert.equal(await toggle.isEnabled(), true)
  assert.equal(await toggle.isChecked(), true)
  assert.equal(
    await page.evaluate(() => localStorage.getItem('hibi:formatted-engine')),
    null,
  )
  assert.equal(await page.locator(formatted).count(), 1)
  await page.evaluate(() => window.restoreEngineStorage())
  await back()
  await app.evaluate(({ ipcMain }) => {
    const append = ipcMain._invokeHandlers.get('document:append')
    const held = new Promise((resolve) => {
      globalThis.releaseEngineJournal = resolve
    })
    ipcMain.removeHandler('document:append')
    ipcMain.handle('document:append', async (...args) => {
      globalThis.engineJournalReached = true
      await held
      return append(...args)
    })
  })
  await replaceRichText(page, rich(), 'pending from codemirror 😀')
  await settings()
  const reloaded = page.waitForEvent('load')
  await toggle.click()
  assert.equal(await toggle.isDisabled(), true)
  assert.equal(
    await page.evaluate(() => localStorage.getItem('hibi:formatted-engine')),
    null,
  )
  assert.equal(await app.evaluate(() => globalThis.engineJournalReached), true)
  await app.evaluate(() => globalThis.releaseEngineJournal())
  await reloaded
  await page.locator('.rich-pane .tiptap').waitFor()
  await source('pending from codemirror 😀')
  await settings()
  assert.equal(await toggle.isChecked(), false)
  assert.equal(
    await page.evaluate(() => localStorage.getItem('hibi:formatted-engine')),
    'tiptap',
  )
  // The setting is no longer marked experimental: it looks like the rows around it.
  const appearance = await page.evaluate(() =>
    ['exotic-butter', 'line-numbers'].map((id) => {
      const row = document.querySelector(`[data-setting-id="${id}"]`)
      const group = getComputedStyle(row.closest('.settings-group'))
      return {
        label: getComputedStyle(row.querySelector('label')).color,
        border: group.borderColor,
        background: group.backgroundColor,
      }
    }),
  )
  assert.deepEqual(appearance[0], appearance[1])
  const group = page.locator('.settings-group', {
    has: page.locator('[data-setting-id="exotic-butter"]'),
  })
  await mkdir('.scratch', { recursive: true })
  await group.screenshot({ path: '.scratch/engine-setting-light.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await group.screenshot({ path: '.scratch/engine-setting-dark.png' })
  await back()
  await replaceRichText(page, rich(), 'pending from tiptap 😀')
  await settings()
  const returned = page.waitForEvent('load')
  await toggle.click()
  await returned
  await page.locator(formatted).waitFor()
  await source('pending from tiptap 😀')
  await settings()
  assert.equal(await toggle.isChecked(), true)
  assert.equal(
    await page.evaluate(() => localStorage.getItem('hibi:formatted-engine')),
    'codemirror',
  )
  await page.reload()
  await page.locator(formatted).waitFor({ state: 'attached' })
  await settings()
  assert.equal(await toggle.isChecked(), true)
  await back()
  await source('pending from tiptap 😀')
})

test('restarts keep a stored Tiptap choice and move profiles without one to CodeMirror', {
  timeout: 90000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-engine-upgrade-'))
  const file = join(profile, 'note.md')
  await writeFile(file, '# Kept\n\nbody')
  t.after(() => rm(profile, { recursive: true, force: true }))
  const launch = async () => {
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`, file],
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    await waitForDocumentEditor(app, page)
    return { app, page }
  }
  const engine = async (page) => {
    await page.locator(`${formatted}, .rich-pane .tiptap`).first().waitFor()
    return (await page.locator('.rich-pane .tiptap').count())
      ? 'tiptap'
      : 'codemirror'
  }
  // Stored choices as the engine setting writes them; null is a profile that
  // never changed it, as every profile from before this setting is.
  for (const [stored, expected] of [
    [null, 'codemirror'],
    ['tiptap', 'tiptap'],
    ['codemirror', 'codemirror'],
  ]) {
    let { app, page } = await launch()
    try {
      await page.evaluate((stored) => {
        // Settings an earlier session leaves behind make this an existing profile.
        localStorage.setItem('default-view', 'normal')
        localStorage.setItem('introduction', 'seen')
        if (stored === null) localStorage.removeItem('hibi:formatted-engine')
        else localStorage.setItem('hibi:formatted-engine', stored)
      }, stored)
    } finally {
      await app.close()
    }
    ;({ app, page } = await launch())
    try {
      assert.equal(await engine(page), expected, String(stored))
      assert.equal(
        await page.evaluate(() =>
          localStorage.getItem('hibi:formatted-engine'),
        ),
        stored,
        'opening never rewrites the stored choice',
      )
      await openSettings(app, page)
      assert.equal(
        await page.getByRole('checkbox', toggleName).isChecked(),
        expected === 'codemirror',
        String(stored),
      )
    } finally {
      await app.close()
    }
  }
})
