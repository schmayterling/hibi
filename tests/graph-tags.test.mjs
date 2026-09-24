import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { localTarget, noteGraph } from '../src/addons/graph/model.ts'
import { noteTags } from '../src/addons/tags/syntax.ts'
import { electron } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
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
  await source.fill('No tags in this note.')
  await page
    .locator('[data-status-id="tags.tags"]')
    .waitFor({ state: 'hidden' })
  await source.fill('# beta\n\n#personal #newtag\n\n[back](a.md)')
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
  await graph
    .getByRole('button', { name: /^open a\.md$/i, exact: true })
    .waitFor()
  assert.equal(await graph.locator('[data-node]').count(), 3)
  assert.equal(await graph.locator('line').count(), 1)
  const canvas = await graph.locator('.graph-canvas').boundingBox()
  assert.ok(Math.abs(canvas.width - canvas.height) < 1)
  await graph.getByRole('button', { name: 'Fit graph' }).click()
  const assertCentered = async (view, path) => {
    const circle = view.locator(`[data-node="${path}"] circle`)
    await page.waitForFunction(
      (circle) => {
        const node = circle.getBoundingClientRect()
        const canvas = circle.closest('svg').getBoundingClientRect()
        return (
          Math.abs(node.x + node.width / 2 - canvas.x - canvas.width / 2) < 1 &&
          Math.abs(node.y + node.height / 2 - canvas.y - canvas.height / 2) < 1
        )
      },
      await circle.elementHandle(),
    )
  }
  const centerNode = async (view, path, keyboard = false) => {
    const svg = view.getByRole('application', { name: 'Workspace graph' })
    await svg.focus()
    await svg.press('ArrowRight')
    const scale = (
      await svg.locator(':scope > g').getAttribute('transform')
    ).match(/scale\(([^)]+)\)/)[1]
    const node = view.locator(`[data-node="${path}"]`)
    if (keyboard) await node.press('Enter')
    else await node.locator('circle').click()
    await assertCentered(view, path)
    assert.equal(
      (await svg.locator(':scope > g').getAttribute('transform')).match(
        /scale\(([^)]+)\)/,
      )[1],
      scale,
    )
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
  await expanded.locator('[data-node="a.md"]').waitFor()
  assert.equal(await graph.locator('.graph-canvas').count(), 1)
  await expanded.getByRole('button', { name: 'Fit graph' }).click()
  await centerNode(expanded, 'a.md')
  assert.equal(await expanded.isVisible(), true)
  await centerNode(expanded, 'b.md', true)
  assert.equal(await expanded.isVisible(), true)
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
        '.addon-sidebar [data-node][data-active="true"]',
      )?.dataset.node
      if (changedAt === null && active === 'a.md') changedAt = performance.now()
      if (changedAt !== null)
        window.graphCameraSamples.push(
          document
            .querySelector('.addon-sidebar .graph-canvas > svg > g')
            ?.getAttribute('transform'),
        )
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
  await page.waitForFunction(
    () => document.querySelectorAll('[data-node]').length === 1,
  )
  await graph.getByRole('searchbox', { name: /filter graph notes/i }).fill('')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-node]').length === 3,
  )
  const transform = () => graph.locator('svg > g').getAttribute('transform')
  await graph.getByRole('button', { name: /^fit graph$/i, exact: true }).click()
  const before = await transform()
  await graph.getByRole('button', { name: /^zoom in$/i, exact: true }).click()
  assert.notEqual(await transform(), before)
  await graph.getByRole('button', { name: /^fit graph$/i, exact: true }).click()
  // Dragging a node must not open it.
  const node = graph.locator('[data-node="a.md"] circle'),
    bounds = await node.boundingBox()
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
  await graph
    .getByRole('button', { name: /^open a\.md$/i, exact: true })
    .focus()
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
  await graph
    .getByRole('button', { name: /^open a\.md$/i, exact: true })
    .focus()
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
