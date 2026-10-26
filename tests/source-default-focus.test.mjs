import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, splitTab } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

for (const engine of ['tiptap', 'codemirror']) {
  test(`${engine}: source default focuses its editor before immediate typing`, {
    timeout: 30000,
  }, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-source-default-focus-'))
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
    page.setDefaultTimeout(7000)
    await waitForDocumentEditor(app, page)
    await page.evaluate((engine) => {
      localStorage.setItem('hibi:formatted-engine', engine)
      localStorage.setItem('default-view', 'markdown')
    }, engine)
    await page.reload()
    await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
    })
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.getAttribute('aria-label'),
      ),
      'Markdown editor',
    )
    await page.keyboard.type('Type immediately')
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      'Type immediately',
    )
  })
}

test('split source panes preserve independent selections and target typing', {
  timeout: 60000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-split-source-focus-'))
  const files = [join(root, 'a.md'), join(root, 'b.md')]
  await writeFile(files[0], 'alpha left source')
  await writeFile(files[1], 'beta right source')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.evaluate(() => {
    localStorage.setItem('hibi:formatted-engine', 'codemirror')
    localStorage.setItem('default-view', 'markdown')
  })
  await page.reload()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const ids = []
  for (const file of files) {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      file.endsWith('a.md') ? 'a.md' : 'b.md',
    )
    await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
    ids.push((await page.evaluate(() => window.hibi.getDocument())).tabId)
  }
  await page.getByRole('tab', { name: 'a.md', exact: true }).click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    ids[0],
  )
  await splitTab(app, page, ids[1])
  await waitForAsync(
    page,
    async (id) =>
      (await window.hibi.getDocument()).tabId === id &&
      ['left', 'right'].every((side) =>
        document
          .querySelector(
            `.editor-page[data-side="${side}"] .source-pane .cm-content`,
          )
          ?.closest('.editor-panes[data-source-ready="true"]'),
      ),
    ids[1],
  )
  // Split document views pass autoFocus=false; readiness must keep their carets.
  await page.evaluate(() => {
    for (const [side, anchor] of [
      ['left', 2],
      ['right', 5],
    ]) {
      const view = document.querySelector(
        `.editor-page[data-side="${side}"] .source-pane .cm-content`,
      ).cmTile.root.view
      view.dispatch({ selection: { anchor } })
    }
  })
  for (const [side, id, expected, head] of [
    ['right', ids[1], 'beta xright source', 6],
    ['left', ids[0], 'alxpha left source', 3],
  ]) {
    const editor = page.locator(
      `.editor-page[data-side="${side}"] .source-pane .cm-content`,
    )
    await editor.evaluate((element) => element.cmTile.root.view.focus())
    await waitForAsync(
      page,
      async (id) =>
        (await window.hibi.getDocument()).tabId === id &&
        document.querySelector('.app').getAttribute('aria-busy') === 'false',
      id,
    )
    await page.keyboard.insertText('x')
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      expected,
    )
    assert.equal(
      await editor.evaluate(
        (element) => element.cmTile.root.view.state.selection.main.head,
      ),
      head,
    )
  }
  assert.deepEqual(
    await page.evaluate(() =>
      ['left', 'right'].map((side) => {
        const view = document.querySelector(
          `.editor-page[data-side="${side}"] .source-pane .cm-content`,
        ).cmTile.root.view
        return [view.state.doc.toString(), view.state.selection.main.head]
      }),
    ),
    [
      ['alxpha left source', 3],
      ['beta xright source', 6],
    ],
  )
})
