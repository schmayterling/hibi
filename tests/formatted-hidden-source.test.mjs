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
const makeSource = (
  size,
  lead = '',
  unit = `${'ordinary words '.repeat(16)}\n\n`,
) => {
  const length = size * 1024
  return `# Large note\n\n${lead}${unit.repeat(Math.ceil(length / unit.length))}`.slice(
    0,
    length,
  )
}

/**
 * Open a note of `size` KiB with the CodeMirror formatted view switched on.
 * `before` runs on the page first; with `stay`, its source view stays shown.
 */
async function open(
  t,
  size,
  lead,
  { lineNumbers = false, unit, before = async () => {}, stay = false } = {},
) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-hidden-source-'))
  const file = join(folder, 'note.md')
  await writeFile(file, makeSource(size, lead, unit))
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
  await page.evaluate((lineNumbers) => {
    localStorage.setItem('hibi:formatted-engine', 'codemirror')
    localStorage.setItem('line-numbers', String(lineNumbers))
  }, lineNumbers)
  await page.reload()
  await waitForDocumentEditor(app, page)
  await before(app, page)
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
  if (stay) return { app, page, view }
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

/** Wait for a shown, editable source view of `units` or more, four frames after its pane stops moving. */
async function sourceShown(page, units = 1024 * 1024) {
  await waitForAsync(
    page,
    (units) => {
      const pane = document.querySelector('.source-pane')
      return (
        pane?.querySelector('.cm-content[contenteditable="true"]')?.cmTile?.root
          ?.view?.state.doc.length > units &&
        pane.closest('.mode-markdown') !== null &&
        !pane.getAnimations().length
      )
    },
    units,
  )
  await page.evaluate(async () => {
    for (let frame = 0; frame < 4; frame++)
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
    async () => {
      assert.deepEqual(await place(page), {
        anchor: before.anchor + 2,
        head: before.head + 2,
        top: before.top + 2,
      })
    },
  )
})

/** The line at the source view's top and how far it is scrolled past, in pixels. */
const scrolled = (page) =>
  page.evaluate(() => {
    const view = document.querySelector('.source-pane .cm-content').cmTile.root
      .view
    const height = view.scrollDOM.getBoundingClientRect().top - view.documentTop
    const line = view.lineBlockAtHeight(height)
    return { top: line.from, offset: height - line.top }
  })

/**
 * Leave and reopen the source view `count` times, returning where it shows
 * each time; `grow` runs once, after the first leave.
 */
async function returns(page, view, units, count, grow = async () => {}) {
  const places = []
  for (let visit = 0; visit < count; visit++) {
    await view('normal')
    if (!visit) await grow()
    await waitForAsync(
      page,
      () => document.querySelectorAll('.source-pane .cm-editor').length === 0,
    )
    await view('Source view')
    await sourceShown(page, units)
    places.push(await scrolled(page))
  }
  return places
}

/** Each return shows the same top line, as far into it as scroll positions round. */
function samePlace(places, before) {
  const message = JSON.stringify({ before, places })
  for (const place of places) {
    assert.equal(place.top, before.top, message)
    assert.ok(Math.abs(place.offset - before.offset) < 1, message)
  }
}

/** A 600 second move of the panes when the source view opens. */
const slowPaneMotion =
  '.editor-panes { transition: transform 600s linear !important; } .editor-panes.mode-markdown { transform: translateX(0.01px); }'

/** A 2 MiB note of short wrapping lines, at 80% zoom and an 11px font. */
async function openWrapped(t) {
  const state = await open(t, 2 * 1024, '', {
    unit: `${'ordinary words in a wrapped paragraph '.repeat(3)}\n`,
  })
  await state.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(1100, 900)
    window.webContents.setZoomFactor(0.8)
  })
  await state.page.addStyleTag({
    content:
      '.source-pane .cm-content { font-size: 11px !important; line-height: 1.25 !important; }',
  })
  return state
}

/** Scroll the shown source view 13 pixels into the line at `at`. */
const scrollInto = (page, at) =>
  page.evaluate(async (at) => {
    const view = document.querySelector('.source-pane .cm-content').cmTile.root
      .view
    view.scrollDOM.scrollTop = view.lineBlockAt(at).top + 13
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
  }, at)

