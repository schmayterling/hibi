import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  electron,
  startupDiagnostics,
  waitForDocumentEditor,
} from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import {
  clickMenu,
  pressShortcut,
  replaceRichText,
  replaceSourceText,
} from './keyboard.mjs'

async function cursorDiagnostics(app, page, phase) {
  console.error('cursor phase:', phase)
  if (!app || !page) return
  let timer
  try {
    await Promise.race([
      Promise.allSettled([
        startupDiagnostics(app, page).then((state) =>
          console.error('cursor startup:', JSON.stringify(state)),
        ),
        page
          .evaluate(() => ({
            active: document.activeElement?.className,
            nativeFocus: Document.prototype.hasFocus.call(document),
            selection: document.getSelection()?.type,
            sourceLength:
              document.querySelector('.cm-content')?.textContent.length,
          }))
          .then((state) =>
            console.error('cursor focus:', JSON.stringify(state)),
          ),
      ]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 1200)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function assertCursorAnimationUnqueried(page, editor, name) {
  await page.evaluate(() => {
    const getAnimations = Element.prototype.getAnimations
    let queries = 0
    Element.prototype.getAnimations = function (...args) {
      if (this.classList.contains('editor-cursor')) queries++
      return getAnimations.apply(this, args)
    }
    window.cursorAnimationQueries = () => {
      Element.prototype.getAnimations = getAnimations
      delete window.cursorAnimationQueries
      return queries
    }
  })
  for (const key of ['s', 'Backspace', 'ArrowLeft']) {
    await editor.press(key)
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
  }
  assert.equal(
    await page.evaluate(() => window.cursorAnimationQueries()),
    0,
    'caret movement must not query animations',
  )
  assert.equal(
    await page
      .locator('.editor-cursor')
      .evaluate(
        (element) => getComputedStyle(element, '::after').animationName,
      ),
    name,
  )
}

test('cursor appearance, movement, selection hiding, and persistence in both editors', {
  timeout: 30000,
}, async (t) => {
  let phase = 'launch',
    app,
    page,
    diagnostic
  let complete = false
  const onAbort = () => {
    if (!complete) diagnostic ??= cursorDiagnostics(app, page, phase)
  }
  t.signal.addEventListener('abort', onAbort, { once: true })
  const profile = await mkdtemp(join(tmpdir(), 'hibi-cursor-'))
  app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    onAbort()
    t.signal.removeEventListener('abort', onAbort)
    await diagnostic
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  phase = 'first window'
  page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  phase = 'initial editor'
  await rich.waitFor()
  phase = 'dismiss start screen'
  await page.getByRole('button', { name: /dismiss this screen/i }).click()
  await selectFormattedEngine(app, page, t.formattedEngine)
  phase = 'initial caret'
  // Exercise caret rendering without taking focus from the user's active window.
  await page.evaluate(() => {
    document.hasFocus = () => true
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.locator('.editor-cursor').waitFor()
  const emptyGeometry = await page.evaluate(() => {
    const caret = document
      .querySelector('.editor-cursor')
      .getBoundingClientRect()
    const formatted = document.querySelector('.hibi-formatted .cm-content')
    const point = formatted?.cmTile.root.view.coordsAtPos(0)
    const baseline = point
      ? { x: point.left, y: point.top, height: point.bottom - point.top }
      : document.querySelector('.tiptap p br').getBoundingClientRect()
    return {
      x: caret.x - baseline.x,
      y: caret.y - baseline.y,
      height: caret.height - baseline.height,
    }
  })
  assert.ok(
    Object.values(emptyGeometry).every(
      (difference) => Math.abs(difference) < 1,
    ),
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '',
  )
  phase = 'rich fill'
  await waitForDocumentEditor(app, page)
  await replaceRichText(page, rich, 'cursor movement sample')
  const cursor = page.locator('.editor-cursor')
  await cursor.waitFor()
  assert.equal(await cursor.getAttribute('data-style'), 'bar')
  phase = 'rich animation'
  await assertCursorAnimationUnqueried(page, rich, 'cursor-blink')
  phase = 'settings controls'
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
  await page
    .getByLabel(/^cursor style$/i, { exact: true })
    .selectOption('outline')
  await page.getByLabel(/^cursor blink$/i, { exact: true }).selectOption('fast')
  await page
    .getByLabel(/^cursor animation$/i, { exact: true })
    .selectOption('smooth')
  phase = 'smooth settings restore'
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page
    .getByRole('main', { name: /^settings$/i })
    .waitFor({ state: 'hidden' })
  await page.locator('.editor-surface:not([inert])').waitFor()
  if (t.formattedEngine === 'codemirror') {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
    assert.equal(
      await rich.evaluate((element) => document.activeElement === element),
      true,
      'closing appearance settings restores the formatted editor focus and caret',
    )
  }
  await cursor.waitFor()
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  phase = 'smooth movement'
  const before = (await cursor.boundingBox()).x
  await page.evaluate(() => {
    const caret = document.querySelector('.editor-cursor')
    window.cursorMotion = null
    caret.addEventListener(
      'transitionrun',
      (event) => {
        if (event.propertyName !== 'transform') return
        const transition = caret
          .getAnimations()
          .find((animation) => animation.transitionProperty === 'transform')
        if (!transition) return
        transition.pause()
        transition.currentTime =
          Number(transition.effect.getTiming().duration) / 2
        const middle = caret.getBoundingClientRect().x
        transition.finish()
        window.cursorMotion = {
          middle,
          after: caret.getBoundingClientRect().x,
        }
      },
      { once: true },
    )
  })
  await rich.press('ArrowLeft')
  await page.waitForFunction(() => window.cursorMotion, null, {
    polling: 100,
    timeout: 2000,
  })
  const motion = await page.evaluate(() => {
    const style = getComputedStyle(
      document.querySelector('.editor-cursor'),
      '::after',
    )
    return {
      ...window.cursorMotion,
      duration: style.animationDuration,
      name: style.animationName,
      border: style.borderTopWidth,
    }
  })
  assert.ok(motion.middle < before && motion.middle > motion.after)
  assert.equal(motion.duration, '0.6s')
  assert.equal(motion.name, 'cursor-smooth')
  assert.notEqual(motion.border, '0px')
  phase = 'smooth animation'
  await assertCursorAnimationUnqueried(page, rich, 'cursor-smooth')
  phase = 'split view'
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+Shift+\\' : 'Control+Shift+\\',
  )
  await page.waitForFunction(
    () =>
      document
        .querySelector('.editor-panes')
        .classList.contains('mode-side-by-side') &&
      document.querySelector('.rich-pane').getAnimations().length === 0,
  )
  await t.test(
    'split formatted view is read-only',
    {
      todo:
        t.formattedEngine === 'codemirror'
          ? 'formatted gap split-001: split formatted view must remain read-only'
          : undefined,
    },
    async () => {
      assert.equal(await rich.getAttribute('contenteditable'), 'false')
    },
  )
  phase = 'split source caret'
  await page.getByRole('textbox', { name: /markdown editor/i }).focus()
  await page.locator('.source-pane .editor-cursor').waitFor()
  assert.ok(
    await page.evaluate(
      () =>
        Math.abs(
          document.getSelection().getRangeAt(0).getBoundingClientRect().left -
            document.querySelector('.editor-cursor').getBoundingClientRect()
              .left,
        ) < 1,
    ),
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  for (const [shape, speed] of [
    ['block', 'slow'],
    ['underline', 'normal'],
  ]) {
    phase = `${shape} settings`
    await clickMenu(app, 'Settings')
    await page
      .getByLabel(/^cursor style$/i, { exact: true })
      .selectOption(shape)
    await page
      .getByLabel(/^cursor blink$/i, { exact: true })
      .selectOption(speed)
    await page
      .getByLabel(/^cursor animation$/i, { exact: true })
      .selectOption('blink')
    phase = `${shape} caret restore`
    await page.getByRole('button', { name: /^back to app$/i }).click()
    await page
      .getByRole('main', { name: /^settings$/i })
      .waitFor({ state: 'hidden' })
    await page.locator('.editor-surface:not([inert])').waitFor()
    await cursor.waitFor()
    assert.equal(await cursor.getAttribute('data-style'), shape)
    assert.equal(
      await cursor.evaluate(
        (element) => getComputedStyle(element, '::after').animationDuration,
      ),
      speed === 'slow' ? '1.6s' : '1s',
    )
    assert.equal(await cursor.getAttribute('data-move'), 'false')
  }
  phase = 'source view'
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  phase = 'source clear'
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(page, source, '')
  await source.focus()
  await page.waitForFunction(() =>
    document.querySelector('.source-pane .editor-cursor'),
  )
  phase = 'source placeholder'
  await page.locator('.source-pane .cm-placeholder').waitFor()
  const sourceGeometry = await page.evaluate(() => {
    const caret = document
      .querySelector('.source-pane .editor-cursor')
      .getBoundingClientRect()
    const placeholder = document.querySelector('.cm-placeholder')
    const range = document.createRange()
    range.selectNodeContents(placeholder)
    const text = range.getBoundingClientRect()
    return {
      x: caret.x - text.x,
      y: caret.y - text.y,
      height: caret.height - text.height,
    }
  })
  assert.ok(
    Object.values(sourceGeometry).every(
      (difference) => Math.abs(difference) < 2,
    ),
    JSON.stringify(sourceGeometry),
  )
  phase = 'source fill'
  await replaceSourceText(page, source, 'source cursor sample')
  await cursor.waitFor()
  assert.equal(
    await source.evaluate((element) => getComputedStyle(element).caretColor),
    'rgba(0, 0, 0, 0)',
  )
  phase = 'source selection'
  await source.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await cursor.waitFor({ state: 'hidden' })
  await source.press('ArrowRight')
  await cursor.waitFor()
  phase = 'source animation'
  await assertCursorAnimationUnqueried(page, source, 'cursor-blink')
  phase = 'reduced motion'
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(
    await cursor.evaluate(
      (element) => getComputedStyle(element, '::after').animationName,
    ),
    'none',
  )
  await assertCursorAnimationUnqueried(page, source, 'none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  phase = 'source animation'
  await assertCursorAnimationUnqueried(page, source, 'cursor-blink')
  phase = 'reload'
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].reload(),
    ),
  ])
  await rich.waitFor()
  phase = 'settings controls'
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
  assert.equal(
    await page.getByLabel(/^cursor style$/i, { exact: true }).inputValue(),
    'underline',
  )
  assert.equal(
    await page.getByLabel(/^cursor blink$/i, { exact: true }).inputValue(),
    'normal',
  )
  assert.equal(
    await page.getByLabel(/^cursor animation$/i, { exact: true }).inputValue(),
    'blink',
  )
  complete = true
})
