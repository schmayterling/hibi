import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  waitForAddonShortcut,
  waitForDocumentEditor,
} from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

/**
 * Opens a note, then runs the declared command of a background addon whose
 * formatted editor feature does not finish creating until
 * `window.finishSlowFeature()` or `window.failSlowFeature()`, so the command
 * waits for it. The command records the editor it ran in. Its source editor
 * feature is ready at once. Background starts and the wait's 5 s ceiling are
 * held.
 */
async function waitingCommand(t, { sideBySide = false } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-addon-command-features-'))
  const directory = join(profile, 'installed-addons', 'slow-feature')
  const file = join(profile, 'note.md')
  await mkdir(directory, { recursive: true })
  await writeFile(file, 'Some text')
  await writeFile(
    join(directory, 'hibi-addon.json'),
    JSON.stringify({
      id: 'slow-feature',
      name: 'Slow feature',
      description: 'Background editor feature fixture.',
      kind: 'extension',
      apiVersion: 3,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
      startup: 'background',
      commands: [
        {
          id: 'probe',
          label: 'Probe slow feature',
          defaultShortcut: 'ctrl+alt+shift+p',
        },
      ],
    }),
  )
  await writeFile(
    join(directory, 'index.js'),
    `export default { start(context) {
      context.editor.registerFormatted({ id: 'slow', create() {
        window.slowFeatureCreates = (window.slowFeatureCreates || 0) + 1;
        if (!window.slowFeatureHeld) return [];
        return new Promise((resolve, reject) => {
          window.finishSlowFeature = () => resolve([]);
          window.failSlowFeature = () => reject(new Error('The slow feature failed.'));
        });
      } });
      context.editor.registerSource({ id: 'quick', create: () => [] });
      context.commands.register({ id: 'probe', label: 'Probe slow feature', run({ view }) {
        window.slowFeatureRuns = (window.slowFeatureRuns || 0) + 1;
        const selection = context.editorViews.getSelection(view);
        window.slowFeatureEditor = selection.ok ? selection.value.editor : selection.code;
      } });
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
  // No other addon has editor features, whose installs would also end the wait.
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({
      'slow-feature': true,
      'slash-commands': false,
      tags: false,
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
  await waitForDocumentEditor(app, page)
  // The script reaches the window from its next load. Only then does the
  // feature never finish creating.
  await app.context().addInitScript(() => {
    window.slowFeatureHeld = true
    const idle = window.requestIdleCallback.bind(window)
    window.requestIdleCallback = (callback, options) =>
      options?.timeout === 1000 ? 0 : idle(callback, options)
    const timeout = window.setTimeout.bind(window)
    window.setTimeout = (callback, delay, ...rest) =>
      delay === 5000 ? 0 : timeout(callback, delay, ...rest)
  })
  await page.reload()
  await waitForDocumentEditor(app, page)
  await waitForAddonShortcut(page, 'slow-feature.probe')
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'note.md',
  )
  await waitForDocumentEditor(app, page)
  // Hidden windows have no focus; the panes' own focus needs emulating.
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  if (sideBySide) {
    await page
      .getByRole('button', { name: /^side-by-side$/i, exact: true })
      .click()
    await page.locator('.source-pane .cm-content').waitFor()
  }
  await page.locator('.rich-pane .formatted-editor .cm-content').click()
  // The shortcut starts the addon; its command then waits for the feature.
  await pressShortcut(app, 'Control+Alt+Shift+P')
  await waitForAsync(page, () => window.slowFeatureCreates > 0)
  return { app, page }
}

const notice = (page, text) => page.getByText(text).first().waitFor()

test('a command waiting for its editor feature runs once that feature fails', {
  timeout: 60000,
}, async (t) => {
  const { page } = await waitingCommand(t)
  await page.evaluate(() => window.failSlowFeature())
  await notice(
    page,
    'Slow feature could not start its formatted editor feature.',
  )
  await waitForAsync(page, () => window.slowFeatureRuns === 1)
})

test('a command waiting for its editor feature gives up once its addon is turned off', {
  timeout: 60000,
}, async (t) => {
  const { app, page } = await waitingCommand(t)
  // The Addon Manager turns it off through this window's addon host.
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-slow-feature').click()
  await notice(page, 'This command is no longer available.')
  assert.equal(await page.evaluate(() => window.slowFeatureRuns ?? 0), 0)
})

test('a command waiting for its editor feature gives up once its view closes', {
  timeout: 60000,
}, async (t) => {
  const { app, page } = await waitingCommand(t)
  await pressShortcut(app, `${mod}+w`)
  await notice(page, 'The command target is no longer available.')
  assert.equal(await page.evaluate(() => window.slowFeatureRuns ?? 0), 0)
})

/** The command has not run yet, two frames after anything that could end its wait. */
async function stillWaiting(page) {
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  )
  assert.equal(await page.evaluate(() => window.slowFeatureRuns ?? 0), 0)
}

test('a command waiting for its editor feature follows its view into the source editor', {
  timeout: 60000,
}, async (t) => {
  const { page } = await waitingCommand(t)
  await stillWaiting(page)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForAsync(page, () => window.slowFeatureRuns === 1)
  assert.equal(await page.evaluate(() => window.slowFeatureEditor), 'source')
})

// Source view's editor mounts after the switch; the hidden formatted editor
// showing its feature meanwhile must not end the wait.
test('a command waiting for its editor feature waits for the source editor it switched to', {
  timeout: 60000,
}, async (t) => {
  const { page } = await waitingCommand(t)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await page.evaluate(() => window.finishSlowFeature())
  await waitForAsync(page, () => window.slowFeatureRuns === 1)
  assert.equal(await page.evaluate(() => window.slowFeatureEditor), 'source')
})

// Both editors are already up side by side; only focus moves.
test('a command waiting for its editor feature follows focus into the source pane beside it', {
  timeout: 60000,
}, async (t) => {
  const { page } = await waitingCommand(t, { sideBySide: true })
  await stillWaiting(page)
  await page.locator('.source-pane .cm-content').click()
  await waitForAsync(page, () => window.slowFeatureRuns === 1)
  assert.equal(await page.evaluate(() => window.slowFeatureEditor), 'source')
})
