import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

async function launch(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix))
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
  page.setDefaultTimeout(60000)
  await waitForDocumentEditor(app, page)
  await page.evaluate(() => {
    localStorage.setItem('hibi:formatted-engine', 'codemirror')
    localStorage.setItem('markdown-markers', 'false')
  })
  await page.reload()
  await waitForDocumentEditor(app, page)
  return { root, app, page }
}

async function open(app, page, file) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await clickMenu(app, 'Open…')
  await page.locator('.rich-pane .cm-content').waitFor()
}

/** Every heading element: the editor's, and the entries before and after it. */
const everyHeading =
  '.formatted-headings [role="heading"], .rich-pane .cm-content > [role="heading"]'
const headingCount = (page, count, options) =>
  page.waitForFunction(
    ({ selector, count }) =>
      !window.headingWork?.pending &&
      document.querySelectorAll(selector).length === count,
    { selector: everyHeading, count },
    options,
  )

test('every heading of a long formatted note reaches assistive technology once, in order', {
  timeout: 120000,
}, async (t) => {
  const { root, app, page } = await launch(t, 'hibi-heading-navigation-')
  const file = join(root, 'long.md')
  const text = Array.from(
    { length: 200 },
    (_, i) =>
      `${i % 3 ? '##' : '#'} heading ${i}\n\nparagraph ${i} with some words to fill the line.\n`,
  ).join('\n')
  await writeFile(file, text)
  const chunks = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const outline = chunks.find((chunk) =>
    chunk.modules.some((module) =>
      module.endsWith('src/renderer/src/source-outline.ts'),
    ),
  ).file
  const list = chunks.find((chunk) =>
    chunk.modules.some((module) =>
      module.endsWith('src/renderer/src/formatted-headings.ts'),
    ),
  ).file
  await page.evaluate(
    async ({ outline, list }) => {
      window.headingWork = Object.values(
        await import(`app://hibi/${list}`),
      ).find((value) => typeof value?.placed === 'number')
      const model = Object.values(await import(`app://hibi/${outline}`)).find(
        (value) => value?.prototype?.read && value.prototype.counters,
      )
      const read = model.prototype.read
      window.outlineReads = 0
      model.prototype.read = function* () {
        while (window.holdOutline) yield
        const result = yield* read.call(this)
        window.outlineReads++
        return result
      }
    },
    { outline, list },
  )
  await open(app, page, file)
  await headingCount(page, 200)
  const cdp = await page.context().newCDPSession(page)
  // Depth first, in the tree's order, as heading navigation reads it.
  const headings = async () => {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree')
    const byId = new Map(nodes.map((node) => [node.nodeId, node]))
    const found = []
    const visit = (node) => {
      if (node.role?.value === 'heading' && !node.ignored)
        found.push([
          node.name?.value,
          node.properties.find((property) => property.name === 'level')?.value
            .value,
        ])
      for (const id of node.childIds ?? [])
        if (byId.has(id)) visit(byId.get(id))
    }
    visit(nodes.find((node) => !node.parentId))
    return found
  }
  const expected = Array.from({ length: 200 }, (_, i) => [
    `heading ${i}`,
    i % 3 ? 2 : 1,
  ])
  // The editor draws a few of them; the others are entries around it.
  assert.ok(
    (await page.locator('.rich-pane .cm-content > [role="heading"]').count()) <
      50,
  )
  assert.deepEqual(await headings(), expected)
  // Entries are no tab stops.
  assert.equal(
    await page.locator('.formatted-headings [tabindex="0"]').count(),
    0,
  )

  // Activating an entry puts the caret in its heading's text and shows it.
  const target = text.indexOf('## heading 151')
  await page
    .locator('.formatted-headings a', { hasText: /^heading 151$/ })
    .evaluate((link) => link.click())
  await page.waitForFunction((anchor) => {
    const content = document.querySelector('.rich-pane .cm-content')
    return (
      document.activeElement === content &&
      content.cmTile.root.view.state.selection.main.head === anchor &&
      [...content.querySelectorAll(':scope > [role="heading"]')].some(
        (heading) => heading.textContent === 'heading 151',
      )
    )
  }, target + 3)
  await headingCount(page, 200)
  assert.deepEqual(await headings(), expected)
  assert.equal(
    await page
      .locator('.formatted-headings a', { hasText: /^heading 151$/ })
      .count(),
    0,
  )

  // Stop scrolling while a body-only outline reread is pending. Its heading
  // array stays identical, but the entries must reconcile against the new view.
  const reads = await page.evaluate((from) => {
    window.holdOutline = true
    const content = document.querySelector('.rich-pane .cm-content')
    content.cmTile.root.view.dispatch({
      changes: { from, to: from + 1, insert: 'P' },
    })
    document.querySelector('.rich-pane').scrollTop = 0
    return window.outlineReads
  }, text.indexOf('paragraph'))
  await page.waitForFunction(
    () =>
      document.querySelector('.rich-pane .cm-content > [role="heading"]')
        ?.textContent === 'heading 0',
  )
  await page.evaluate(() => {
    window.holdOutline = false
  })
  await waitForAsync(page, (reads) => window.outlineReads > reads, reads)
  await page.waitForFunction(() => !window.headingWork.pending)
  const reconciled = await headings()
  t.diagnostic(
    JSON.stringify({
      count: reconciled.length,
      unique: new Set(reconciled.map(([name]) => name)).size,
    }),
  )
  assert.deepEqual(reconciled, expected)
})

