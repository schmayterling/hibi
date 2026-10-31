import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
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

/**
 * A background addon whose formatted feature's create() returns at once until
 * `window.featureModes[id]` is 'hold'; then it waits for
 * `window.releaseFeature[id]()`. Its declared command counts its runs.
 */
const heldFeatureAddon = (id) => `export default { start(context) {
  window.addonStarts = { ...window.addonStarts, ${JSON.stringify(id)}: 1 };
  context.editor.registerFormatted({ id: 'f', create() {
    window.featureCreates = { ...window.featureCreates, ${JSON.stringify(id)}: (window.featureCreates?.[${JSON.stringify(id)}] ?? 0) + 1 };
    if (window.featureModes?.[${JSON.stringify(id)}] !== 'hold') return [];
    return new Promise((resolve) => {
      window.releaseFeature = { ...window.releaseFeature, ${JSON.stringify(id)}: () => resolve([]) };
    });
  } });
  context.commands.register({ id: 'probe', label: 'Probe', run() {
    window.commandRuns = { ...window.commandRuns, ${JSON.stringify(id)}: (window.commandRuns?.[${JSON.stringify(id)}] ?? 0) + 1 };
  } });
} };`

/**
 * Starts with background addons, each with a declared command on its
 * shortcut, and holds the 5 s ceiling of a command's wait for its addon's
 * editor features, so a command runs only once its view shows them.
 */
async function launchHeld(t, shortcuts) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-background-features-'))
  const file = join(profile, 'note.md')
  await writeFile(file, 'Some text')
  for (const [id, defaultShortcut] of Object.entries(shortcuts)) {
    const directory = join(profile, 'installed-addons', id)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'hibi-addon.json'),
      JSON.stringify({
        id,
        name: id,
        description: 'Background editor feature fixture.',
        kind: 'extension',
        apiVersion: 3,
        version: '1.0.0',
        authors: [{ displayName: 'Test' }],
        entry: 'index.js',
        startup: 'background',
        commands: [{ id: 'probe', label: 'Probe', defaultShortcut }],
      }),
    )
    await writeFile(join(directory, 'index.js'), heldFeatureAddon(id))
    await writeFile(
      join(directory, '.hibi-install.json'),
      JSON.stringify({
        hash: 'a'.repeat(64),
        files: ['hibi-addon.json', 'index.js'],
        source: 'local',
      }),
    )
  }
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify(
      Object.fromEntries(Object.keys(shortcuts).map((id) => [id, true])),
    ),
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
  // The script reaches the window from its next load.
  await app.context().addInitScript(() => {
    const timeout = window.setTimeout.bind(window)
    window.setTimeout = (callback, delay, ...rest) =>
      delay === 5000 ? 0 : timeout(callback, delay, ...rest)
  })
  await page.reload()
  await waitForDocumentEditor(app, page)
  for (const id of Object.keys(shortcuts))
    await waitForAsync(page, (id) => window.addonStarts?.[id] === 1, id)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  return { app, page }
}

const openNote = async (app, page) => {
  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'note.md',
  )
  await waitForDocumentEditor(app, page)
}

test("a background addon's editor feature joins a new editor once it is set up, while another's never finishes", {
  timeout: 60000,
}, async (t) => {
  const { app, page } = await launchHeld(t, {
    stuck: 'ctrl+alt+shift+u',
    later: 'ctrl+alt+shift+l',
  })
  await page.evaluate(() => {
    window.featureModes = { stuck: 'hold', later: 'hold' }
  })
  await openNote(app, page)
  // Set up after the editor took input, while the other is still pending.
  await page.evaluate(() => window.releaseFeature.later())
  await page.locator('.rich-pane .cm-content').click()
  await pressShortcut(app, 'Control+Alt+Shift+L')
  await waitForAsync(page, () => window.commandRuns?.later === 1)
})

test('an editor keeps a background feature it has while that feature is set up again', {
  timeout: 60000,
}, async (t) => {
  const { app, page } = await launchHeld(t, {
    kept: 'ctrl+alt+shift+k',
    other: 'ctrl+alt+shift+o',
  })
  await openNote(app, page)
  await page.locator('.rich-pane .cm-content').click()
  await pressShortcut(app, 'Control+Alt+Shift+K')
  await waitForAsync(page, () => window.commandRuns?.kept === 1)
  const created = await page.evaluate(() => window.featureCreates.kept)
  await page.evaluate(() => {
    window.featureModes = { kept: 'hold' }
  })
  // A feature that leaves sets up every other feature again.
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-other').click()
  await waitForAsync(page, () => {
    const toggle = document.querySelector('#addon-other')
    return !!toggle && !toggle.checked && !toggle.disabled
  })
  await waitForAsync(
    page,
    (created) => window.featureCreates.kept > created,
    created,
  )
  await page.keyboard.press('Escape')
  await page.locator('.rich-pane .cm-content').click()
  await pressShortcut(app, 'Control+Alt+Shift+K')
  await waitForAsync(page, () => window.commandRuns?.kept === 2)
})
