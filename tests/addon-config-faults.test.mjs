import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const source = '# Title\n\n**strong** and ==proof==\n'

for (const engine of ['default', 'codemirror']) {
  test(`${engine} engine quarantines invalid syntax configuration before source startup`, {
    timeout: 90000,
  }, async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'hibi-config-fault-'))
    const profile = join(folder, 'profile')
    const file = join(folder, 'note.md')
    const addon = join(profile, 'installed-addons', 'configuration-proof')
    await mkdir(addon, { recursive: true })
    await writeFile(file, source)
    await writeFile(
      join(addon, 'hibi-addon.json'),
      JSON.stringify({
        id: 'configuration-proof',
        name: 'Configuration proof',
        description: 'Configuration fixture',
        apiVersion: 3,
        capabilities: ['formatted'],
        version: '1.0.0',
        kind: 'extension',
        authors: [{ displayName: 'Test' }],
        entry: 'index.js',
      }),
    )
    await writeFile(
      join(addon, 'index.js'),
      `export default () => ({ start(context) {
      context.editor.registerFlavor({
        id: 'bad', name: 'Bad configuration', kind: 'syntax', description: 'Fixture', detect: () => true,
        syntax: { defineNodes: ['ConfigurationProofNode'], parseInline: [{ name: 'ConfigurationProofNode', before: 'MissingConfigAnchor', parse: () => -1 }] },
      })
    } })`,
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
      JSON.stringify({ 'configuration-proof': true }),
    )
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    t.after(async () => {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      await app.close()
      await rm(folder, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await waitForDocumentEditor(app, page)
    if (engine === 'codemirror') {
      await page.evaluate(() =>
        localStorage.setItem('hibi:formatted-engine', 'codemirror'),
      )
    }
    // Opening a note clears the current error toast. Retain startup attribution.
    await page.addInitScript(() => {
      window.configurationNotices = []
      const seen = new Set()
      new MutationObserver(() => {
        for (const toast of document.querySelectorAll('.toast')) {
          const text = toast.textContent
          if (text && !seen.has(text)) {
            seen.add(text)
            window.configurationNotices.push(text)
          }
        }
      }).observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    })
    await page.reload()
    await waitForDocumentEditor(app, page)
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, file)
    await pressShortcut(app, `${mod}+o`)
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      source,
    )
    await page
      .locator(
        engine === 'codemirror'
          ? '.rich-pane .hibi-lp-strong'
          : '.rich-pane .tiptap strong',
      )
      .waitFor()
    await page.getByRole('button', { name: 'Source view', exact: true }).click()
    await page
      .locator('.source-pane .cm-content[contenteditable="true"]')
      .waitFor()
    try {
      await waitForAsync(page, () =>
        window.configurationNotices.some((text) =>
          /configuration-proof\.bad:.*unknown parser MissingConfigAnchor/i.test(
            text,
          ),
        ),
      )
    } finally {
      t.diagnostic(
        JSON.stringify({
          engine,
          notices: await page.evaluate(() => window.configurationNotices),
        }),
      )
    }
    assert.equal(
      await page
        .getByText('The editor stopped working', { exact: true })
        .count(),
      0,
    )
    assert.equal(
      await page
        .getByText('Could not load the markdown editor language.', {
          exact: true,
        })
        .count(),
      0,
    )
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await page.evaluate(() => {
      const view = document.querySelector('.source-pane .cm-content').cmTile
        .root.view
      view.dispatch({ selection: { anchor: view.state.doc.length } })
      view.focus()
    })
    await page.keyboard.insertText('z')
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      source + 'z',
    )
    await pressShortcut(app, `${mod}+z`)
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      source,
    )
    assert.deepEqual(errors, [])
  })
}
