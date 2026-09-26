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
  await page.getByRole('main', { name: 'Settings' }).waitFor()
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
    (img) => img?.getAttribute('src')?.startsWith('data:image/svg+xml;base64,'),
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
})
