import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut, replaceSourceText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('unsaved link edits update the graph while switching notes keeps it', {
  timeout: 60000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-graph-refresh-'))
  const root = join(temp, 'notes'),
    profile = join(temp, 'profile')
  await mkdir(root)
  await mkdir(profile)
  const alpha = '# alpha\n\n[next](b.md)'
  await writeFile(join(root, 'a.md'), alpha)
  await writeFile(join(root, 'b.md'), '# beta\n\n[back](a.md)')
  await writeFile(join(root, 'c.md'), '# gamma')
  await writeFile(join(profile, 'addons.json'), JSON.stringify({ graph: true }))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
  }, root)
  await pressShortcut(app, `${mod}+Shift+o`)
  const tree = page.getByRole('tree', { name: /workspace files/i })
  await tree.getByRole('treeitem', { name: /^a\.md$/i, exact: true }).click()
  await pressShortcut(app, `${mod}+k`)
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Open workspace graph')
  await page.getByRole('option').first().click()
  const graph = page.getByRole('complementary', {
    name: /^workspace graph$/i,
    exact: true,
  })
  await graph
    .getByText('3 of 3 notes · 1 connection', { exact: true })
    .waitFor()
  const connections = graph.getByRole('region', { name: 'Connections' })
  await connections.getByRole('button', { name: 'b.md', exact: true }).waitFor()
  // Switching notes moves the connections without changing the graph.
  await connections.getByRole('button', { name: 'b.md', exact: true }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'b.md',
  )
  await connections.getByRole('button', { name: 'a.md', exact: true }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'a.md',
  )
  await connections.getByRole('button', { name: 'b.md', exact: true }).waitFor()
  await graph
    .getByText('3 of 3 notes · 1 connection', { exact: true })
    .waitFor()
  // A link typed but not saved appears at once.
  await pressShortcut(app, `${mod}+Shift+]`)
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await replaceSourceText(page, source, `${alpha} [gamma](c.md)`)
  await graph
    .getByText('3 of 3 notes · 2 connections', { exact: true })
    .waitFor()
  await connections.getByRole('button', { name: 'c.md', exact: true }).waitFor()
  await waitForAsync(page, async () => (await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(join(root, 'a.md'), 'utf8'), alpha)
  // Removing it again is just as live.
  await replaceSourceText(page, source, alpha)
  await graph
    .getByText('3 of 3 notes · 1 connection', { exact: true })
    .waitFor()
  assert.deepEqual(errors, [])
})

