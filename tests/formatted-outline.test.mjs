import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const filler = (name) =>
  Array.from({ length: 30 }, (_, i) => `${name} paragraph ${i}.`).join('\n\n')

test('behind the switch, the formatted view reports, follows and navigates the rich outline', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-outline-'))
  const file = join(folder, 'outline.md')
  await writeFile(
    file,
    [
      '# Title',
      'Intro.',
      '## Section *one* with [a link](https://example.com)',
      filler('first'),
      'Setext two\n----------',
      filler('second'),
      '### Deep `code` &amp; heading',
      filler('deep'),
      'Setext top\n==========',
      '## Reference [label][ref]',
      '[ref]: /target',
      filler('reference'),
      '1. #### Ordered heading',
      '#### Last **bold**',
      'End.\n',
    ].join('\n\n'),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.setViewportSize({ width: 1100, height: 700 })
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  const outline = page.locator(
    '.outline-sidebar[data-side="right"][data-open="true"]',
  )
  const openOutline = async () => {
    if (await outline.count()) return
    await page.getByRole('button', { name: /^toggle right sidebar$/i }).click()
    await page.getByRole('button', { name: /^right sidebar views$/i }).click()
    await page
      .getByRole('menuitem', { name: 'On this page', exact: true })
      .click()
    await outline.waitFor()
  }
  const entries = () =>
    page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '.outline-sidebar[data-side="right"] [role="treeitem"]',
        ),
      ].map((item) => ({
        prefix: item.id.split(':')[0],
        label: item.querySelector('.sidebar-label')?.textContent,
        depth: item.getAttribute('aria-level'),
      })),
    )

  // The rich view's outline is the reference for the same note.
  await clickMenu(app, 'Open…')
  await page.locator('.tiptap h4', { hasText: 'Last' }).waitFor()
  await openOutline()
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '.outline-sidebar[data-side="right"] [role="treeitem"]',
      ).length === 8,
  )
  const rich = (await entries()).map(({ label, depth }) => ({ label, depth }))
  assert.deepEqual(
    rich.map(({ label }) => label),
    [
      'Title',
      'Section one with a link',
      'Setext two',
      'Deep code & heading',
      'Setext top',
      'Reference label',
      'Ordered heading',
      'Last bold',
    ],
  )

  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await clickMenu(app, 'Open…')
  await page.locator('.rich-pane .hibi-lp-h1', { hasText: 'Title' }).waitFor()
  assert.equal(await page.locator('.rich-pane .tiptap').count(), 0)
  // Hidden windows have no focus; the outline focuses the view it moves.
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await openOutline()

  // (1) The same entries, read from the note's source.
  await page.waitForFunction(
    (expected) =>
      JSON.stringify(
        [
          ...document.querySelectorAll(
            '.outline-sidebar[data-side="right"] [role="treeitem"]',
          ),
        ].map((item) => ({
          label: item.querySelector('.sidebar-label')?.textContent,
          depth: item.getAttribute('aria-level'),
        })),
      ) === expected,
    JSON.stringify(rich),
  )
  assert.ok(
    (await entries()).every(({ prefix }) => prefix === 'right-outline-source'),
  )

  const caret = () =>
    page.evaluate(() => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      const head = view.state.selection.main.head,
        line = view.coordsAtPos(head),
        scroller = view.scrollDOM.getBoundingClientRect()
      return {
        line: view.state.doc.lineAt(head).text,
        visible:
          !!line && line.top >= scroller.top && line.bottom <= scroller.bottom,
        focused: view.hasFocus,
      }
    })
  const selected = outline.locator(
    '[role="treeitem"][aria-selected="true"] .sidebar-label',
  )
  const expectSelected = (label) =>
    page.waitForFunction(
      (label) =>
        document.querySelector(
          '.outline-sidebar[data-side="right"] [role="treeitem"][aria-selected="true"] .sidebar-label',
        )?.textContent === label,
      label,
    )

  // (2) Choosing an entry moves the formatted view's caret to the heading and
  // scrolls it into view.
  assert.equal((await caret()).visible, true)
  assert.notEqual((await caret()).line, '#### Last **bold**')
  await outline
    .getByRole('treeitem', { name: 'Last bold', exact: true })
    .click()
  await page.waitForFunction(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    return (
      view.state.doc.lineAt(view.state.selection.main.head).text ===
      '#### Last **bold**'
    )
  })
  assert.deepEqual(await caret(), {
    line: '#### Last **bold**',
    visible: true,
    focused: true,
  })
  await expectSelected('Last bold')
  await outline
    .getByRole('treeitem', { name: 'Setext two', exact: true })
    .click()
  await page.waitForFunction(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    return (
      view.state.doc.lineAt(view.state.selection.main.head).text ===
      'Setext two'
    )
  })
  assert.equal((await caret()).visible, true)

  // (3) The active heading follows the caret through the note.
  for (const [text, label] of [
    ['deep paragraph 3.', 'Deep code & heading'],
    ['Intro.', 'Title'],
    ['reference paragraph 0.', 'Reference label'],
    ['second paragraph 29.', 'Setext two'],
  ]) {
    await page.evaluate((text) => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.dispatch({
        selection: { anchor: view.state.doc.toString().indexOf(text) + 2 },
        scrollIntoView: true,
      })
    }, text)
    await expectSelected(label)
    assert.equal(await selected.textContent(), label)
  }

  // A refreshed file revision must discard the previous reference resolution.
  let previous = await page.evaluate(() => window.hibi.getDocument())
  const original = await readFile(file, 'utf8')
  for (const text of [original.replace('[ref]:', '[gone]:'), original]) {
    await writeFile(file, text)
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async (revision) => (await window.hibi.getDocument()).revision > revision,
      previous.revision,
    )
    const expected = rich.map((heading) => ({
      ...heading,
      label:
        text === original || heading.label !== 'Reference label'
          ? heading.label
          : 'Reference [label][ref]',
    }))
    await page.waitForFunction(
      (expected) =>
        JSON.stringify(
          [
            ...document.querySelectorAll(
              '.outline-sidebar[data-side="right"] [role="treeitem"]',
            ),
          ].map((item) => ({
            label: item.querySelector('.sidebar-label')?.textContent,
            depth: item.getAttribute('aria-level'),
          })),
        ) === JSON.stringify(expected),
      expected,
    )
    assert.deepEqual(
      (await entries()).map(({ label, depth }) => ({ label, depth })),
      expected,
    )
    previous = await page.evaluate(() => window.hibi.getDocument())
  }

  // (4) Typing right after a jump edits the heading's text, as in the rich
  // view, instead of its hidden marker.
  for (const [label, typed] of [
    ['Last bold', '#### xLast **bold**'],
    ['Ordered heading', '1. #### xOrdered heading'],
    ['Setext two', 'xSetext two'],
  ]) {
    const line = typed.replace('x', '')
    await outline.getByRole('treeitem', { name: label, exact: true }).click()
    await page.waitForFunction((line) => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      return (
        view.hasFocus &&
        view.state.doc.lineAt(view.state.selection.main.head).text === line
      )
    }, line)
    await page.keyboard.press('x')
    await page.waitForFunction((line) => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      return view.state.doc.lineAt(view.state.selection.main.head).text !== line
    }, line)
    assert.equal((await caret()).line, typed)
    await outline
      .getByRole('treeitem', { name: `x${label}`, exact: true })
      .waitFor()
    await pressShortcut(app, `${mod}+z`)
    await outline.getByRole('treeitem', { name: label, exact: true }).waitFor()
    assert.equal((await caret()).line, line)
  }
})

