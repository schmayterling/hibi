import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function open(t, text) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-formatted-split-'))
  const file = join(root, 'note.md')
  await writeFile(file, text)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.evaluate(() => {
    localStorage.setItem('hibi:formatted-engine', 'codemirror')
    localStorage.setItem(
      'cursor-settings',
      JSON.stringify({ style: 'underline', speed: 'slow', animation: 'blink' }),
    )
  })
  await page.reload()
  await waitForDocumentEditor(app, page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    text,
  )
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await page.locator('.mode-side-by-side[data-source-ready="true"]').waitFor()
  await frames(page)
  return { app, page, file }
}

async function frames(page, count = 5) {
  await page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame)
  }, count)
}

async function select(page, pane, anchor, head = anchor) {
  await page.evaluate(
    ({ pane, anchor, head }) => {
      const view = document.querySelector(`.${pane}-pane .cm-content`).cmTile
        .root.view
      view.focus()
      view.dispatch({ selection: { anchor, head }, scrollIntoView: true })
    },
    { pane, anchor, head },
  )
}

async function mirrored(page, pane) {
  await waitForAsync(
    page,
    ({ pane, other }) => {
      const active = document.querySelector(`.${pane}-pane .cm-content`)
      const view = active.cmTile.root.view
      const target = document.querySelector(`.${other}-pane .cm-content`).cmTile
        .root.view
      const caret = target.coordsAtPos(view.state.selection.main.head)
      const mirror = document
        .querySelector(`.${other}-pane .mirror-cursor`)
        ?.getBoundingClientRect()
      return (
        document.activeElement === active &&
        caret &&
        mirror?.height > 0 &&
        Math.abs(caret.left - mirror.left) < 2 &&
        Math.abs(caret.top - mirror.top) < 2 &&
        Math.abs(caret.bottom - caret.top - mirror.height) < 2
      )
    },
    { pane, other: pane === 'rich' ? 'source' : 'rich' },
  )
}

async function source(page, text) {
  await waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown === text,
    text,
  )
}

test('both formatted split panes edit and undo one source while preserving bom and crlf', {
  timeout: 90000,
}, async (t) => {
  const text =
    '\uFEFF---\r\ntitle: shared\r\n---\r\n\r\n# Shared\r\n\r\nalpha **bold** beta\r\n'
  const normalized = text.replaceAll('\r\n', '\n')
  const { app, page, file } = await open(t, text)
  for (const pane of ['rich', 'source'])
    assert.equal(
      await page
        .locator(`.${pane}-pane .cm-content`)
        .getAttribute('contenteditable'),
      'true',
    )
  await select(page, 'rich', normalized.indexOf('alpha') + 5)
  await page.keyboard.insertText('🌿')
  const first = text.replace('alpha', 'alpha🌿')
  await source(page, first)
  await select(page, 'source', normalized.indexOf('beta') + 2 + 4)
  await page.keyboard.insertText('!')
  const second = first.replace('beta', 'beta!')
  await source(page, second)
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), second)
  await pressShortcut(app, `${mod}+z`)
  await source(page, first)
  await select(page, 'rich', normalized.indexOf('alpha') + 5)
  await pressShortcut(app, `${mod}+z`)
  await source(page, text)
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), text)
})

test('formatted split mirrors either caret, hides metadata and selections, and keeps cursor settings', {
  timeout: 90000,
}, async (t) => {
  const text =
    '---\ntitle: shared\n---\n\n# Shared\n\nalpha **bold** beta\n\n' +
    'last paragraph with some words\n\n'.repeat(50)
  const { page } = await open(t, text)
  for (const pane of ['rich', 'source']) {
    const other = pane === 'rich' ? 'source' : 'rich'
    const before = await page.evaluate((other) => {
      const range = document.querySelector(`.${other}-pane .cm-content`).cmTile
        .root.view.state.selection.main
      return [range.anchor, range.head]
    }, other)
    await select(page, pane, text.indexOf('alpha') + 3)
    await mirrored(page, pane)
    const after = await page.evaluate((other) => {
      const range = document.querySelector(`.${other}-pane .cm-content`).cmTile
        .root.view.state.selection.main
      return [range.anchor, range.head]
    }, other)
    assert.deepEqual(
      after,
      before,
      'mirroring never changes the other selection',
    )
    assert.equal(
      await page
        .locator(`.${pane}-pane .editor-cursor`)
        .getAttribute('data-style'),
      'underline',
    )
    assert.equal(
      await page
        .locator(`.${pane}-pane .editor-cursor`)
        .getAttribute('data-animation'),
      'blink',
    )
  }
  await select(page, 'source', text.indexOf('alpha'), text.indexOf('beta'))
  await waitForAsync(page, () => !document.querySelector('.mirror-cursor'))
  await select(page, 'source', text.indexOf('title:') + 3)
  await frames(page)
  assert.equal(
    await page.locator('.mirror-cursor').count(),
    0,
    'metadata has no formatted caret',
  )
  await select(page, 'source', text.indexOf('alpha') + 1)
  await page.locator('.rich-pane .mirror-cursor').waitFor()
  await page
    .locator('.source-pane .cm-content')
    .dispatchEvent('compositionstart', { data: '' })
  await frames(page)
  assert.equal(
    await page.locator('.mirror-cursor').count(),
    0,
    'composition hides the mirror',
  )
  await page
    .locator('.source-pane .cm-content')
    .dispatchEvent('compositionend', { data: '' })
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await frames(page)
  assert.equal(await page.locator('.mirror-cursor').count(), 0)
  await source(page, text)
})