test('discarded edits, stale graph pages, and superseded failures leave current panels', {
  timeout: 90000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-graph-discard-'))
  const root = join(temp, 'notes'),
    profile = join(temp, 'profile')
  await mkdir(root)
  await mkdir(profile)
  const alpha = '# alpha\n\n[next](b.md)\n\n#work'
  await writeFile(join(root, 'a.md'), alpha)
  await writeFile(join(root, 'b.md'), '# beta\n\n[back](a.md)\n\n#work')
  await writeFile(join(root, 'c.md'), '# gamma')
  // Sixty linked notes make every graph read take two pages.
  const filler = (index) => `f${String(index % 60).padStart(2, '0')}`
  for (let index = 0; index < 60; index++)
    await writeFile(
      join(root, `${filler(index)}.md`),
      `[next](${filler(index + 1)}.md)`,
    )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ graph: true, tags: true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
    // Closing an edited note discards it.
    dialog.showMessageBox = async () => ({ response: 1 })
  }, root)
  await pressShortcut(app, `${mod}+Shift+o`)
  await page
    .getByRole('tree', { name: /workspace files/i })
    .getByRole('treeitem', { name: 'b.md', exact: true })
    .waitFor()
  const open = async (name) => {
    await app.evaluate(
      ({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        })
      },
      join(root, name),
    )
    await page.locator('.titlebar[aria-busy="false"]').waitFor()
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      name,
    )
  }
  const choose = async (name) => {
    await pressShortcut(app, `${mod}+k`)
    await page.getByRole('combobox', { name: /search commands/i }).fill(name)
    await page.getByRole('option').first().click()
  }
  const edit = async (text) => {
    const source = page.getByRole('textbox', { name: /markdown editor/i })
    if (!(await source.isVisible())) await pressShortcut(app, `${mod}+Shift+]`)
    await replaceSourceText(page, source, text)
  }
  const discard = async (name) => {
    await page
      .getByRole('button', { name: `Close ${name}`, exact: true })
      .click()
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name !== name,
      name,
    )
  }
  const graph = page.getByRole('complementary', {
    name: /^workspace graph$/i,
    exact: true,
  })
  const tags = page.getByRole('complementary', { name: /^tags$/i, exact: true })
  const summary = (connections) =>
    graph
      .getByText(`63 of 63 notes · ${connections} connections`, { exact: true })
      .waitFor()
  await open('b.md')
  await open('a.md')
  await choose('Open workspace graph')
  await summary(61)
  // Closing an edited note without saving takes its unsaved link away.
  await edit(`${alpha} [gamma](c.md)`)
  await summary(62)
  await discard('a.md')
  await summary(61)
  assert.equal(await readFile(join(root, 'a.md'), 'utf8'), alpha)
  // Likewise for an unsaved tag.
  await open('a.md')
  await edit(`${alpha} #new`)
  await choose('Browse tags')
  const added = tags.getByRole('button', { name: /^#new 1$/i, exact: true })
  await added.waitFor()
  await discard('a.md')
  await added.waitFor({ state: 'detached' })
  // Holds the next graph read's first page in the main process.
  const hold = (failure) =>
    app.evaluate(({ ipcMain }, failure) => {
      const handlers = ipcMain._invokeHandlers
      globalThis.graphQuery ??= handlers.get('workspace:query-references')
      globalThis.graphReads = 0
      globalThis.workspaceReads = 0
      globalThis.workspaceRead ??= handlers.get('workspace:get')
      handlers.set('workspace:get', async (...args) => {
        globalThis.workspaceReads++
        return globalThis.workspaceRead(...args)
      })
      const state = { held: false, release: null }
      globalThis.graphHold = state
      handlers.set('workspace:query-references', async (event, request) => {
        const result = await globalThis.graphQuery(event, request)
        if (request?.kind !== 'graph' || request.cursor) return result
        globalThis.graphReads++
        if (state.held || state.release === undefined) return result
        state.held = true
        await new Promise((resolve) => {
          state.release = resolve
        })
        state.release = undefined
        return failure
          ? { ok: false, code: 'unsupported', message: failure }
          : result
      })
    }, failure)
  const inMain = async (check, arg) => {
    const deadline = performance.now() + 10000
    while (!(await app.evaluate(check, arg))) {
      assert.ok(performance.now() < deadline, String(check))
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(done)),
      )
    }
  }
  // A clean note opened while the graph pages makes its cursor stale; the
  // graph reads again instead of waiting for an edit.
  await hold()
  await choose('Open workspace graph')
  await inMain(() => globalThis.graphHold.held)
  await open('c.md')
  await app.evaluate(() => globalThis.graphHold.release())
  await summary(61)
  assert.ok((await app.evaluate(() => globalThis.graphReads)) >= 2)
  // A read that fails after a newer one was queued leaves no error behind.
  await hold('This test failed an older read.')
  await edit('# gamma\n\nfirst')
  await inMain(() => globalThis.graphHold.held)
  const reads = await app.evaluate(() => [
    globalThis.graphReads,
    globalThis.workspaceReads,
  ])
  // The next edit queues a newer read behind the held one before it fails.
  await edit('# gamma\n\nsecond')
  await inMain((_, [, gets]) => globalThis.workspaceReads > gets, reads)
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  )
  await app.evaluate(() => globalThis.graphHold.release())
  await inMain((_, [graphs]) => globalThis.graphReads > graphs, reads)
  await summary(61)
  await page.waitForFunction(
    () => !document.querySelector('.graph-panel [role="alert"]'),
  )
  assert.deepEqual(errors, [])
})

