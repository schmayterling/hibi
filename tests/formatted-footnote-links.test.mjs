import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

const filler = Array.from(
  { length: 120 },
  (_, i) => `Paragraph ${i} between the reference and its definition.`,
).join('\n\n')
const note = `See the note[^far] here and missing[^unknown].

| name | note |
| --- | --- |
| cell | a reference[^Far] in a table |

${filler}

[^far]: The far definition.

[^FAR]: The duplicate definition.
`

test('footnote references are links that move to their definitions', {
  timeout: 120000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-footnote-links-'))
  const file = join(root, 'note.md')
  await writeFile(file, note)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  await waitForDocumentEditor(app, page)
  await page.evaluate(() => {
    localStorage.setItem('hibi:formatted-engine', 'codemirror')
    localStorage.setItem('markdown-markers', 'false')
  })
  await page.reload()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, file)
  await clickMenu(app, 'Open…')
  const rich = page.locator('.rich-pane')
  const reference = rich.getByRole('link', { name: 'far', exact: true })
  const cell = rich.getByRole('link', { name: 'Far', exact: true })
  await reference.waitFor()
  await cell.waitFor()
  assert.equal(
    await rich.getByRole('link', { name: 'unknown', exact: true }).count(),
    0,
  )
  const cdp = await page.context().newCDPSession(page)
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: 'document.querySelector(".rich-pane")',
  })
  const { nodes } = await cdp.send('Accessibility.queryAXTree', {
    objectId: result.objectId,
    role: 'link',
  })
  assert.deepEqual(
    nodes.filter((node) => !node.ignored).map((node) => node.name?.value),
    ['far', 'Far'],
  )
  assert.equal(
    await reference.evaluate(
      (element) => getComputedStyle(element).textDecorationLine,
    ),
    'none',
  )
  let target = 'The far definition'
  let definition = note.indexOf(target)
  const state = () =>
    page.evaluate((target) => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      const line = [...view.contentDOM.querySelectorAll('.cm-line')].find(
        (element) => element.textContent.includes(target),
      )
      const box = line?.getBoundingClientRect()
      const pane = document.querySelector('.rich-pane').getBoundingClientRect()
      return {
        head: view.state.selection.main.head,
        shown: !!box && box.top >= pane.top && box.bottom <= pane.bottom,
      }
    }, target)
  const arrived = () =>
    page.waitForFunction(
      ({ definition, target }) => {
        const view = document.querySelector('.rich-pane .cm-content').cmTile
          .root.view
        const line = [...view.contentDOM.querySelectorAll('.cm-line')].find(
          (element) => element.textContent.includes(target),
        )
        const at = line?.getBoundingClientRect()
        const box = document.querySelector('.rich-pane').getBoundingClientRect()
        return (
          view.state.selection.main.head === definition &&
          at &&
          at.top >= box.top &&
          at.bottom <= box.bottom
        )
      },
      { definition, target },
    )
  const top = () =>
    page.evaluate(() => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true })
    })
  // A plain click edits the reference.
  await reference.click()
  assert.notEqual((await state()).head, definition)
  const follows = [['Shift']]
  if (process.platform === 'darwin') follows.push(['Control', 'Meta'])
  for (const link of [reference, cell])
    for (const modifiers of follows) {
      await top()
      await link.click({ modifiers })
      await arrived()
      assert.deepEqual(await state(), { head: definition, shown: true })
    }
  // The reference in the cell being edited uses the owning note's index.
  await top()
  await cell.click()
  const editing = rich
    .locator('.hibi-lp-cell-editor')
    .getByRole('link', { name: 'Far', exact: true })
  await editing.waitFor()
  await editing.click({ modifiers: ['Shift'] })
  await arrived()
  assert.deepEqual(await state(), { head: definition, shown: true })
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector('.rich-pane .cm-content')
        .cmTile.root.view.state.doc.toString(),
    ),
    note,
  )
  // Unchanged definition stretches move with a preceding edit.
  const prefix = 'New paragraph before the references.\n\n'
  await page.evaluate((prefix) => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({
      changes: { from: 0, insert: prefix },
      selection: { anchor: 0 },
      scrollIntoView: true,
    })
  }, prefix)
  definition += prefix.length
  await reference.click({ modifiers: ['Shift'] })
  await arrived()
  assert.deepEqual(await state(), { head: definition, shown: true })

  // Removing the first definition makes body and table links use the duplicate.
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    const from = view.state.doc.toString().indexOf('[^far]:')
    view.dispatch({
      changes: { from, to: from + '[^far]:'.length },
      selection: { anchor: 0 },
      scrollIntoView: true,
    })
  })
  const edited = prefix + note.replace('[^far]:', '')
  target = 'The duplicate definition'
  definition = edited.indexOf(target)
  for (const link of [reference, cell]) {
    await top()
    await link.click({ modifiers: ['Shift'] })
    await arrived()
    assert.deepEqual(await state(), { head: definition, shown: true })
  }
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector('.rich-pane .cm-content')
        .cmTile.root.view.state.doc.toString(),
    ),
    edited,
  )
})
