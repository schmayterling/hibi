import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

/** A note of `size` KiB: a heading, `lead`, then paragraphs of ordinary words. */
const makeSource = (size, lead = '') => {
  const unit = `${'ordinary words '.repeat(16)}\n\n`,
    length = size * 1024
  return `# Large note\n\n${lead}${unit.repeat(Math.ceil(length / unit.length))}`.slice(
    0,
    length,
  )
}

/** Open a note of `size` KiB with the CodeMirror formatted view switched on. */
async function open(t, size, lead) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-hidden-source-'))
  const file = join(folder, 'note.md')
  await writeFile(file, makeSource(size, lead))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(60000)
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  const view = (name) =>
    page
      .locator('.view-switch')
      .getByRole('button', { name, exact: true })
      .click()
  // Visit the source view, then return to the formatted view.
  await view('Source view')
  await page
    .locator('.source-pane .cm-line', { hasText: 'Large note' })
    .waitFor()
  await view('normal')
  await page
    .locator('.rich-pane .hibi-lp-h1', { hasText: 'Large note' })
    .waitFor()
  return { app, page, view }
}

/** Live JavaScript heap after a full collection. */
async function heap(page) {
  const session = await page.context().newCDPSession(page)
  await session.send('HeapProfiler.enable')
  await session.send('HeapProfiler.collectGarbage')
  await session.send('HeapProfiler.collectGarbage')
  const { usedSize } = await session.send('Runtime.getHeapUsage')
  await session.detach()
  return usedSize
}

const mounted = (page) => page.locator('.source-pane .cm-editor').count()

test('leaving the source view of a 50 MiB note unmounts it and releases its text', {
  timeout: 240000,
}, async (t) => {
  const { page, view } = await open(t, 50 * 1024)
  // Before, the hidden source view kept its own copy of the note's text.
  await waitForAsync(
    page,
    () => document.querySelectorAll('.source-pane .cm-editor').length === 0,
  ).catch(() => {})
  console.log(
    JSON.stringify({
      note: '50 MiB',
      sourceMounted: await mounted(page),
      heapMiB: Math.round((await heap(page)) / 1024 / 1024),
    }),
  )
  assert.equal(await mounted(page), 0)
  // The next visit loads the source view again.
  await view('Source view')
  await page
    .locator('.source-pane .cm-line', { hasText: 'Large note' })
    .waitFor()
})

test('a small note keeps its source view ready after a visit', {
  timeout: 120000,
}, async (t) => {
  const { page } = await open(t, 16)
  assert.equal(await mounted(page), 1)
})

/** The source view's selection and the first position of the line at its top. */
const place = (page) =>
  page.evaluate(() => {
    const view = document.querySelector('.source-pane .cm-content').cmTile.root
      .view
    const height = view.scrollDOM.getBoundingClientRect().top - view.documentTop
    const { anchor, head } = view.state.selection.main
    return { anchor, head, top: view.lineBlockAtHeight(height).from }
  })

/** Wait for a source view that holds the note, two frames after it mounts. */
async function sourceShown(page) {
  await waitForAsync(page, () => {
    const content = document.querySelector('.source-pane .cm-content')
    return content?.cmTile?.root?.view?.state.doc.length > 1024 * 1024
  })
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
  })
}

test("a large note's source view comes back with its selection and scroll, mapped through edits", {
  timeout: 240000,
}, async (t) => {
  const { page, view } = await open(t, 2 * 1024)
  await view('Source view')
  await sourceShown(page)
  await page.evaluate(() => {
    const view = document.querySelector('.source-pane .cm-content').cmTile.root
      .view
    view.dispatch({
      selection: { anchor: 19000, head: 19010 },
      scrollIntoView: true,
    })
  })
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
  })
  const before = await place(page)
  assert.deepEqual([before.anchor, before.head], [19000, 19010])
  assert.ok(before.top > 0, JSON.stringify(before))
  const leave = async () => {
    await view('normal')
    await waitForAsync(
      page,
      () => document.querySelectorAll('.source-pane .cm-editor').length === 0,
    )
  }
  // Without edits, the source view comes back where it was.
  await leave()
  await view('Source view')
  await sourceShown(page)
  await t.test(
    'source view restores its unchanged selection and scroll',
    {
      todo: 'formatted gap release-001: reopening source must restore its saved scroll position',
    },
    async () => {
      assert.deepEqual(await place(page), before)
    },
  )
  // An edit above it in the formatted view moves both by its length.
  await leave()
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({ changes: { from: 0, insert: 'x\n' }, userEvent: 'input' })
  })
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith('x\n# Large note'),
  )
  await view('Source view')
  await sourceShown(page)
  await t.test(
    'source view maps selection and scroll through a formatted edit',
    {
      todo: 'formatted gap release-002: formatted edits must map the saved source scroll position',
    },
    async () => {
      assert.deepEqual(await place(page), {
        anchor: before.anchor + 2,
        head: before.head + 2,
        top: before.top + 2,
      })
    },
  )
})

