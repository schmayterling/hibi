import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { noteTargets, wikiHref, wikiTarget } from '../src/shared/note-links.ts'
import { electron } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('native wikilinks resolve aliases, headings and unique vault note names', () => {
  const paths = new Set(['notes/Start.md', 'notes/Next.md', 'Other.md'])
  assert.equal(
    wikiTarget('notes/Start.md', 'Next#Heading', paths),
    'notes/Next.md',
  )
  assert.equal(
    wikiTarget('notes/Start.md', 'Other#^block-id', paths),
    'Other.md',
  )
  assert.equal(
    wikiTarget('notes/Start.md', '#Local heading', paths),
    'notes/Start.md',
  )
  assert.equal(wikiHref('#Local heading'), '#local-heading')
  assert.deepEqual(
    noteTargets(
      '[[Next|Alias]] [[Other#Heading]] [other](../Other) `[[missing]]`\n\n```md\n[[missing]]\n```',
      'notes/Start.md',
      paths,
    ).sort(),
    ['Other.md', 'notes/Next.md'],
  )
})

test('Obsidian vault opens in place with wiki links, SVG embeds and backup prompt', {
  timeout: 40000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-obsidian-vault-'))
  const root = join(folder, 'vault')
  await mkdir(root)
  await mkdir(join(root, '.obsidian'))
  await mkdir(join(root, 'attachments'))
  await writeFile(
    join(root, '.obsidian', 'community-plugins.json'),
    '["dataview"]',
  )
  await writeFile(
    join(root, '.obsidian', 'app.json'),
    '{"attachmentFolderPath":"attachments"}',
  )
  const note = join(root, 'Start.md')
  const original =
    '---\ntags: [project/work]\n---\n\n[[Other|Next note]]\n\n![[drawing.svg|100]]\n\n==important==\n\n> [!tip]- Custom title\n> Keep this callout.\n'
  await writeFile(note, original)
  await writeFile(join(root, 'Other.md'), '# Other\n\n[back](Start)\n')
  await writeFile(
    join(root, 'attachments', 'drawing.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await page.getByRole('textbox', { name: 'Document editor' }).waitFor()
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
  }, root)
  // Main publishes the new workspace before it replies, so the vault prompt can
  // open Settings while the folder is still opening.
  const holdReply = (channel, path) =>
    app.evaluate(
      ({ ipcMain }, { channel, path }) => {
        const handler = ipcMain._invokeHandlers.get(channel)
        ipcMain._invokeHandlers.set(channel, async (event, ...args) => {
          ipcMain._invokeHandlers.set(channel, handler)
          const released = new Promise((resolve) => {
            globalThis.releaseReply = resolve
          })
          const result = await handler(event, ...(path ? [path] : args))
          await released
          return result
        })
      },
      { channel, path },
    )
  const settingsStayOpen = async () => {
    await page.getByRole('main', { name: 'Settings' }).waitFor()
    await app.evaluate(() => globalThis.releaseReply())
    await page.waitForFunction(
      () =>
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
    )
    assert.equal(
      await page.locator('.app').getAttribute('data-screen'),
      'settings',
    )
  }
  await holdReply('workspace:open')
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+o`,
  )
  const warning = page.getByRole('dialog', {
    name: 'Back up this Obsidian vault',
  })
  await warning.waitFor()
  await warning.getByText(/community plugins/i).waitFor()
  await warning.getByText(/Enable a relevant Hibi addon/i).waitFor()
  await warning.getByRole('button', { name: 'Review addons' }).waitFor()
  await warning.getByRole('button', { name: 'Review addons' }).click()
  await settingsStayOpen()
  await page.getByRole('button', { name: 'Back to app' }).click()
  assert.equal(
    await page.getByRole('treeitem', { name: '.obsidian' }).count(),
    0,
  )
  await page.getByRole('treeitem', { name: 'Start.md' }).click()
  const rich = page.getByRole('textbox', { name: 'Document editor' })
  const link = rich.locator('a[data-wiki-link="Other"]')
  await link.waitFor()
  assert.equal(await link.innerText(), 'Next note')
  const media = rich.locator('.obsidian-embed img')
  assert.equal(await rich.locator('mark').innerText(), 'important')
  const callout = rich.locator('[data-alert="tip"]')
  await callout.waitFor()
  assert.equal(await callout.getAttribute('data-fold'), '-')
  assert.match(await callout.innerText(), /Custom title/)
  await page.waitForFunction(
    (img) =>
      img?.getAttribute('src')?.startsWith('app://hibi/document-media/') &&
      img.complete &&
      img.naturalWidth > 0,
    await media.elementHandle(),
  )
  assert.equal(await media.getAttribute('width'), '100')
  assert.equal(await readFile(note, 'utf8'), original)
  await link.click({ modifiers: ['Shift'] })
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'Other.md',
  )
  await rich.getByRole('link', { name: 'back' }).click({ modifiers: ['Shift'] })
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'Start.md',
  )
  await page.getByRole('button', { name: 'Toggle right sidebar' }).click()
  await page.getByRole('button', { name: 'Right sidebar views' }).click()
  await page.getByRole('menuitem', { name: 'Backlinks' }).click()
  await page
    .getByRole('complementary', { name: 'Backlinks' })
    .getByText('Other.md')
    .waitFor()
  assert.equal(
    await readFile(join(root, '.obsidian', 'community-plugins.json'), 'utf8'),
    '["dataview"]',
  )

  const plainRoot = join(folder, 'plain-vault')
  await mkdir(join(plainRoot, '.obsidian'), { recursive: true })
  await writeFile(join(plainRoot, 'Plain.md'), '# Plain\n')
  await app.evaluate(({ dialog }, vault) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [vault],
    })
  }, plainRoot)
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+o`,
  )
  await warning.waitFor()
  assert.equal(await warning.locator('.dialog-content').isVisible(), false)
  const continueButton = warning
    .locator('.dialog-footer')
    .getByRole('button', { name: 'Continue' })
  await continueButton.click()
  await warning.waitFor({ state: 'hidden' })

  const droppedRoot = join(folder, 'dropped-vault')
  await mkdir(join(droppedRoot, '.obsidian'), { recursive: true })
  await writeFile(
    join(droppedRoot, '.obsidian', 'community-plugins.json'),
    '["dataview"]',
  )
  // A synthetic file has no path, so main receives the folder path instead.
  await holdReply('media:open-dropped', droppedRoot)
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File([''], 'dropped-vault'))
    document.querySelector('.app').dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
      }),
    )
  })
  await warning.getByRole('button', { name: 'Review addons' }).click()
  await settingsStayOpen()

  // Settings reopened through forward history also count as opened meanwhile.
  const notes = join(folder, 'notes')
  await mkdir(notes)
  await app.evaluate(({ dialog }, notes) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [notes],
    })
  }, notes)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${mod}+[`)
  await page.locator('.app[data-screen="editor"]').waitFor()
  await holdReply('workspace:open')
  await pressShortcut(app, `${mod}+Shift+o`)
  await page.locator('.app[aria-busy="true"]').waitFor()
  await pressShortcut(app, `${mod}+]`)
  await settingsStayOpen()
})

test('a startup vault keeps Settings opened from its backup prompt', {
  timeout: 30000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-obsidian-startup-'))
  const vault = join(folder, 'vault')
  const profile = join(folder, 'profile')
  await mkdir(join(vault, '.obsidian'), { recursive: true })
  await mkdir(profile)
  await writeFile(
    join(vault, '.obsidian', 'community-plugins.json'),
    '["dataview"]',
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(() => globalThis.releaseReply?.())
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await page.getByRole('textbox', { name: 'Document editor' }).waitFor()
  // The external-document queue opens the startup folder, publishing the vault
  // before it replies.
  await writeFile(
    join(profile, 'workspace-settings.json'),
    JSON.stringify({
      enabled: false,
      path: null,
      startup: 'folder',
      startupFolder: vault,
    }),
  )
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const read = ipcMain._invokeHandlers.get('document:external')
    ipcMain._invokeHandlers.set('document:external', async (...args) => {
      ipcMain._invokeHandlers.set('document:external', read)
      const released = new Promise((resolve) => {
        globalThis.releaseReply = resolve
      })
      const result = await read(...args)
      await released
      return result
    })
    BrowserWindow.getAllWindows()[0].webContents.send(
      'document:external-pending',
    )
  })
  await page
    .getByRole('dialog', { name: 'Back up this Obsidian vault' })
    .getByRole('button', { name: 'Review addons' })
    .click()
  await page.getByRole('main', { name: 'Settings' }).waitFor()
  await app.evaluate(() => globalThis.releaseReply())
  await page.waitForFunction(
    () => document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
  )
  assert.equal(
    await page.locator('.app').getAttribute('data-screen'),
    'settings',
  )
})
