import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const note = `# Links

Body [next](b.md), <https://example.com/auto>, https://example.com/bare and [&amp; more](b.md).

Wiki [[b]], [[b|alias text]] and [[b|&amp; sign]].

Around ~~[struck](b.md)~~ and [x **y** z](b.md).

| name | link |
| --- | --- |
| row | [cell link](b.md) |
| wiki | [[c]] |
| wiki-entity | [[c\\|&copy;]] |
| wiki-alias | [[b \\|x &amp; y]] |
| wiki-empty | [[b\\|]] |
| wiki-blank | [[b\\|   ]] |
| entity | [&amp;](b.md) |
| mapped | left \\| \\| [&copy;&#x1f331;](c.md) |
`
// The rich view's links, in order: one each, named by the text it shows.
const names = [
  'next',
  'https://example.com/auto',
  'https://example.com/bare',
  '& more',
  'b',
  'alias text',
  '& sign',
  'struck',
  'x y z',
  'cell link',
  'c',
  '©',
  'x & y',
  'b',
  'b',
  '&',
  '©🌱',
]

async function open(t, engine) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-link-accessibility-'))
  const notes = join(root, 'notes')
  await mkdir(notes)
  await writeFile(join(notes, 'a.md'), note)
  await writeFile(join(notes, 'b.md'), '# second\n')
  await writeFile(join(notes, 'c.md'), '# third\n')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await waitForDocumentEditor(app, page)
  await page.evaluate(
    (engine) => localStorage.setItem('hibi:formatted-engine', engine),
    engine,
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog, shell }, notes) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [notes],
    })
    dialog.showMessageBox = async () => ({ response: 1 })
    globalThis.opened = []
    shell.openExternal = async (url) => {
      globalThis.opened.push(url)
    }
  }, notes)
  await page.evaluate(() => window.hibi.openWorkspace())
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    },
    join(notes, 'a.md'),
  )
  await pressShortcut(app, `${mod}+o`)
  await shown(app, page, 'a.md')
  return { app, page }
}

async function shown(app, page, name) {
  await waitForAsync(
    page,
    async (name) => (await window.hibi.getDocument()).name === name,
    name,
  )
  await waitForDocumentEditor(app, page)
}

for (const engine of ['tiptap', 'codemirror']) {
  test(`${engine}: links expose one named link each to assistive technology`, {
    timeout: 60000,
  }, async (t) => {
    const { page } = await open(t, engine)
    const rich = page.locator('.rich-pane')
    await rich.getByRole('link', { name: 'c', exact: true }).waitFor()
    const cdp = await page.context().newCDPSession(page)
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'document.querySelector(".rich-pane")',
    })
    const { nodes } = await cdp.send('Accessibility.queryAXTree', {
      objectId: result.objectId,
      role: 'link',
    })
    const links = nodes.filter((node) => !node.ignored)
    assert.deepEqual(
      links.map((node) => node.name?.value),
      names,
    )
    // Links in editable text are no tab stops, as in the rich view.
    assert.deepEqual(
      links.filter((node) =>
        node.properties?.some(
          (property) => property.name === 'focusable' && property.value.value,
        ),
      ),
      [],
    )
  })

  test(`${engine}: shift-click and ctrl+cmd-click follow links, in table cells too`, {
    timeout: 120000,
  }, async (t) => {
    const { app, page } = await open(t, engine)
    const rich = page.locator('.rich-pane')
    const link = (name) => rich.getByRole('link', { name, exact: true })
    await link('c').waitFor()
    const settled = async () => ({
      name: (await page.evaluate(() => window.hibi.getDocument())).name,
      opened: await app.evaluate(() => globalThis.opened.splice(0)),
    })
    // A plain click edits.
    await link('https://example.com/bare').click()
    await link('next').click()
    assert.deepEqual(await settled(), { name: 'a.md', opened: [] })
    const follows = [['Shift']]
    if (process.platform === 'darwin') follows.push(['Control', 'Meta'])
    for (const [name, target] of [
      ['next', 'b.md'],
      ['https://example.com/auto', 'https://example.com/auto'],
      ['https://example.com/bare', 'https://example.com/bare'],
      ['alias text', 'b.md'],
      ['cell link', 'b.md'],
      ['c', 'c.md'],
      ['©', 'c.md'],
      ['x & y', 'b.md'],
      ['&', 'b.md'],
      ['©🌱', 'c.md'],
    ])
      for (const modifiers of follows) {
        await link(name).click({ modifiers })
        if (target.endsWith('.md')) {
          await shown(app, page, target)
          await pressShortcut(app, `${mod}+[`)
          await shown(app, page, 'a.md')
          await link('c').waitFor()
        } else
          assert.deepEqual(await settled(), { name: 'a.md', opened: [target] })
      }
    // The link of the cell being edited follows the same way. The formatted
    // view shows an entity under the caret as source, which names the link.
    for (const [name, target] of [
      ['cell link', 'b.md'],
      ['&', 'b.md'],
      ['©🌱', 'c.md'],
    ])
      for (const modifiers of follows) {
        await link(name).click()
        const editing =
          engine === 'codemirror'
            ? rich.locator('.hibi-lp-cell-editor').getByRole('link')
            : link(name)
        await editing.waitFor()
        assert.equal(await editing.count(), 1)
        assert.deepEqual(await settled(), { name: 'a.md', opened: [] })
        await editing.click({ modifiers })
        await shown(app, page, target)
        await pressShortcut(app, `${mod}+[`)
        await shown(app, page, 'a.md')
        await link('c').waitFor()
      }
    // Empty aliases also keep a table escape while their shown label is the target.
    for (const rowName of ['wiki-empty', 'wiki-blank'])
      for (const modifiers of follows) {
        const row = rich.locator('tr').filter({ hasText: rowName })
        await row
          .getByRole('link', { name: 'b', exact: true })
          .click({ modifiers })
        await shown(app, page, 'b.md')
        await pressShortcut(app, `${mod}+[`)
        await shown(app, page, 'a.md')
        await row.getByRole('link', { name: 'b', exact: true }).click()
        const active =
          engine === 'codemirror'
            ? row.locator('.hibi-lp-cell-editor [data-wiki-link]')
            : row.getByRole('link', { name: 'b', exact: true })
        await active.waitFor()
        await active.click({ modifiers })
        await shown(app, page, 'b.md')
        await pressShortcut(app, `${mod}+[`)
        await shown(app, page, 'a.md')
      }
    // Editing keeps table escapes in the source, but follows the same wiki target.
    for (const [name, target] of [
      ['©', 'c.md'],
      ['x & y', 'b.md'],
    ])
      for (const modifiers of follows) {
        await link(name).click()
        const active =
          engine === 'codemirror'
            ? rich.locator('.hibi-lp-cell-editor [data-wiki-link]')
            : link(name)
        await active.waitFor()
        await active.click({ modifiers })
        await shown(app, page, target)
        await pressShortcut(app, `${mod}+[`)
        await shown(app, page, 'a.md')
        await link('c').waitFor()
      }
  })
}