test('formatted split links native wheel scrolling in both directions without feedback or source changes', {
  timeout: 90000,
}, async (t) => {
  const text = Array.from(
    { length: 90 },
    (_, i) =>
      `## section ${i}\n\n${'words that wrap differently in each pane. '.repeat(12)}`,
  ).join('\n\n')
  const { page } = await open(t, text)
  await select(page, 'source', 0)
  for (const pane of ['source', 'rich']) {
    const other = pane === 'source' ? 'rich' : 'source'
    const leader = page.locator(
      pane === 'rich' ? '.rich-pane' : '.source-pane .cm-scroller',
    )
    const box = await leader.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 800)
    await waitForAsync(
      page,
      ({ pane, other }) => {
        const section = document.querySelector(`.${pane}-pane`)
        const container =
          pane === 'rich' ? section : section.querySelector('.cm-scroller')
        const content = section.querySelector('.cm-content')
        const view = content.cmTile.root.view
        const bounds = container.getBoundingClientRect()
        const at = view.posAtCoords({
          x: content.getBoundingClientRect().left + 8,
          y: bounds.top + bounds.height / 2,
        })
        if (at === null) return false
        const point = view.coordsAtPos(at)
        const target = document
          .querySelector(`.${other}-pane .cm-content`)
          .cmTile.root.view.coordsAtPos(at)
        return (
          target &&
          point &&
          Math.abs(
            (point.top + point.bottom - target.top - target.bottom) / 2,
          ) < 3
        )
      },
      { pane, other },
    )
  }
  const samples = await page.evaluate(async () => {
    const samples = []
    for (let i = 0; i < 10; i++) {
      await new Promise(requestAnimationFrame)
      samples.push([
        document.querySelector('.rich-pane').scrollTop,
        document.querySelector('.source-pane .cm-scroller').scrollTop,
      ])
    }
    return samples
  })
  for (const index of [0, 1]) {
    const positions = samples.map((sample) => sample[index])
    assert.ok(
      Math.max(...positions) - Math.min(...positions) < 2,
      'scroll feedback settles',
    )
  }
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await frames(page)
  const stopped = await page.evaluate(async () => {
    const source = document.querySelector('.source-pane .cm-scroller')
    const before = source?.scrollTop
    document.querySelector('.rich-pane').scrollTop += 800
    for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame)
    return { before, after: source?.scrollTop }
  })
  assert.equal(
    stopped.before,
    stopped.after,
    'leaving split stops linked scrolling',
  )
  await source(page, text)
})

test('large formatted split follows distant carets without whole-text geometry reads and preserves undo', {
  timeout: 120000,
}, async (t) => {
  const unit = `${'ordinary words for a long note. '.repeat(8)}\n\n`
  const size = 2 * 1024 * 1024
  const text = unit.repeat(Math.ceil(size / unit.length)).slice(0, size)
  const { app, page, file } = await open(t, text)
  await page.evaluate(() => {
    window.splitWholeTextReads = 0
    const docs = new Set(
      ['rich', 'source'].map(
        (pane) =>
          document.querySelector(`.${pane}-pane .cm-content`).cmTile.root.view
            .state.doc,
      ),
    )
    const restore = []
    for (const doc of docs) {
      const read = doc.toString
      const slice = doc.sliceString
      doc.toString = function () {
        window.splitWholeTextReads++
        return read.call(this)
      }
      doc.sliceString = function (from, to = this.length, lineSep) {
        if (from === 0 && to === this.length) window.splitWholeTextReads++
        return slice.call(this, from, to, lineSep)
      }
      restore.push(() => {
        doc.toString = read
        doc.sliceString = slice
      })
    }
    window.restoreSplitTextReads = () =>
      restore.forEach((read) => {
        read()
      })
  })
  await select(page, 'source', 0)
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  await mirrored(page, 'source')
  await select(page, 'rich', text.length - 20)
  await mirrored(page, 'rich')
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  await mirrored(page, 'rich')
  const reads = await page.evaluate(() => {
    window.restoreSplitTextReads()
    return window.splitWholeTextReads
  })
  assert.equal(
    reads,
    0,
    'caret and scroll geometry never materialize a whole CodeMirror document',
  )
  await page.keyboard.insertText('x')
  await waitForAsync(
    page,
    (length) =>
      ['rich', 'source'].every(
        (pane) =>
          document.querySelector(`.${pane}-pane .cm-content`).cmTile.root.view
            .state.doc.length === length,
      ),
    text.length + 1,
  )
  await select(page, 'source', text.length + 1)
  await pressShortcut(app, `${mod}+z`)
  await source(page, text)
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.ok(
    (await readFile(file)).equals(Buffer.from(text)),
    'undo and save preserve the complete source',
  )
  console.log(
    JSON.stringify({ units: text.length, geometryWholeTextReads: reads }),
  )
})
