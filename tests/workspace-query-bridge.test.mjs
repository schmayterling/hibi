import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'

test('installed addon queries workspace metadata through scoped bridge', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-query-bridge-'))
  const workspace = join(profile, 'notes')
  const folder = join(profile, 'installed-addons', 'query-probe')
  await mkdir(workspace)
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(workspace, 'a.md'),
    '\ufeff---\r\nstatus: done\r\nnested: {items: [one, {count: 2}]}\r\n---\r\n# Alpha 😀\r\n\r\n[Bravo](b.md)\r\n\r\n#topic ^block-id\r\n\r\n[jump](#^block-id) [[b#^target|cross]]\r\n',
  )
  await writeFile(
    join(workspace, 'b.md'),
    '# Bravo\n\nTarget paragraph ^target\n',
  )
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'query-probe',
      name: 'Query probe',
      description: 'Workspace query bridge test addon.',
      kind: 'extension',
      apiVersion: 3,
      version: '1.0.0',
      defaultEnabled: true,
      startup: 'background',
      capabilities: [],
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(folder, 'index.js'),
    `export default () => ({
      start(context) {
        window.queryProbe = {
          snapshot: () => context.workspace.changeSnapshot(),
          query: request => context.workspace.query(request),
          openFile: path => context.workspace.openFile(path),
          metadata: async request => {
            const entries = []
            for await (const entry of context.workspace.metadata(request)) entries.push(entry)
            return entries
          },
        }
      },
      stop() { delete window.queryProbe },
    })`,
  )
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'query-probe': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, workspace)
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.queryProbe)
  await page.evaluate(() => window.hibi.openWorkspace())
  const snapshot = await page.evaluate(() => window.queryProbe.snapshot())
  assert.ok(snapshot.target)
  const target = snapshot.target
  const links = await page.evaluate(
    (captured) =>
      window.queryProbe.query({
        target: captured,
        kind: 'links',
        path: 'a.md',
      }),
    target,
  )
  assert.equal(links.ok, true)
  assert.deepEqual(links.value.items, ['b.md'])
  const tags = await page.evaluate(
    (captured) =>
      window.queryProbe.query({ target: captured, kind: 'tag', tag: 'topic' }),
    target,
  )
  assert.equal(tags.ok, true)
  assert.deepEqual(tags.value.items, ['a.md'])
  const property = await page.evaluate(
    (captured) =>
      window.queryProbe.query({
        target: captured,
        kind: 'property',
        key: 'status',
        value: 'done',
      }),
    target,
  )
  assert.equal(property.ok, true)
  assert.deepEqual(property.value.items, ['a.md'])
  const metadata = await page.evaluate(
    (captured) =>
      window.queryProbe.metadata({ target: captured, path: 'a.md' }),
    target,
  )
  const heading = metadata.find(({ kind }) => kind === 'heading').value
  assert.equal(heading.text, 'Alpha 😀')
  assert.deepEqual(heading.position.start, { line: 4, col: 0, offset: 61 })
  const frontmatter = metadata.find(({ kind }) => kind === 'frontmatter').value
  assert.deepEqual(frontmatter.values.nested, { items: ['one', { count: 2 }] })
  const block = metadata.find(({ kind }) => kind === 'block').value
  assert.equal(block.id, 'block-id')
  const resolved = await page.evaluate(
    (captured) =>
      window.queryProbe.query({
        target: captured,
        kind: 'resolve-subpath',
        path: 'a.md',
        subpath: '#^block-id',
      }),
    target,
  )
  assert.equal(resolved.ok, true)
  assert.equal(resolved.value.resolved.type, 'block')
  assert.deepEqual(resolved.value.resolved.position, block.position)
  const text = await page.evaluate(async (captured) => {
    const items = []
    let cursor, result
    do {
      result = await window.queryProbe.query({
        target: captured,
        kind: 'search-text',
        query: 'Alpha',
        ...(cursor ? { cursor } : {}),
      })
      if (!result.ok) return result
      items.push(...result.value.items)
      cursor = result.value.nextCursor
    } while (cursor)
    return { ...result, value: { ...result.value, items } }
  }, target)
  assert.equal(text.ok, true)
  assert.deepEqual(text.value.items, ['a.md'])
  await page.evaluate(() => window.queryProbe.openFile('a.md'))
  await page.waitForFunction(
    async () => (await window.hibi.getDocument()).name === 'a.md',
  )
  await waitForDocumentEditor(app, page)
  await page.getByRole('link', { name: 'jump', exact: true }).waitFor()
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true })
  })
  await page
    .getByRole('link', { name: 'jump', exact: true })
    .click({ modifiers: ['Shift'] })
  await page.waitForFunction(() => {
    const view = document.querySelector('.rich-pane .cm-content')?.cmTile?.root
      .view
    return (
      view &&
      view.state.selection.main.head ===
        view.state.doc.toString().indexOf('#topic')
    )
  })
  await page
    .getByRole('link', { name: 'cross', exact: true })
    .click({ modifiers: ['Shift'] })
  await page.waitForFunction(async () => {
    if ((await window.hibi.getDocument()).name !== 'b.md') return false
    const view = document.querySelector('.rich-pane .cm-content')?.cmTile?.root
      .view
    return (
      view &&
      view.state.selection.main.head ===
        view.state.doc.toString().indexOf('Target paragraph')
    )
  })
})
