import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForFormattedEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

const install = async (profile, id, manifest, code) => {
  const folder = join(profile, 'installed-addons', id)
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id,
      description: 'Outline fixture',
      kind: 'extension',
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
      ...manifest,
    }),
  )
  await writeFile(join(folder, 'index.js'), code)
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
}

test('the source outline follows addon syntax', {
  timeout: 90000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-outline-addons-'))
  const file = join(profile, 'notes.md')
  await writeFile(
    file,
    '# Top\n\n:::note\n# not a heading\n:::\n\n## After\n\nwords\n',
  )
  // Lezer block syntax: the source view and the outline read `:::note` blocks.
  await install(
    profile,
    'outline-notes',
    { name: 'Note blocks', apiVersion: 3, capabilities: ['formatted'] },
    `export default () => ({ start(context) {
      context.editor.registerFlavor({ id: 'notes', name: 'Note blocks',
        kind: 'syntax', description: 'Fixture', detect: () => false,
        syntax: {
          defineNodes: [{ name: 'OutlineNotesBlock', block: true }],
          parseBlock: [{ name: 'OutlineNotesBlock', before: 'FencedCode',
            parse(cx, line) {
              if (!/^:::note[ \\t]*$/.test(line.text)) return false
              const from = cx.lineStart
              let to = from + line.text.length
              while (cx.nextLine()) {
                to = cx.lineStart + line.text.length
                if (/^:::[ \\t]*$/.test(line.text)) { cx.nextLine(); break }
              }
              cx.addElement(cx.elt('OutlineNotesBlock', from, to))
              return true
            } }],
        } })
    } })`,
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({
      'outline-notes': true,
      typst: true,
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
  page.setDefaultTimeout(10000)
  await waitForFormattedEditor(app, page)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await clickMenu(app, 'Open…')
  await page.locator('.rich-pane .cm-content', { hasText: 'words' }).waitFor()
  await page.getByRole('button', { name: /^source view$/i }).click()
  await page
    .getByRole('textbox', { name: 'Markdown editor', exact: true })
    .waitFor()
  await page.getByRole('button', { name: /^toggle right sidebar$/i }).click()
  await page.getByRole('button', { name: /^right sidebar views$/i }).click()
  await page
    .getByRole('menuitem', { name: 'On this page', exact: true })
    .click()
  const outline = page.locator(
    '.outline-sidebar[data-side="right"][data-open="true"]',
  )
  const headings = async () =>
    (await outline.getByRole('treeitem').allTextContents()).map((text) =>
      text.trim(),
    )

  // Typst and the Lezer note blocks keep the source outline.
  await outline.getByRole('treeitem', { name: 'After', exact: true }).waitFor()
  t.diagnostic(
    JSON.stringify({
      stage: 'notes + typst',
      text: await outline.textContent(),
    }),
  )
  assert.deepEqual(await headings(), ['Top', 'After'])
})
