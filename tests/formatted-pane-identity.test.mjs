import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function open(t) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-pane-identity-'))
  const addon = join(profile, 'installed-addons', 'pane-probe')
  const file = join(profile, 'note.md')
  const text = '# title\n\nalpha **bold** beta\n\nomega'
  await mkdir(addon, { recursive: true })
  await writeFile(file, text)
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'pane-probe',
      name: 'Pane probe',
      description: 'Pane identity regression fixture.',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      capabilities: ['source'],
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(addon, 'index.js'),
    `export default () => ({ start(context) {
      window.paneProbe = { views: context.editorViews, sourceIds: [] }
      context.editor.registerSource({ id: 'identity', create(view) {
        window.paneProbe.sourceIds.push(view.viewId)
        return []
      } })
    } });`,
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
    JSON.stringify({ 'pane-probe': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(() => !!window.paneProbe)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await page.locator('.mode-side-by-side[data-source-ready="true"]').waitFor()
  const rich = page.locator('.rich-pane .cm-content')
  const source = page.locator('.source-pane .cm-content')
  const select = (editor, anchor, head = anchor) =>
    editor.evaluate(
      (element, { anchor, head }) => {
        const view = element.cmTile.root.view
        view.focus()
        view.dispatch({ selection: { anchor, head } })
      },
      { anchor, head },
    )
  const selection = (editor) =>
    editor.evaluate((element) => {
      const view = element.cmTile.root.view
      const range = view.state.selection.main
      return {
        anchor: range.anchor,
        head: range.head,
        text: view.state.sliceDoc(range.from, range.to),
      }
    })
  return { app, page, file, text, rich, source, select, selection }
}

test('formatted and source panes keep separate bookmarks through edits and hidden catch-up', {
  timeout: 60000,
}, async (t) => {
  const { app, page, file, text, rich, source, select, selection } =
    await open(t)
  const beta = text.indexOf('beta')
  await select(rich, beta, beta + 4)
  await select(source, 0)
  await page.keyboard.insertText('preface\n\n')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    `preface\n\n${text}`,
  )
  assert.deepEqual(await selection(rich), {
    anchor: beta + 9,
    head: beta + 13,
    text: 'beta',
  })
  assert.equal(
    await source.evaluate((element) => document.activeElement === element),
    true,
  )
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await source.focus()
  await page.keyboard.insertText('hidden ')
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await waitForDocumentEditor(app, page)
  assert.deepEqual(await selection(rich), {
    anchor: beta + 16,
    head: beta + 20,
    text: 'beta',
  })
  await rich.focus()
  await page.keyboard.insertText('BETA')
  const edited = `preface\n\nhidden ${text.replace('beta', 'BETA')}`
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    edited,
  )
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    `preface\n\nhidden ${text}`,
  )
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), `preface\n\nhidden ${text}`)
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await page.locator('.mode-side-by-side[data-source-ready="true"]').waitFor()
  assert.deepEqual(await selection(source), { anchor: 16, head: 16, text: '' })
})

test('addon view targets and source extensions identify each formatted split pane', {
  timeout: 60000,
}, async (t) => {
  const { app, page, text, rich, source, select, selection } = await open(t)
  const active = () =>
    page.evaluate(() => {
      const { views } = window.paneProbe
      return views.getSelection(views.getActive())
    })
  await select(rich, text.indexOf('beta'), text.indexOf('beta') + 4)
  const formatted = await active()
  assert.equal(formatted.ok, true)
  assert.equal(formatted.value.editor, 'rich')
  await select(source, 2, 5)
  const markdown = await active()
  assert.equal(markdown.ok, true)
  assert.equal(markdown.value.editor, 'source')
  assert.notEqual(markdown.value.view.viewId, formatted.value.view.viewId)
  assert.equal(markdown.value.view.documentId, formatted.value.view.documentId)
  const listed = await page.evaluate(() => window.paneProbe.views.list())
  assert.equal(listed.length, 2)
  assert.equal(new Set(listed.map((view) => view.viewId)).size, 2)
  assert.ok(
    (await page.evaluate(() => window.paneProbe.sourceIds)).includes(
      markdown.value.view.viewId,
    ),
  )
  assert.equal(
    (
      await page.evaluate(
        (target) =>
          window.paneProbe.views.setSelection({
            ...target,
            anchor: 2,
            head: 7,
          }),
        formatted.value,
      )
    ).ok,
    true,
  )
  assert.equal((await selection(rich)).text, 'title')
  assert.deepEqual(await selection(source), { anchor: 2, head: 5, text: 'tit' })
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.focus()
  assert.equal((await active()).value.view.viewId, formatted.value.view.viewId)
  const previous = (await page.evaluate(() => window.hibi.getDocument())).tabId
  await clickMenu(app, 'New')
  await waitForAsync(
    page,
    async (previous) => (await window.hibi.getDocument()).tabId !== previous,
    previous,
  )
  await waitForDocumentEditor(app, page)
  for (const target of [formatted.value.view, markdown.value.view])
    assert.equal(
      (
        await page.evaluate(
          (view) => window.paneProbe.views.getSelection(view),
          target,
        )
      ).code,
      'stale',
    )
})