test('an open outline on a 50 MiB formatted note reuses headings after body edits', {
  timeout: 120000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-outline-50m-'))
  const file = join(folder, 'large.md')
  const block = `## heading\n\n${`${'plain text body '.repeat(15)}\n`.repeat(16)}\n\n`
  const source = block
    .repeat(Math.ceil((50 * 1024 * 1024) / block.length))
    .slice(0, 50 * 1024 * 1024)
  await writeFile(file, source)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(60000)
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  const chunks = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const chunk = chunks.find((chunk) =>
    chunk.modules.some((path) =>
      path.endsWith('src/renderer/src/source-outline.ts'),
    ),
  )
  assert.ok(chunk)
  await page.evaluate(async (file) => {
    const module = await import(`app://hibi/${file}`)
    const model = Object.values(module).find(
      (value) => value?.prototype?.read && value.prototype.counters,
    )
    const read = model.prototype.read
    window.outlineReads = []
    model.prototype.read = function* () {
      const iterator = read.call(this)
      let value,
        steps = 0
      try {
        for (;;) {
          const step = iterator.next(value)
          if (step.done) {
            window.outlineReads.push({
              ...this.counters(true),
              steps,
              headings: step.value.headings.length,
              tail: step.value.position(step.value.headings.length - 1),
            })
            return step.value
          }
          steps++
          value = yield step.value
        }
      } finally {
        iterator.return()
      }
    }
  }, chunk.file)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await clickMenu(app, 'Open…')
  await page.locator('.rich-pane .cm-content').waitFor()
  await page.getByRole('button', { name: /^toggle right sidebar$/i }).click()
  await page.getByRole('button', { name: /^right sidebar views$/i }).click()
  await page
    .getByRole('menuitem', { name: 'On this page', exact: true })
    .click()
  await page.waitForFunction(() => window.outlineReads.length > 0)
  const initial = await page.evaluate(() => window.outlineReads.at(-1))
  assert.equal(initial.headings, 13548)
  assert.equal(initial.labelsRead, 13548)
  const from = source.indexOf('body', Math.floor(source.length / 2))
  let tail = source.lastIndexOf('## heading')
  for (const insert of ['B', 'b', 'text']) {
    const count = await page.evaluate(() => window.outlineReads.length)
    await page.locator('.rich-pane .cm-content').evaluate(
      (element, { from, insert }) => {
        element.cmTile.root.view.dispatch({
          changes: { from, to: from + 1, insert },
        })
      },
      { from, insert },
    )
    await page.waitForFunction(
      (count) => window.outlineReads.length > count,
      count,
    )
    const work = await page.evaluate(() => window.outlineReads.at(-1))
    assert.equal(work.headings, 13548)
    tail += insert.length - 1
    assert.equal(work.tail, tail)
    assert.equal(work.labelsRead, 0, JSON.stringify(work))
    assert.equal(work.published, 0)
    assert.ok(work.steps < 100, JSON.stringify(work))
    assert.ok(work.indexVisits < 100, JSON.stringify(work))
    assert.ok(
      (await page.locator('.outline-sidebar .sidebar-row').count()) < 65,
    )
  }
  assert.deepEqual(
    await page
      .pageErrors()
      .then((errors) => errors.map((error) => error.message)),
    [],
  )
})

