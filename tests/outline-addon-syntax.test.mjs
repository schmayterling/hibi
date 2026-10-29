import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
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

test('the source outline follows addon syntax and names addons it cannot follow', {
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
  // Marked block syntax only the visual editor reads.
  await install(
    profile,
    'outline-boxes',
    { name: 'Box blocks', apiVersion: 2 },
    `export default () => ({ start(context) {
      context.editor.registerFlavor({ id: 'boxes', name: 'Box blocks',
        kind: 'syntax', description: 'Fixture', detect: () => false,
        export: { extensions: [{ extensions: [{ name: 'outlineBox',
          level: 'block', start: (src) => src.indexOf(':::box'),
          tokenizer(src) {
            const match = /^:::box\\n[\\s\\S]*?\\n:::(?:\\n|$)/.exec(src)
            if (match) return { type: 'outlineBox', raw: match[0] }
          },
          renderer: () => '' }] }] } })
    } })`,
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({
      'outline-notes': true,
      'outline-boxes': false,
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
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await clickMenu(app, 'Open…')
  await page.waitForFunction(() =>
    document.querySelector('.tiptap')?.editor?.getText().includes('words'),
  )
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

  const toggle = async (id) => {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
    const checked = await page.locator(`#addon-${id}`).isChecked()
    await page.locator(`#addon-${id}`).click()
    await page.waitForFunction(
      ([id, checked]) =>
        document.querySelector(`#addon-${id}`)?.checked !== checked,
      [id, checked],
    )
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await page.locator('.settings-screen').waitFor({ state: 'hidden' })
  }
  // Block syntax the outline cannot read names its addon and what to do.
  await toggle('outline-boxes')
  const notice = outline.getByText(
    'The outline can’t find headings in source view while Box blocks is on. Switch to visual mode to see them, or turn off Box blocks in Settings → Addon Manager.',
    { exact: true },
  )
  await notice.waitFor()
  assert.deepEqual(await headings(), [])
  // Visual mode still lists the note's headings.
  await page.getByRole('button', { name: 'normal', exact: true }).click()
  await outline.getByRole('treeitem', { name: 'Top', exact: true }).waitFor()
  assert.equal(await notice.count(), 0)
  // Turning the addon off restores the source outline.
  await page.getByRole('button', { name: /^source view$/i }).click()
  await notice.waitFor()
  await toggle('outline-boxes')
  await outline.getByRole('treeitem', { name: 'After', exact: true }).waitFor()
  assert.deepEqual(await headings(), ['Top', 'After'])
})
