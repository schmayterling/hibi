import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const notice =
  'Mixed features has features made for the previous formatted editor. Those features are off until it is updated; source view is unaffected.'

test('partially migrated addons keep each legacy feature literal through registration and activation changes', {
  timeout: 90000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-legacy-features-'))
  const profile = join(root, 'profile')
  const addon = join(profile, 'installed-addons', 'mixed-features')
  const file = join(root, 'note.md')
  const source = '# Title\n\n**one** and *two*\n'
  await mkdir(addon, { recursive: true })
  await writeFile(file, source)
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'mixed-features',
      name: 'Mixed features',
      description: 'Mixed feature fixture',
      apiVersion: 3,
      version: '1.0.0',
      kind: 'extension',
      authors: [{ displayName: 'Test' }],
      capabilities: ['formatted', 'source'],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(addon, 'index.js'),
    `export default sdk => ({
      start(context) {
        window.mixedStarts = (window.mixedStarts || 0) + 1
        const formatted = new Map()
        for (const [id, node, token] of [['one', 'StrongEmphasis', 'strong'], ['two', 'Emphasis', 'em']]) {
          context.editor.registerSyntax({ id, label: id, group: 'Mixed', level: 'inline', nodes: [node], matches: value => value.type === token })
          context.editor.registerRich({ id, attach: () => () => {} })
        }
        window.mixedFeatures = {
          migrate(id, fail = false) {
            formatted.get(id)?.()
            formatted.set(id, context.editor.registerFormatted({ id, create() {
              if (fail) throw Error('Mixed feature attachment failed')
              return sdk.codeMirror.view.EditorView.editorAttributes.of({ ['data-mixed-' + id]: 'yes' })
            } }))
          },
          remove(id) { formatted.get(id)?.(); formatted.delete(id) }
        }
        window.mixedFeatures.migrate('one')
        context.editor.registerSource({ id: 'source', create: () => sdk.codeMirror.view.EditorView.editorAttributes.of({ 'data-mixed-source': 'yes' }) })
        if (window.failMixedStart) throw Error('Mixed feature activation failed')
      },
      stop() { window.mixedStops = (window.mixedStops || 0) + 1 }
    })`,
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'mixed-features': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, 'codemirror')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await waitForAsync(
    page,
    async (source) => (await window.hibi.getDocument()).markdown === source,
    source,
  )
  await waitForDocumentEditor(app, page)
  const activeNotices = page
    .locator('.toast:not([data-closing="true"])')
    .filter({ hasText: notice })
  const compatibility = async (expected, name = 'Document editor') => {
    await waitForAsync(
      page,
      ({ notice, expected }) =>
        [
          ...document.querySelectorAll('.toast:not([data-closing="true"])'),
        ].filter((node) => node.textContent.includes(notice)).length ===
        Number(expected),
      { notice, expected },
    )
    assert.equal(await activeNotices.count(), Number(expected))
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
    assert.equal(
      await page
        .locator('[data-formatted-compatibility="mixed-features"]')
        .count(),
      Number(expected),
    )
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await waitForDocumentEditor(app, page, { name })
  }
  const toggleAddon = async () => {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
    await page.locator('#addon-mixed-features').click()
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  }
  const literal = async (one, two) => {
    await waitForAsync(
      page,
      ({ one, two }) =>
        !!document.querySelector('.rich-pane .hibi-lp-strong') === !one &&
        !!document.querySelector('.rich-pane .hibi-lp-em') === !two,
      { one, two },
    )
    const text = await page.locator('.rich-pane .cm-content').innerText()
    if (one) assert.ok(text.includes('**one**'))
    if (two) assert.ok(text.includes('*two*'))
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      source,
    )
  }
  await page.locator('.rich-pane [data-mixed-one="yes"]').waitFor()
  await compatibility(true)
  await literal(false, true)
  await page.evaluate(() => window.mixedFeatures.migrate('two'))
  await compatibility(false)
  await literal(false, false)
  await page.evaluate(() => window.mixedFeatures.remove('one'))
  await compatibility(true)
  await literal(true, false)
  await page.evaluate(() => window.mixedFeatures.remove('two'))
  await literal(true, true)
  await page.evaluate(() => window.mixedFeatures.migrate('two'))
  await literal(true, false)
  await compatibility(true)
  await page.evaluate(() => window.mixedFeatures.migrate('one'))
  await compatibility(false)
  await literal(false, false)

  await page.evaluate(() => window.mixedFeatures.migrate('two', true))
  await page
    .getByText('Mixed features could not start its formatted editor feature.', {
      exact: true,
    })
    .waitFor()
  await compatibility(true)
  await literal(false, true)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  const input = page.locator(
    '.source-pane [data-mixed-source="yes"] .cm-content',
  )
  await input.waitFor()
  assert.equal(await page.locator('.source-pane [data-mixed-one]').count(), 0)
  await input.press(`${mod}+End`)
  await input.type('x')
  await waitForAsync(
    page,
    async (source) =>
      (await window.hibi.getDocument()).markdown === `${source}x`,
    source,
  )
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (source) => (await window.hibi.getDocument()).markdown === source,
    source,
  )
  await toggleAddon()
  await waitForAsync(page, () => !document.querySelector('[data-mixed-source]'))
  await compatibility(false, 'Markdown editor')
  await page.evaluate(() => {
    window.failMixedStart = true
  })
  await toggleAddon()
  await page
    .getByText('Mixed feature activation failed', { exact: true })
    .waitFor()
  await compatibility(false, 'Markdown editor')
  assert.equal(await page.locator('[data-mixed-source]').count(), 0)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    source,
  )
  await toggleAddon()
  await page.evaluate(() => {
    window.failMixedStart = false
  })
  await toggleAddon()
  await input.waitFor()
  await compatibility(true, 'Markdown editor')
  await page.getByRole('button', { name: 'normal', exact: true }).click()
  await page.locator('.rich-pane [data-mixed-one="yes"]').waitFor()
  await literal(false, true)
  assert.equal(await page.evaluate(() => window.mixedStarts), 3)
  assert.equal(await page.evaluate(() => window.mixedStops), 2)
})