test('outline rows name long headings in full and shorten them only on screen', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-outline-long-'))
  const file = join(folder, 'long.md')
  const words = Array.from({ length: 300 }, (_, i) => `word${i} **bold ${i}**`)
  const label = words.join(' ').replaceAll('**', '')
  await writeFile(file, `# ${words.join(' ')}\n\nBody.\n\n## Short\n`)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`, file],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.setViewportSize({ width: 1100, height: 700 })
  const outline = page.locator(
    '.outline-sidebar[data-side="right"][data-open="true"]',
  )
  const rows = async () => {
    await waitForDocumentEditor(app, page)
    if (!(await outline.count())) {
      await page
        .getByRole('button', { name: /^toggle right sidebar$/i })
        .click()
      await page.getByRole('button', { name: /^right sidebar views$/i }).click()
      await page
        .getByRole('menuitem', { name: 'On this page', exact: true })
        .click()
    }
    const short = outline.getByRole('treeitem', { name: 'Short', exact: true })
    await short.waitFor()
    const row = outline.getByRole('treeitem').first()
    return {
      label: await row.locator('.sidebar-label').textContent(),
      rowHeight: await short.evaluate(
        (element) => element.getBoundingClientRect().height,
      ),
      ...(await row.evaluate((element) => {
        const text = element.querySelector('.sidebar-label')
        return {
          clipped:
            getComputedStyle(text).textOverflow === 'ellipsis' &&
            text.scrollWidth > text.clientWidth,
          height: element.getBoundingClientRect().height,
        }
      })),
    }
  }

  // The rich view's outline names the heading by its whole text.
  const rich = await rows()
  assert.equal(rich.label.length, label.length)
  assert.equal(rich.label, label)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await page.locator('.rich-pane .hibi-lp-h1').waitFor()
  const formatted = await rows()
  assert.equal(formatted.label.length, label.length)
  assert.deepEqual(formatted, rich)
  assert.equal(formatted.clipped, true)
  assert.equal(formatted.height, formatted.rowHeight)
})

test('long outline labels run in a worker and cancel when edited, closed, or the note changes', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-outline-label-worker-'))
  const file = join(folder, 'labels.md')
  await writeFile(file, '# Short\n\nBody.\n')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`, file],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(60000)
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      message.text().startsWith('Source outline failed:')
    )
      t.diagnostic(message.text().slice(0, 500))
  })
  await page.addInitScript(() => {
    window.outlineLabelRequests = []
    window.outlineLabelTerminations = 0
    window.holdOutlineLabels = true
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      postMessage(message, ...rest) {
        if (message?.request?.text && message?.flavors) {
          this.outlineLabel = true
          window.outlineLabelRequests.push(message.request.text)
          if (window.holdOutlineLabels) return
        }
        super.postMessage(message, ...rest)
      }
      terminate() {
        if (this.outlineLabel) window.outlineLabelTerminations++
        super.terminate()
      }
    }
  })
  await page.reload()
  await waitForDocumentEditor(app, page)
  const editor = page.locator('.rich-pane .cm-content')
  await editor.waitFor()
  await page.getByRole('button', { name: /^toggle right sidebar$/i }).click()
  await page.getByRole('button', { name: /^right sidebar views$/i }).click()
  await page
    .getByRole('menuitem', { name: 'On this page', exact: true })
    .click()
  const outline = page.locator('.outline-sidebar[data-side="right"]')
  await outline.getByRole('treeitem', { name: 'Short', exact: true }).waitFor()
  const replace = (source) =>
    editor.evaluate((element, source) => {
      const view = element.cmTile.root.view
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: source },
      })
    }, source)
  const text = `${'*a '.repeat(1000)}b${' a*'.repeat(1000)}`
  const source = `# ${text}\n\nBody.\n`
  const label = `${'a '.repeat(1000)}b${' a'.repeat(1000)}`

  // Hold a request to make cancellation independent of the machine's speed.
  await replace(source)
  await page.waitForFunction(() => window.outlineLabelRequests.length === 1)
  assert.equal(await page.evaluate(() => window.outlineLabelRequests[0]), text)
  await replace('# Latest\n\nBody.\n')
  await outline.getByRole('treeitem', { name: 'Latest', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.outlineLabelTerminations), 1)

  // Now execute the real pathological lexer and native conversion in its worker.
  await page.evaluate(() => {
    window.holdOutlineLabels = false
  })
  await replace(source)
  await page.waitForFunction(
    (label) =>
      document.querySelector(
        '.outline-sidebar[data-side="right"] .sidebar-label',
      )?.textContent === label,
    label,
  )
  assert.equal(
    await outline.getByRole('treeitem', { name: label, exact: true }).count(),
    1,
  )
  assert.equal(await page.evaluate(() => window.outlineLabelRequests.length), 2)

  // A new pending label must also terminate when the outline closes.
  await page.evaluate(() => {
    window.holdOutlineLabels = true
  })
  await replace(source.replace('# ', '# changed '))
  await page.waitForFunction(() => window.outlineLabelRequests.length === 3)
  const beforeClose = await page.evaluate(() => window.outlineLabelTerminations)
  await page.getByRole('button', { name: /^toggle right sidebar$/i }).click()
  await page.waitForFunction(
    (count) => window.outlineLabelTerminations > count,
    beforeClose,
  )

  // A screen reader reads heading navigation's labels with the sidebar
  // closed; changing notes cancels them.
  await outline.waitFor({ state: 'hidden' })
  await app.evaluate(({ app }) => app.setAccessibilitySupportEnabled(true))
  await page.waitForFunction(() => window.outlineLabelRequests.length === 4)
  const beforeNew = await page.evaluate(() => window.outlineLabelTerminations)
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  await clickMenu(app, 'New')
  await page.waitForFunction(
    (count) => window.outlineLabelTerminations > count,
    beforeNew,
  )
  assert.deepEqual(
    (await page.pageErrors()).map((error) => error.message),
    [],
  )
})
