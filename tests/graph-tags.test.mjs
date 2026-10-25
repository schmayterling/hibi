import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  localTarget,
  metadataGraph,
  noteGraph,
} from '../src/addons/graph/model.ts'
import { noteTags } from '../src/addons/tags/syntax.ts'
import { electron } from './electron.mjs'
import { pressShortcut, replaceSourceText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'
import { uiName } from './ui.mjs'

test('tags index prose, normalize names, and exclude code, urls, escapes, and metadata', () => {
  const source =
    '---\ntitle: "#metadata"\n---\n# heading\n\n#Work #work #work/project (#日本語) #123\n\n**#bold** and `#code`\n\n```md\n#fenced\n```\n\n[hello #label](https://example.com/#url) ![#alt](image.png) \\#escaped\n\n<div>#html</div>\n'
  assert.deepEqual(noteTags(source), ['bold', 'work', 'work/project', '日本語'])
})
test('graph resolves only existing local note links and deduplicates connections', () => {
  const pages = [
    {
      path: 'a.md',
      markdown:
        '[b](folder/b.md) [again](folder/b.md#heading) [ref][note]\n\n[note]: spaced%20note.md\n\n![image](folder/b.md) [external](https://example.com/a.md) [self](#heading) [missing](none.md)\n\n```md\n[code](orphan.md)\n```',
    },
    { path: 'folder/b.md', markdown: '[back](../a.md)' },
    { path: 'spaced note.md', markdown: '' },
    { path: 'orphan.md', markdown: '' },
  ]
  const graph = noteGraph(pages)
  assert.equal(graph.nodes.length, 4)
  assert.equal(graph.edges.length, 2)
  assert.equal(graph.nodes.find((node) => node.id === 'a.md').degree, 2)
  assert.deepEqual(noteGraph(pages.map((page) => ({ ...page }))), graph)
  pages[3].markdown = '[a](a.md)'
  assert.equal(noteGraph(pages).edges.length, 3)
  const paths = new Set(pages.map((page) => page.path))
  assert.equal(localTarget('folder/b.md', '/a.md', paths), 'a.md')
  for (const link of [
    '../../a.md',
    'file:///a.md',
    '//server/a.md',
    '%00a.md',
    '%GG',
  ])
    assert.equal(localTarget('folder/b.md', link, paths), null)
})

test('graph panel deduplicates shared metadata edges and skips incomplete targets', () => {
  const graph = metadataGraph([
    { kind: 'node', path: 'a.md' },
    { kind: 'node', path: 'b.md' },
    { kind: 'edge', source: 'a.md', target: 'b.md' },
    { kind: 'edge', source: 'b.md', target: 'a.md' },
    { kind: 'edge', source: 'a.md', target: 'missing.md' },
  ])
  assert.deepEqual(graph.edges, [{ source: 'a.md', target: 'b.md' }])
  assert.deepEqual(
    graph.nodes.map((node) => node.degree),
    [1, 1],
  )
})

test('tags and graph plugins browse/open notes, honor drafts, and clean up when disabled', {
  timeout: 45000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-graph-tags-')),
    root = join(temp, 'notes')
  await mkdir(root)
  await writeFile(
    join(root, 'a.md'),
    '# alpha\n\n#work and #日本語\n\n[next](b.md)',
  )
  await writeFile(
    join(root, 'b.md'),
    '# beta\n\n#work #personal\n\n[back](a.md)',
  )
  await writeFile(join(root, 'orphan.md'), '# orphan\n\n#other')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6500)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const choose = async (name) => {
    await pressShortcut(app, `${mod}+k`)
    await page.getByRole('combobox', { name: /search commands/i }).fill(name)
    await page
      .getByRole('option')
      .filter({ has: page.getByText(uiName(name, true), { exact: true }) })
      .first()
      .click()
  }
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await choose('enable graph')
  await waitForAsync(page, async () =>
    (await window.hibi.getAddonStates()).some(
      (addon) => addon.id === 'graph' && addon.enabled,
    ),
  )
  assert.equal(
    await page
      .locator('[data-status-id="graph.open"], [data-status-id="tags.tags"]')
      .count(),
    0,
  )
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, root)
  await pressShortcut(app, `${mod}+Shift+o`)
  const tree = page.getByRole('tree', { name: /workspace files/i })
  await tree.getByRole('treeitem', { name: /^a\.md$/i, exact: true }).click()
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.locator('.hibi-tag[data-tag="work"]').waitFor()
  await page
    .locator('[data-status-id="tags.tags"]')
    .filter({ hasText: /tags · 2/i })
    .waitFor()
  await rich
    .locator('.hibi-tag[data-tag="work"]')
    .click({ modifiers: ['Shift'] })
  let dialog = page.getByRole('complementary', { name: /^tags$/i, exact: true })
  assert.equal(await page.getByRole('dialog').count(), 0)
  const tagRow = dialog.getByRole('button', { name: /^#work 2$/i, exact: true })
  assert.equal(await tagRow.getAttribute('data-variant'), 'row')
  const tagLayout = await tagRow.evaluate((row) => ({
    color: getComputedStyle(row).color,
    countColor: getComputedStyle(row.lastElementChild).color,
    row: row.getBoundingClientRect().width,
    group: row.parentElement.getBoundingClientRect().width,
    gap:
      row.getBoundingClientRect().right -
      row.lastElementChild.getBoundingClientRect().right,
  }))
  assert.ok(Math.abs(tagLayout.row - tagLayout.group) < 1)
  assert.equal(tagLayout.countColor, tagLayout.color)
  assert.ok(tagLayout.gap <= 16, 'tag counts use the native row inset')
  await dialog.getByRole('button', { name: /^#日本語 1$/i }).click()
  await rich
    .locator('.hibi-tag[data-tag="work"]')
    .click({ modifiers: ['Shift'] })
  await dialog.getByRole('region', { name: 'Notes tagged #work' }).waitFor()
  await dialog.getByRole('button', { name: /^b\.md$/i, exact: true }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'b.md',
  )
  await pressShortcut(app, `${mod}+Shift+]`)
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.locator('.hibi-tag[data-tag="personal"]').waitFor()
  await replaceSourceText(page, source, 'No tags in this note.')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'No tags in this note.',
  )
  await page
    .locator('[data-status-id="tags.tags"]')
    .waitFor({ state: 'hidden' })
  await replaceSourceText(
    page,
    source,
    '# beta\n\n#personal #newtag\n\n[back](a.md)',
  )
  await page
    .locator('[data-status-id="tags.tags"]')
    .filter({ hasText: /tags · 2/i })
    .waitFor()
  await choose('browse tags')
  dialog = page.getByRole('complementary', { name: /^tags$/i, exact: true })
  await dialog
    .getByRole('button', { name: /^#newtag 1$/i, exact: true })
    .click()
  await dialog.getByRole('button', { name: /^b\.md$/i, exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await choose('open workspace graph')
  let graph = page.getByRole('complementary', {
    name: /^workspace graph$/i,
    exact: true,
  })
  const notes = graph.locator('.graph-nodes [role="option"]')
  await graph
    .getByText('3 of 3 notes · 1 connection', { exact: true })
    .waitFor()
  assert.equal(await notes.getAttribute('aria-setsize'), '3')
  const canvas = await graph.locator('.graph-canvas').boundingBox()
  assert.ok(Math.abs(canvas.width - canvas.height) < 1)
  await graph.getByRole('button', { name: 'Fit graph' }).click()
  // The canvas keeps the camera transform of its last frame; wait for the
  // frame drawn after the latest input.
  const camera = (view) =>
    view.locator('canvas').evaluate(async (canvas) => {
      await new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      )
      const { a, e, f } = canvas.getContext('2d').getTransform()
      return `${a} ${e} ${f}`
    })
  // The keyboard note sits over its dot; type-ahead moves it like in other lists.
  const focusNote = async (view, path) => {
    const option = view.locator('.graph-nodes [role="option"]')
    await option.focus()
    await option.press(path[0])
    await view
      .getByRole('option', { name: `Open ${path}`, exact: true })
      .waitFor()
  }
  const assertCentered = async (view, path) => {
    await page.waitForFunction(
      ({ element, path }) => {
        const option = element.querySelector('.graph-nodes [role="option"]')
        const canvas = element.querySelector('.graph-view')
        if (option?.dataset.node !== path || !canvas) return false
        const node = option.getBoundingClientRect()
        const frame = canvas.getBoundingClientRect()
        return (
          node.width > 0 &&
          Math.abs(node.x + node.width / 2 - frame.x - frame.width / 2) < 1 &&
          Math.abs(node.y + node.height / 2 - frame.y - frame.height / 2) < 1
        )
      },
      { element: await view.elementHandle(), path },
    )
  }
  const centerNode = async (view, path, keyboard = false) => {
    const application = view.getByRole('application', {
      name: 'Workspace graph',
    })
    await application.focus()
    await application.press('ArrowRight')
    const scale = (await camera(view)).split(' ')[0]
    await focusNote(view, path)
    const option = view.locator('.graph-nodes [role="option"]')
    if (keyboard) await option.press('Enter')
    else {
      const box = await option.boundingBox()
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    }
    await assertCentered(view, path)
    assert.equal((await camera(view)).split(' ')[0], scale)
    await waitForAsync(
      page,
      async (path) => (await window.hibi.getDocument()).name === path,
      path,
    )
  }
  await graph.getByRole('button', { name: /^zoom in$/i }).click()
  await centerNode(graph, 'b.md')
  await centerNode(graph, 'b.md', true)
  await graph
    .getByRole('region', { name: 'Connections' })
    .getByRole('button', { name: 'a.md', exact: true })
    .waitFor()
  assert.equal(
    await graph
      .getByRole('button', {
        name: /refresh graph|current note|open a folder/i,
      })
      .count(),
    0,
  )
  await graph.getByRole('button', { name: /expand graph/i }).click()
  const expanded = page.getByRole('tabpanel', { name: /workspace graph/i })
  await expanded.locator('.graph-canvas[data-labels]').waitFor()
  assert.equal(await graph.locator('.graph-canvas').count(), 1)
  await expanded.getByRole('button', { name: 'Fit graph' }).click()
  await centerNode(expanded, 'a.md')
  assert.equal(await expanded.isVisible(), true)
  await centerNode(expanded, 'b.md', true)
  assert.equal(await expanded.isVisible(), true)
  await choose('browse tags')
  dialog = page.getByRole('complementary', { name: /^tags$/i, exact: true })
  await dialog.getByRole('button', { name: /^#work 1$/i, exact: true }).click()
  await dialog.getByRole('button', { name: /^a\.md$/i, exact: true }).click()
  await expanded.waitFor({ state: 'hidden' })
  await page
    .getByRole('tab', { name: /^a\.md$/i, exact: true })
    .and(page.locator('[aria-selected="true"]'))
    .waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).name,
    'a.md',
  )
  await page.locator('#document-editor-panel').waitFor()
  assert.equal(
    await page.getByRole('tab', { name: 'Workspace graph' }).count(),
    1,
  )
  await choose('open workspace graph')
  await graph.locator('.graph-canvas').waitFor()
  await page.getByRole('tab', { name: 'Workspace graph' }).click()
  await centerNode(expanded, 'b.md', true)
  await page.getByRole('button', { name: 'Close Workspace graph' }).click()
  await expanded.waitFor({ state: 'hidden' })
  await graph.locator('.graph-canvas').waitFor()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.evaluate(() => {
    window.graphCameraSamples = []
    window.graphCameraComplete = false
    const started = performance.now()
    let changedAt = null
    const sample = () => {
      const active = document.querySelector(
        '.addon-sidebar [role="option"][aria-selected="true"]',
      )?.dataset.node
      if (changedAt === null && active === 'a.md') changedAt = performance.now()
      if (changedAt !== null) {
        const { a, e, f } = document
          .querySelector('.addon-sidebar .graph-view canvas')
          .getContext('2d')
          .getTransform()
        window.graphCameraSamples.push(`${a} ${e} ${f}`)
      }
      if (
        performance.now() - started < 5000 &&
        (changedAt === null || performance.now() - changedAt < 400)
      )
        requestAnimationFrame(sample)
      else window.graphCameraComplete = true
    }
    requestAnimationFrame(sample)
  })
  await page.getByRole('tab', { name: /^a\.md$/i, exact: true }).click()
  await page.waitForFunction(() => window.graphCameraComplete)
  assert.ok(
    new Set(await page.evaluate(() => window.graphCameraSamples)).size >= 4,
  )
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('tab', { name: /^b\.md$/i, exact: true }).click()
  await assertCentered(graph, 'b.md')
  await graph
    .getByRole('searchbox', { name: /filter graph notes/i })
    .fill('orphan')
  await notes.and(page.locator('[aria-setsize="1"]')).waitFor()
  await graph.getByRole('searchbox', { name: /filter graph notes/i }).fill('')
  await notes.and(page.locator('[aria-setsize="3"]')).waitFor()
  await graph.getByRole('button', { name: /^fit graph$/i, exact: true }).click()
  const before = await camera(graph)
  await graph.getByRole('button', { name: /^zoom in$/i, exact: true }).click()
  await waitForAsync(
    page,
    (before) => {
      const { a, e, f } = document
        .querySelector('.addon-sidebar .graph-view canvas')
        .getContext('2d')
        .getTransform()
      return `${a} ${e} ${f}` !== before
    },
    before,
  )
  await graph.getByRole('button', { name: /^fit graph$/i, exact: true }).click()
  // Dragging a node must not open it.
  await focusNote(graph, 'a.md')
  const bounds = await notes.boundingBox()
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(bounds.x + 60, bounds.y + 40, { steps: 8 })
  await page.mouse.up()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).name,
    'b.md',
  )
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 2 })
  })
  await focusNote(graph, 'a.md')
  await page.keyboard.press('Enter')
  await assertCentered(graph, 'a.md')
  assert.equal(await graph.isVisible(), true)
  await page.waitForFunction(
    () => document.querySelector('.app').getAttribute('aria-busy') === 'false',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).name,
    'a.md',
  )
  await page.getByRole('tab', { name: /^b\.md$/i, exact: true }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'b.md',
  )
  assert.ok(
    (await page.evaluate(() => window.hibi.getDocument())).markdown.includes(
      '#newtag',
    ),
  )
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  await choose('open workspace graph')
  graph = page.getByRole('complementary', {
    name: /^workspace graph$/i,
    exact: true,
  })
  await graph.locator('.graph-canvas[data-labels]').waitFor()
  await focusNote(graph, 'a.md')
  await page.keyboard.press('Enter')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'a.md',
  )
  await choose('disable tags')
  await choose('disable graph')
  await page.waitForFunction(
    () =>
      !document.querySelector('.hibi-tag') &&
      !document.querySelector('[data-status-id="graph.open"]'),
  )
  assert.deepEqual(errors, [])
})