test('graph and tag reads stop when the workspace goes away, retries included', {
  timeout: 90000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-graph-gone-'))
  const root = join(temp, 'notes'),
    profile = join(temp, 'profile')
  await mkdir(root)
  await mkdir(profile)
  const alpha = '# alpha\n\n[next](b.md)\n\n#work'
  await writeFile(join(root, 'a.md'), alpha)
  await writeFile(join(root, 'b.md'), '# beta\n\n[back](a.md)\n\n#work')
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ graph: true, tags: true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
  }, root)
  await pressShortcut(app, `${mod}+Shift+o`)
  await page
    .getByRole('tree', { name: /workspace files/i })
    .getByRole('treeitem', { name: /^a\.md$/i, exact: true })
    .click()
  const choose = async (name) => {
    await pressShortcut(app, `${mod}+k`)
    await page.getByRole('combobox', { name: /search commands/i }).fill(name)
    await page.getByRole('option').first().click()
  }
  await choose('Open workspace graph')
  const graph = page.getByRole('complementary', {
    name: /^workspace graph$/i,
    exact: true,
  })
  await graph
    .getByText('2 of 2 notes · 1 connection', { exact: true })
    .waitFor()
  // The main process counts metadata reads; while `gone`, the workspace
  // reads as closed, and held queries answer stale once released.
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const query = handlers.get('workspace:query-references')
    const get = handlers.get('workspace:get')
    globalThis.reads = { graph: 0, tags: 0, tag: 0 }
    globalThis.gets = 0
    globalThis.held = []
    globalThis.gone = false
    handlers.set('workspace:get', async (...args) => {
      globalThis.gets++
      return globalThis.gone ? null : get(...args)
    })
    handlers.set('workspace:query-references', async (event, request) => {
      if (request?.kind in globalThis.reads) globalThis.reads[request.kind]++
      if (!globalThis.holding) return query(event, request)
      await new Promise((resolve) => globalThis.held.push(resolve))
      return { ok: false, code: 'stale', message: 'The workspace changed.' }
    })
  })
  // Change refreshes and retries wait 150 ms; the test runs them itself.
  await page.evaluate(() => {
    const schedule = window.setTimeout,
      cancel = window.clearTimeout,
      waiting = new Map()
    let key = 1e9
    window.setTimeout = (callback, delay, ...args) => {
      if (delay !== 150) return schedule(callback, delay, ...args)
      waiting.set(++key, () => callback(...args))
      return key
    }
    window.clearTimeout = (id) => {
      if (!waiting.delete(id)) cancel(id)
    }
    window.waiting = () => waiting.size
    window.runWaiting = () => {
      const runs = [...waiting.values()]
      waiting.clear()
      for (const run of runs) run()
    }
  })
  const inMain = async (check) => {
    const deadline = performance.now() + 10000
    while (!(await app.evaluate(check))) {
      assert.ok(performance.now() < deadline, String(check))
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(done)),
      )
    }
  }
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  // Each edit runs what waits 150 ms until the change refresh reads the workspace.
  const edit = async (text) => {
    const gets = await app.evaluate(() => globalThis.gets)
    if (!(await source.isVisible())) await pressShortcut(app, `${mod}+Shift+]`)
    await replaceSourceText(page, source, text)
    while ((await app.evaluate(() => globalThis.gets)) === gets) {
      await page.waitForFunction(() => window.waiting() > 0)
      await page.evaluate(() => window.runWaiting())
      await page.evaluate(() => window.hibi.getDocument())
    }
  }
  // An edit starts a read that waits in the main process; the workspace then
  // goes away, and the read comes back stale, which would retry.
  const goneWhileReading = async (panel, kinds, text) => {
    await app.evaluate(() => {
      globalThis.holding = true
    })
    await edit(`${alpha} ${text}`)
    await inMain(() => globalThis.held.length > 0)
    await app.evaluate(() => {
      globalThis.gone = true
    })
    await edit(`${alpha} ${text} again`)
    await panel.getByText('No workspace open', { exact: true }).waitFor()
    const before = await app.evaluate(() => ({ ...globalThis.reads }))
    await app.evaluate(() => {
      globalThis.holding = false
      for (const release of globalThis.held.splice(0)) release()
    })
    await page.waitForFunction(
      (count) => window.waiting() >= count,
      kinds.length,
    )
    await page.evaluate(() => window.runWaiting())
    // Queries sent by those retries reach the main process before this read.
    await page.evaluate(() => window.hibi.getDocument())
    const after = await app.evaluate(() => ({ ...globalThis.reads }))
    for (const kind of kinds) assert.equal(after[kind], before[kind], kind)
    await app.evaluate(() => {
      globalThis.gone = false
    })
  }
  await goneWhileReading(graph, ['graph'], '[back](b.md)')
  // The tags panel's summary and its selected tag's notes stop as well.
  await edit(alpha)
  await choose('Browse tags')
  const tags = page.getByRole('complementary', { name: /^tags$/i, exact: true })
  await tags.getByRole('button', { name: /^#work 2$/i, exact: true }).click()
  await tags.getByText('#work · 2 notes', { exact: true }).waitFor()
  await goneWhileReading(tags, ['tags', 'tag'], '#more')
  assert.deepEqual(errors, [])
})