test("a large note's source view returns to the same line and pixel every time", {
  timeout: 240000,
}, async (t) => {
  const { page, view } = await open(t, 2 * 1024)
  await view('Source view')
  await sourceShown(page)
  await scrollInto(page, 19000)
  const before = await scrolled(page)
  assert.ok(before.top > 0 && before.offset > 0, JSON.stringify(before))
  const places = await returns(page, view, 1024 * 1024, 4)
  samePlace(places, before)
})

test("a large note's source view returns to the same line and pixel at another zoom and line height", {
  timeout: 240000,
}, async (t) => {
  // Lines that wrap to one or two short rows, so the pane widening after the
  // view is built moves many of them.
  const { page, view } = await openWrapped(t)
  await view('Source view')
  await sourceShown(page)
  await scrollInto(page, 20000)
  const before = await scrolled(page)
  assert.ok(before.top > 0 && before.offset > 0, JSON.stringify(before))
  const places = await returns(page, view, 1024 * 1024, 4)
  samePlace(places, before)
})

test("with reduced motion, a large note's source view returns to the same line and pixel", {
  timeout: 240000,
}, async (t) => {
  // The pane moves and widens at once, before the hidden view's effects run,
  // in a focused window, so the shown source view takes focus.
  const { page, view } = await open(t, 360, '', {
    unit: `${'ordinary words in a wrapped paragraph '.repeat(3)}\n`,
    stay: true,
    before: async (app, page) => {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1000, 760),
      )
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const session = await page.context().newCDPSession(page)
      await session.send('Emulation.setFocusEmulationEnabled', {
        enabled: true,
      })
    },
  })
  await sourceShown(page, 256 * 1024)
  await page.evaluate(() =>
    document
      .querySelector('.source-pane .cm-content')
      .cmTile.root.view.dispatch({
        selection: { anchor: 20000 },
        scrollIntoView: true,
      }),
  )
  await scrollInto(page, 20000)
  const before = await scrolled(page)
  const places = await returns(page, view, 256 * 1024, 4)
  samePlace(places, before)
})

test("an unrelated paused transition does not hold a returning source view's place", {
  timeout: 240000,
}, async (t) => {
  const { page, view } = await openWrapped(t)
  await page.evaluate(async () => {
    document.body.style.outline = '1px solid rgb(0, 0, 0)'
    document.body.style.setProperty(
      'transition',
      'outline-color 600s linear',
      'important',
    )
    getComputedStyle(document.body).outlineColor
    document.body.style.outlineColor = 'rgb(120, 80, 40)'
    await new Promise(requestAnimationFrame)
    const [transition] = document.body.getAnimations()
    transition.pause()
  })
  await view('Source view')
  await sourceShown(page)
  await scrollInto(page, 20000)
  const before = await scrolled(page)
  const places = await returns(page, view, 1024 * 1024, 2)
  samePlace(places, before)
})

test("stopped pane motion does not hold a returning source view's place", {
  timeout: 240000,
}, async (t) => {
  const { page, view } = await open(t, 2 * 1024)
  await view('Source view')
  await sourceShown(page)
  await scrollInto(page, 20000)
  const before = await scrolled(page)
  await view('normal')
  await waitForAsync(
    page,
    () => document.querySelectorAll('.source-pane .cm-editor').length === 0,
  )
  // A move of the panes stopped at a playback rate of 0 stays running and
  // never gets nearer its end.
  await page.evaluate(async () => {
    const panes = document.querySelector('.editor-panes')
    panes.style.setProperty('transition', 'transform 2s linear', 'important')
    panes.style.transform = 'translateX(0)'
    getComputedStyle(panes).transform
    panes.style.transform = 'translateX(0.01px)'
    await new Promise(requestAnimationFrame)
    for (const transition of panes.getAnimations()) transition.playbackRate = 0
  })
  samePlace(await returns(page, view, 1024 * 1024, 2), before)
})

