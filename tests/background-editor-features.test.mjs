import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

/**
 * Starts with a background addon whose source and formatted editor features
 * never finish setting up once `window.hungFeatureHeld` is set.
 */
async function launch(t) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-background-features-'))
  const directory = join(profile, 'installed-addons', 'hung-feature')
  const file = join(profile, 'note.md')
  await mkdir(directory, { recursive: true })
  await writeFile(file, 'Some text')
  await writeFile(
    join(directory, 'hibi-addon.json'),
    JSON.stringify({
      id: 'hung-feature',
      name: 'Hung feature',
      description: 'Background editor feature fixture.',
      kind: 'extension',
      apiVersion: 3,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
      startup: 'background',
    }),
  )
  await writeFile(
    join(directory, 'index.js'),
    `const create = () => {
      window.hungFeatureCreates = (window.hungFeatureCreates || 0) + 1;
      return window.hungFeatureHeld ? new Promise(() => {}) : [];
    };
    export default { start(context) {
      window.hungFeatureStarts = (window.hungFeatureStarts || 0) + 1;
      context.editor.registerSource({ id: 'hung', create });
      context.editor.registerFormatted({ id: 'hung', create });
    } };`,
  )
  await writeFile(
    join(directory, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'hung-feature': true }),
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
  await waitForDocumentEditor(app, page)
  await page.evaluate(() => {
    window.hungFeatureHeld = true
  })
  // The addon starts in the background once the window is idle.
  await waitForAsync(page, () => window.hungFeatureStarts === 1)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  return { app, page }
}

const markdown = async (page) =>
  (await page.evaluate(() => window.hibi.getDocument())).markdown

test("a background addon's editor features that never finish setting up leave new editors editable", {
  timeout: 60000,
}, async (t) => {
  const { app, page } = await launch(t)
  const before = await page.evaluate(() => window.hungFeatureCreates ?? 0)
  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'note.md',
  )
  // The note's formatted editor asks the addon to set up its feature, and
  // takes input without waiting for it.
  await waitForDocumentEditor(app, page)
  assert.ok((await page.evaluate(() => window.hungFeatureCreates)) > before)
  await page.locator('.rich-pane .cm-content').click()
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'Some text!',
  )
  // So does the source editor Source view mounts.
  const created = await page.evaluate(() => window.hungFeatureCreates)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  assert.ok((await page.evaluate(() => window.hungFeatureCreates)) > created)
  await page.locator('.source-pane .cm-content').click()
  await page.keyboard.press('End')
  await page.keyboard.type('?')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'Some text!?',
  )
  assert.equal(await markdown(page), 'Some text!?')
})
