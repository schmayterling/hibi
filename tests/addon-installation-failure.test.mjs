import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('failed editor attachments stay read-only and disabling the addon restores editing', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-addon-failure-'))
  const folder = join(profile, 'installed-addons', 'broken-editor')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'broken-editor',
      name: 'Broken editor',
      kind: 'extension',
      description: 'Failure fixture',
      apiVersion: 1,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['index.js', 'hibi-addon.json'],
      source: 'local',
    }),
  )
  await writeFile(
    join(folder, 'index.js'),
    `export default () => ({
    start(context) {
      context.toolbar.register({id:'probe', label:'Failure probe', onClick(){}});
      context.editor.registerRich({id:'a-first', attach() {
        return () => document.documentElement.dataset.partialDetached = 'true';
      }});
      context.editor.registerRich({id:'broken', attach() { throw new Error('rich failed'); }});
      context.editor.registerSource({id:'broken', async create() { throw new Error('source failed'); }});
    },
    stop() { throw new Error('stop failed'); }
  });`,
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'broken-editor': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text())
  })
  try {
    await page
      .locator('.rich-pane .document-notice')
      .filter({ hasText: /editor addon unavailable/i })
      .waitFor()
  } catch (error) {
    let diagnosticTimer
    const snapshot = page
      .evaluate(async () => ({
        main: {
          states: await window.hibi.getAddonStates(),
          installed: (await window.hibi.getInstalledAddons()).map(
            ({ manifest, url }) => ({
              id: manifest.id,
              url,
            }),
          ),
        },
        renderer: {
          body: document.body.innerText.slice(0, 1000),
          busy: document
            .querySelector('.editor-page')
            ?.getAttribute('aria-busy'),
          richPane: document
            .querySelector('.rich-pane')
            ?.outerHTML.slice(0, 800),
          detached: document.documentElement.dataset.partialDetached,
          measures: performance
            .getEntriesByType('measure')
            .filter(({ name }) => name.startsWith('hibi:addon'))
            .map(({ name, duration, detail }) => ({ name, duration, detail })),
        },
      }))
      .catch((diagnosticError) => ({ error: String(diagnosticError) }))
    const state = await Promise.race([
      snapshot,
      new Promise((resolve) => {
        diagnosticTimer = setTimeout(
          () => resolve({ error: 'Renderer diagnostic timed out' }),
          1000,
        )
      }),
    ])
    clearTimeout(diagnosticTimer)
    console.error('addon failure state:', JSON.stringify({ state, pageErrors }))
    throw error
  }
  assert.equal(
    await page.locator('.tiptap').evaluate((el) => el.isContentEditable),
    false,
  )
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.partialDetached),
    'true',
  )
  await page
    .getByRole('button', { name: 'Source view', exact: true })
    .press('Enter')
  await page
    .locator('.source-pane .document-notice')
    .waitFor({ state: 'visible' })
  assert.equal(
    await page.locator('.cm-content').evaluate((el) => el.isContentEditable),
    false,
  )
  assert.equal(
    await page.locator('.editor-panes').getAttribute('data-source-ready'),
    'false',
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-broken-editor').click()
  await page.waitForFunction(
    () => document.querySelector('#addon-broken-editor')?.checked === false,
  )
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.cm-content')?.isContentEditable,
  )
  assert.equal(await page.locator('.source-pane .document-notice').count(), 0)
  assert.equal(
    await page.locator('[data-toolbar-id="broken-editor.probe"]').count(),
    0,
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.isContentEditable,
  )
  assert.equal(await page.locator('.rich-pane .document-notice').count(), 0)
})