test('a source view left while its place waits for pane motion is released', {
  timeout: 240000,
}, async (t) => {
  const { page, view } = await open(t, 2 * 1024)
  await view('Source view')
  await sourceShown(page)
  await scrollInto(page, 20000)
  await view('normal')
  await waitForAsync(
    page,
    () => document.querySelectorAll('.source-pane .cm-editor').length === 0,
  )
  // The panes start a long move that leaving the source view does not end.
  await page.evaluate(async () => {
    const panes = document.querySelector('.editor-panes')
    panes.style.setProperty('transition', 'transform 600s linear', 'important')
    panes.style.transform = 'translateX(0)'
    getComputedStyle(panes).transform
    panes.style.transform = 'translateX(0.01px)'
    await new Promise(requestAnimationFrame)
  })
  await view('Source view')
  await sourceShown(page)
  await page.evaluate(async () => {
    window.waitingSource = new WeakRef(
      document.querySelector('.source-pane .cm-content').cmTile.root.view,
    )
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    // Paused, the move would never end the wait.
    for (const transition of document
      .querySelector('.editor-panes')
      .getAnimations())
      transition.pause()
  })
  await view('normal')
  await waitForAsync(
    page,
    () => document.querySelectorAll('.source-pane .cm-editor').length === 0,
  )
  await heap(page)
  assert.equal(
    await page.evaluate(() => window.waitingSource.deref() === undefined),
    true,
  )
})

test('a returned source view scrolled by script keeps the new place', {
  timeout: 240000,
}, async (t) => {
  const { page, view } = await open(t, 2 * 1024)
  await view('Source view')
  await sourceShown(page)
  await scrollInto(page, 20000)
  // The view comes back to its place and holds it.
  const [held] = await returns(page, view, 1024 * 1024, 1)
  t.diagnostic(
    JSON.stringify(
      await page.evaluate(() => {
        const scroller = document.querySelector('.source-pane .cm-scroller')
        return { scrollbar: scroller.offsetWidth - scroller.clientWidth }
      }),
    ),
  )
  // As a scrollbar drag does, the scroll comes with no input event.
  await page.evaluate(async () => {
    document.querySelector(
      '.source-pane .cm-content',
    ).cmTile.root.view.scrollDOM.scrollTop += 240
    for (let frame = 0; frame < 4; frame++)
      await new Promise(requestAnimationFrame)
  })
  const user = await scrolled(page)
  assert.notEqual(user.top, held.top, JSON.stringify({ held, user }))
  samePlace(await returns(page, view, 1024 * 1024, 2), user)
})

test("scrolling over a returning source view's gutter keeps the user's place", {
  timeout: 240000,
}, async (t) => {
  const { page, view } = await open(t, 2 * 1024, '', { lineNumbers: true })
  await view('Source view')
  await sourceShown(page)
  await scrollInto(page, 20000)
  const before = await scrolled(page)
  await view('normal')
  await waitForAsync(
    page,
    () => document.querySelectorAll('.source-pane .cm-editor').length === 0,
  )
  // Pane motion that has not finished keeps the view's place pending while
  // the wheel turns over the line numbers.
  await page.addStyleTag({ content: slowPaneMotion })
  await view('Source view')
  await sourceShown(page)
  const point = await page.evaluate(() => {
    const view = document.querySelector('.source-pane .cm-content').cmTile.root
      .view
    const gutter = view.dom.querySelector('.cm-gutters').getBoundingClientRect()
    const x = gutter.left + gutter.width / 2,
      y = view.scrollDOM.getBoundingClientRect().top + 100
    return {
      x,
      y,
      gutter: !view.contentDOM.contains(document.elementFromPoint(x, y)),
    }
  })
  assert.ok(point.gutter, JSON.stringify(point))
  const start = await page.evaluate(
    () =>
      document.querySelector('.source-pane .cm-content').cmTile.root.view
        .scrollDOM.scrollTop,
  )
  await page.mouse.move(point.x, point.y)
  await page.mouse.wheel(0, 300)
  await waitForAsync(
    page,
    (start) =>
      document.querySelector('.source-pane .cm-content').cmTile.root.view
        .scrollDOM.scrollTop > start,
    start,
  )
  const user = await scrolled(page)
  assert.notEqual(user.top, before.top, JSON.stringify({ before, user }))
  await page.evaluate(async () => {
    for (const transition of document
      .querySelector('.editor-panes')
      .getAnimations())
      transition.finish()
    for (let frame = 0; frame < 4; frame++)
      await new Promise(requestAnimationFrame)
  })
  samePlace([await scrolled(page)], user)
})