test('heading entry work at real note scale', {
  timeout: 120000,
}, async (t) => {
  const { page } = await launch(t, 'hibi-heading-entry-scale-')
  const chunks = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const file = chunks.find((chunk) =>
    chunk.modules.some((module) =>
      module.endsWith('src/renderer/src/formatted-headings.ts'),
    ),
  ).file
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Accessibility.enable')
  const result = await page.evaluate(async (file) => {
    const module = Object.values(await import(`app://hibi/${file}`))
    const List = module.find((value) => value?.prototype?.show)
    const work = module.find((value) => typeof value?.placed === 'number')
    const before = document.createElement('div')
    const after = document.createElement('div')
    before.className = after.className = 'formatted-headings'
    document.body.append(before, after)
    let activated = -1
    const list = new List(before, after, (index) => {
      activated = index
    })
    const headings = Array.from({ length: 13548 }, (_, i) => ({
      id: `source:${i}:0`,
      label: `heading ${i}`,
      level: 2,
    }))
    const settle = async () => {
      while (work.pending)
        await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const start = performance.now()
    const created = work.created
    list.update(headings)
    const synchronousCreated = work.created - created
    // Keep the unchanged build's failure about bounded work, not a missing API.
    if (synchronousCreated > 2048) return { synchronousCreated }
    await settle()
    const initialMs = performance.now() - start
    list.show(5, 15)
    await settle()
    const placed = work.placed
    const jumpStart = performance.now()
    list.show(13538, 13548)
    await settle()
    const jumpMs = performance.now() - jumpStart
    before.lastChild.firstChild.click()
    const result = {
      initialMs,
      jumpMs,
      synchronousCreated,
      maximumCreated: work.maximumCreated,
      maximumSliceMs: work.maximumSliceMs,
      created: work.created,
      jumpPlaced: work.placed - placed,
      count: before.children.length + after.children.length,
      ordered: [...before.children].every(
        (entry, i) => entry.textContent === headings[i].label,
      ),
      activated,
    }
    // Supersede a pending heading update and viewport; only the latest may settle.
    list.update(headings.slice(0, 100))
    activated = -1
    before.lastChild.firstChild.click()
    result.staleActivationBlocked = activated === -1
    list.show(0, 0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    list.update(headings.slice(0, 200))
    list.show(150, 160)
    await settle()
    result.superseded =
      before.children.length + after.children.length === 190 &&
      before.lastChild.textContent === 'heading 149' &&
      after.firstChild.textContent === 'heading 160'
    // Closing the pane cancels creation and prevents later DOM writes.
    list.update(headings)
    await new Promise((resolve) => setTimeout(resolve, 0))
    list.dispose()
    const stopped = work.created
    await new Promise((resolve) => setTimeout(resolve, 30))
    result.cancelled =
      work.created === stopped &&
      !before.childNodes.length &&
      !after.childNodes.length &&
      work.pending === 0
    before.remove()
    after.remove()
    return result
  }, file)
  t.diagnostic(JSON.stringify(result))
  assert.ok(result.synchronousCreated <= 2048, JSON.stringify(result))
  assert.ok(result.maximumCreated <= 2048, JSON.stringify(result))
  assert.equal(result.count, 13538)
  assert.equal(result.superseded, true)
  assert.equal(result.staleActivationBlocked, true)
  assert.equal(result.cancelled, true)
  assert.equal(result.ordered, true)
  assert.equal(result.activated, 13537)
})

test('a 50 MiB note keeps its heading entries through body edits and scrolling', {
  timeout: 180000,
}, async (t) => {
  const { root, app, page } = await launch(t, 'hibi-heading-navigation-50m-')
  const file = join(root, 'large.md')
  const block = `## heading\n\n${`${'plain text body '.repeat(15)}\n`.repeat(16)}\n\n`
  const source = block
    .repeat(Math.ceil((50 * 1024 * 1024) / block.length))
    .slice(0, 50 * 1024 * 1024)
  await writeFile(file, source)
  const total = source.split('## heading').length - 1
  const chunks = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const chunkOf = (path) =>
    chunks.find((chunk) =>
      chunk.modules.some((module) => module.endsWith(path)),
    ).file
  await page.evaluate(
    async ({ list, outline }) => {
      const values = Object.values(await import(`app://hibi/${list}`))
      window.headingWork = values.find(
        (value) => typeof value?.placed === 'number',
      )
      const List = values.find((value) => value?.prototype?.show)
      window.headingDurations = { update: 0, show: 0 }
      for (const name of ['update', 'show']) {
        const method = List.prototype[name]
        List.prototype[name] = function (...args) {
          const started = performance.now()
          try {
            return method.apply(this, args)
          } finally {
            window.headingDurations[name] = Math.max(
              window.headingDurations[name],
              performance.now() - started,
            )
          }
        }
      }
      const model = Object.values(await import(`app://hibi/${outline}`)).find(
        (value) => value?.prototype?.read && value.prototype.counters,
      )
      const read = model.prototype.read
      window.outlineReads = 0
      model.prototype.read = function* () {
        const value = yield* read.call(this)
        window.outlineReads++
        return value
      }
    },
    {
      list: chunkOf('src/renderer/src/formatted-headings.ts'),
      outline: chunkOf('src/renderer/src/source-outline.ts'),
    },
  )
  await open(app, page, file)
  await headingCount(page, total, { timeout: 120000 })
  const work = () =>
    page.evaluate(() => ({
      ...window.headingWork,
      reads: window.outlineReads,
    }))
  assert.equal((await work()).created, total)
  // Body edits leave the outline, and so every entry, as it was.
  const from = source.indexOf('body', Math.floor(source.length / 2))
  for (const insert of ['B', 'b', 'text']) {
    const before = await work()
    await page.locator('.rich-pane .cm-content').evaluate(
      (element, { from, insert }) => {
        element.cmTile.root.view.dispatch({
          changes: { from, to: from + 1, insert },
        })
      },
      { from, insert },
    )
    await waitForAsync(
      page,
      (reads) => window.outlineReads > reads,
      before.reads,
      { timeout: 60000 },
    )
    const after = await work()
    assert.deepEqual(
      [after.created, after.placed],
      [before.created, before.placed],
    )
  }
  // Scrolling a few screens moves only the entries scrolled past.
  const scrolled = await work()
  await page.locator('.rich-pane').evaluate((pane) => {
    pane.scrollTop += 4 * pane.clientHeight
  })
  await page.waitForFunction(
    () => document.querySelector('.formatted-headings').children.length > 0,
  )
  await headingCount(page, total)
  const moved = await work()
  assert.equal(moved.created, scrolled.created)
  assert.ok(moved.placed - scrolled.placed < 100, JSON.stringify(moved))
  await page.locator('.rich-pane').evaluate((pane) => {
    pane.scrollTop = pane.scrollHeight
  })
  await page.waitForFunction(
    (total) =>
      document.querySelector('.formatted-headings').children.length >
      total - 50,
    total,
  )
  await headingCount(page, total)
  assert.equal((await work()).created, moved.created)
  t.diagnostic(
    JSON.stringify({
      total,
      ...(await work()),
      maximumMs: await page.evaluate(() => window.headingDurations),
    }),
  )
  assert.deepEqual(
    await page
      .pageErrors()
      .then((errors) => errors.map((error) => error.message)),
    [],
  )
})