test("find shows its matches in a large note's source view that mounts again", {
  timeout: 240000,
}, async (t) => {
  const { app, page, view } = await open(
    t,
    2 * 1024,
    'a needle, another needle and a third needle\n\n',
  )
  await pressShortcut(app, `${mod}+f`)
  await page
    .getByRole('textbox', { name: 'Find in document', exact: true })
    .fill('needle')
  await waitForAsync(
    page,
    () => document.querySelector('.find-count')?.textContent === '1/3',
  )
  for (let visit = 0; visit < 2; visit++) {
    await view('Source view')
    await sourceShown(page)
    await waitForAsync(
      page,
      () =>
        document.querySelectorAll('.source-pane .cm-searchMatch').length ===
          3 && document.querySelector('.find-count')?.textContent === '1/3',
    )
    assert.equal(await page.locator('.find-count').textContent(), '1/3')
    assert.equal(
      await page
        .getByRole('textbox', { name: 'Find in document', exact: true })
        .inputValue(),
      'needle',
    )
    await view('normal')
    await waitForAsync(
      page,
      () => document.querySelectorAll('.source-pane .cm-editor').length === 0,
    )
  }
})

test('a note that grows to 50 mib releases its source view after a visit', {
  timeout: 240000,
}, async (t) => {
  const { app, page, view } = await open(t, 16)
  assert.equal(await mounted(page), 1)
  const before = await page.evaluate(async () => {
    const document = await window.hibi.getDocument()
    return {
      tabId: document.tabId,
      contentVersion: document.contentVersion,
      units: document.markdown.length,
    }
  })
  const target = 50 * 1024 * 1024
  // Drain each admitted edit; growth must keep this document's activation.
  const lengths = await page.evaluate(async (target) => {
    const lengths = []
    const unit = '\n\nordinary growth words '.repeat(16)
    while (true) {
      const element = document.querySelector(
        '.rich-pane [aria-label="Document editor"]',
      )
      const editor = element.cmTile.root.view
      const remaining = target - editor.state.doc.length
      if (!remaining) break
      const size = Math.min(remaining, 1024 * 1024)
      const insert = unit.repeat(Math.ceil(size / unit.length)).slice(0, size)
      editor.dispatch({
        changes: { from: editor.state.doc.length, insert },
        userEvent: 'input.type',
      })
      await window.hibi.flushDocumentChanges()
      lengths.push(editor.state.doc.length)
      if (editor.state.doc.length !== target - remaining + size)
        throw new Error('Growth edit was not admitted.')
    }
    return lengths
  }, target)
  assert.deepEqual(
    lengths,
    Array.from(
      { length: Math.ceil((target - before.units) / (1024 * 1024)) },
      (_, index) => Math.min(target, before.units + (index + 1) * 1024 * 1024),
    ),
  )
  const after = await page.evaluate(async () => {
    const document = await window.hibi.getDocument()
    return {
      tabId: document.tabId,
      contentVersion: document.contentVersion,
      units: document.markdown.length,
    }
  })
  assert.equal(after.tabId, before.tabId)
  assert.equal(after.units, target)
  assert.equal(after.contentVersion, before.contentVersion + lengths.length)
  await view('Source view')
  await sourceShown(page)
  assert.equal(
    await page.locator('.source-pane .cm-content').evaluate((element) => {
      const editor = element.cmTile.root.view
      window.grownSourceDestroyed = 0
      const destroy = editor.destroy.bind(editor)
      editor.destroy = () => {
        window.grownSourceDestroyed++
        destroy()
      }
      return editor.state.doc.length
    }),
    target,
  )
  await view('normal')
  await waitForDocumentEditor(app, page)
  await waitForAsync(
    page,
    () => document.querySelectorAll('.source-pane .cm-editor').length === 0,
  ).catch(() => {})
  const state = {
    sourceMounted: await mounted(page),
    sourceDestroyed: await page.evaluate(() => window.grownSourceDestroyed),
  }
  t.diagnostic(
    JSON.stringify({ units: target, edits: lengths.length, ...state }),
  )
  await t.test(
    'the huge source view is unmounted after normal view returns',
    {
      todo: 'formatted gap release-003: a note that grows huge must release its hidden source view',
    },
    () => {
      assert.equal(state.sourceMounted, 0)
    },
  )
  await t.test(
    'the source editor holding the huge rope is destroyed',
    {
      todo: 'formatted gap release-004: releasing a grown huge source must destroy its editor',
    },
    () => {
      assert.ok(state.sourceDestroyed > 0)
    },
  )
  await t.test(
    'normal view still owns the exact accepted document length',
    async () => {
      assert.equal(
        await page
          .locator('.rich-pane .cm-content')
          .evaluate((element) => element.cmTile.root.view.state.doc.length),
        target,
      )
    },
  )
})