test('a source view released as its note grows returns to the same line and pixel every time', {
  timeout: 240000,
}, async (t) => {
  const { page, view } = await open(t, 16)
  await view('Source view')
  await sourceShown(page, 16000)
  await scrollInto(page, 9000)
  const before = await scrolled(page)
  assert.ok(before.top > 0 && before.offset > 0, JSON.stringify(before))
  // Text after the place grows the note past the large-note size.
  const grow = () =>
    page.evaluate(async () => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.dispatch({
        changes: {
          from: view.state.doc.length,
          insert: '\n\nordinary growth words'.repeat(20000),
        },
        userEvent: 'input',
      })
      await window.hibi.flushDocumentChanges()
    })
  const places = await returns(page, view, 256 * 1024, 4, grow)
  samePlace(places, before)
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

test('a source view released as its note grows keeps its place after the note shrinks', {
  timeout: 120000,
}, async (t) => {
  const { page, view } = await open(t, 16)
  await view('Source view')
  await page.evaluate(() => {
    const view = document.querySelector('.source-pane .cm-content').cmTile.root
      .view
    view.dispatch({
      selection: { anchor: 9000, head: 9010 },
      scrollIntoView: true,
    })
  })
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
  })
  const before = await place(page)
  assert.deepEqual([before.anchor, before.head], [9000, 9010])
  assert.ok(before.top > 0, JSON.stringify(before))
  await view('normal')
  assert.equal(await mounted(page), 1)
  // Text above the hidden view's place grows the note past the large size.
  const edit = (changes) =>
    page.evaluate(async (changes) => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.dispatch({
        changes: { ...changes, insert: changes.insert?.repeat(20000) },
        userEvent: 'input',
      })
      await window.hibi.flushDocumentChanges()
    }, changes)
  const grown = 'ordinary growth words\n\n'
  await edit({ from: 0, insert: grown })
  await waitForAsync(
    page,
    () => document.querySelectorAll('.source-pane .cm-editor').length === 0,
  )
  await edit({ from: 0, to: grown.length * 20000 })
  await view('Source view')
  await waitForAsync(page, () => {
    const content = document.querySelector('.source-pane .cm-content')
    return content?.cmTile?.root?.view?.state.doc.length === 16 * 1024
  })
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
  })
  // It comes back scrolled to the place it kept, not to the start.
  const after = await place(page)
  assert.deepEqual([after.anchor, after.head], [9000, 9010])
  assert.ok(after.top > 0, JSON.stringify(after))
})

test('a note that grows to 50 mib releases its source view after a visit', {
  timeout: 240000,
}, async (t) => {
  const { app, page, view } = await open(t, 16)
  assert.equal(await mounted(page), 1)
  // The small note's hidden source view must go once the note grows large.
  await page.locator('.source-pane .cm-content').evaluate((element) => {
    const editor = element.cmTile.root.view
    window.hiddenSource = new WeakRef(editor)
    window.hiddenSourceDestroyed = 0
    const destroy = editor.destroy.bind(editor)
    editor.destroy = () => {
      window.hiddenSourceDestroyed++
      destroy()
    }
  })
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
  await waitForAsync(
    page,
    () => document.querySelectorAll('.source-pane .cm-editor').length === 0,
  ).catch(() => {})
  const hidden = {
    sourceMounted: await mounted(page),
    sourceDestroyed: await page.evaluate(() => window.hiddenSourceDestroyed),
  }
  const heapMiB = Math.round((await heap(page)) / 1024 / 1024)
  // After a full collection nothing holds the released view.
  hidden.sourceCollected = await page.evaluate(
    () => window.hiddenSource.deref() === undefined,
  )
  t.diagnostic(JSON.stringify({ grown: true, heapMiB, ...hidden }))
  assert.deepEqual(hidden, {
    sourceMounted: 0,
    sourceDestroyed: 1,
    sourceCollected: true,
  })
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
    () => {
      assert.equal(state.sourceMounted, 0)
    },
  )
  await t.test('the source editor holding the huge rope is destroyed', () => {
    assert.ok(state.sourceDestroyed > 0)
  })
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
