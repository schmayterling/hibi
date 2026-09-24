import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

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
  const profile = await mkdtemp(join(tmpdir(), 'hibi-cursor-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  await page.getByRole('button', { name: /dismiss this screen/i }).click()
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
    const baseline = document
      .querySelector('.tiptap p br')
      .getBoundingClientRect()
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
  await rich.fill('cursor movement sample')
  const cursor = page.locator('.editor-cursor')
  await cursor.waitFor()
  assert.equal(await cursor.getAttribute('data-style'), 'bar')
  await assertCursorAnimationUnqueried(page, rich, 'cursor-blink')
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
  await page
    .getByLabel(/^cursor style$/i, { exact: true })
    .selectOption('outline')
  await page.getByLabel(/^cursor blink$/i, { exact: true }).selectOption('fast')
  await page
    .getByLabel(/^cursor animation$/i, { exact: true })
    .selectOption('smooth')
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await cursor.waitFor()
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
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
  await assertCursorAnimationUnqueried(page, rich, 'cursor-smooth')
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
  // Split preview is read-only; its editable source pane owns the typing caret.
  assert.equal(await rich.getAttribute('contenteditable'), 'false')
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
    await page.getByRole('button', { name: /^back to app$/i }).click()
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
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.fill('')
  await source.focus()
  await page.waitForFunction(() =>
    document.querySelector('.source-pane .editor-cursor'),
  )
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
  await source.fill('source cursor sample')
  await cursor.waitFor()
  assert.equal(
    await source.evaluate((element) => getComputedStyle(element).caretColor),
    'rgba(0, 0, 0, 0)',
  )
  await source.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await cursor.waitFor({ state: 'hidden' })
  await source.press('ArrowRight')
  await cursor.waitFor()
  await assertCursorAnimationUnqueried(page, source, 'cursor-blink')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(
    await cursor.evaluate(
      (element) => getComputedStyle(element, '::after').animationName,
    ),
    'none',
  )
  await assertCursorAnimationUnqueried(page, source, 'none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await assertCursorAnimationUnqueried(page, source, 'cursor-blink')
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].reload(),
    ),
  ])
  await rich.waitFor()
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
})
