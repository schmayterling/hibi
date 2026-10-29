import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu, replaceSourceText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('preview scrolling can be unlinked while typing and clicks keep panes aligned', {
  timeout: 120000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-preview-scroll-'))
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
  await selectFormattedEngine(app, page, t.formattedEngine)
  page.setDefaultTimeout(10000)
  await page.evaluate(() => {
    document.hasFocus = () => true
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: /^side-by-side$/i }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const source = page.getByRole('textbox', { name: /^markdown editor$/i })
  const markdown = Array.from(
    { length: 90 },
    (_, index) => `## Section ${index}\n\n${'Words that wrap. '.repeat(40)}`,
  ).join('\n\n')
  await replaceSourceText(page, source, markdown)
  await page.waitForFunction(() => {
    const rich = document.querySelector('.rich-pane')
    return rich.scrollHeight > rich.clientHeight * 5
  })
  const toggle = page.getByRole('checkbox', {
    name: /^sync preview scrolling$/i,
  })
  const settings = async () => {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: /^editor$/i }).click()
    await toggle.waitFor()
  }
  const back = async () => {
    await page.getByRole('button', { name: /^back to app$/i }).click()
    await page
      .getByRole('main', { name: /^settings$/i })
      .waitFor({ state: 'hidden' })
  }
  await settings()
  assert.equal(await toggle.isChecked(), true)
  await toggle.uncheck()
  await back()

  const scroll = async (selector, fraction) =>
    page.evaluate(
      async ({ selector, fraction }) => {
        const source = document.querySelector('.source-pane .cm-scroller')
        const rich = document.querySelector('.rich-pane')
        const pane = document.querySelector(selector)
        const before = { source: source.scrollTop, rich: rich.scrollTop }
        pane.dispatchEvent(
          new WheelEvent('wheel', { deltaY: 100, bubbles: true }),
        )
        pane.scrollTop = (pane.scrollHeight - pane.clientHeight) * fraction
        for (let frame = 0; frame < 4; frame++)
          await new Promise(requestAnimationFrame)
        return {
          before,
          after: { source: source.scrollTop, rich: rich.scrollTop },
        }
      },
      { selector, fraction },
    )

  const fromSource = await scroll('.source-pane .cm-scroller', 0.25)
  assert.ok(Math.abs(fromSource.after.source - fromSource.before.source) > 100)
  assert.ok(Math.abs(fromSource.after.rich - fromSource.before.rich) < 2)
  const fromPreview = await scroll('.rich-pane', 0.6)
  assert.ok(Math.abs(fromPreview.after.rich - fromPreview.before.rich) > 100)
  assert.ok(Math.abs(fromPreview.after.source - fromPreview.before.source) < 2)

  // Only scrolling is unlinked. Moving the caret still aligns the preview.
  await source.press(
    process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home',
  )
  await page.waitForFunction(
    (before) => document.querySelector('.rich-pane').scrollTop < before / 2,
    fromPreview.after.rich,
  )
  await source.press('ArrowDown')

  const clickPane = async (selector) => {
    const bounds = await page.locator(selector).boundingBox()
    await page.mouse.click(bounds.x + 150, bounds.y + bounds.height / 2)
  }
  const aligned = async (caret, mirror) =>
    page.waitForFunction(
      ([caret, mirror]) => {
        const first = document.querySelector(caret)?.getBoundingClientRect()
        const second = document.querySelector(mirror)?.getBoundingClientRect()
        return (
          first?.height &&
          second?.height &&
          Math.abs(
            first.top + first.height / 2 - second.top - second.height / 2,
          ) < 3
        )
      },
      [caret, mirror],
    )

  await scroll('.source-pane .cm-scroller', 0.35)
  await clickPane('.source-pane .cm-scroller')
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    markdown,
  )

  await scroll('.rich-pane', 0.8)
  await source.focus()
  await page.keyboard.insertText('Z\nZ')
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
  await page.evaluate(() => window.hibi.flushDocumentChanges())
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown.replace(
      'Z\nZ',
      '',
    ),
    markdown,
  )
  await source.press('ControlOrMeta+z')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    markdown,
  )
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')

  // Clicking the independently scrolled preview also reveals its line in source.
  await scroll('.rich-pane', 0.6)
  const sourceBeforeClick = await page
    .locator('.source-pane .cm-scroller')
    .evaluate((pane) => pane.scrollTop)
  if (t.formattedEngine === 'tiptap')
    await page.locator('.rich-pane .tiptap h2').nth(55).click()
  else await clickPane('.rich-pane')
  await page.waitForFunction(
    (before) =>
      Math.abs(
        document.querySelector('.source-pane .cm-scroller').scrollTop - before,
      ) > 100,
    sourceBeforeClick,
  )
  await page.waitForFunction(() => {
    const mirror = document
      .querySelector('.source-pane .mirror-cursor')
      ?.getBoundingClientRect()
    const editor = document.querySelector('.rich-pane .tiptap')?.editor
    const view = document.querySelector('.rich-pane .cm-content')?.cmTile.root
      .view
    const caret = editor
      ? editor.view.coordsAtPos(editor.state.selection.head)
      : view?.coordsAtPos(view.state.selection.main.head)
    return (
      caret &&
      mirror?.height &&
      Math.abs(
        (caret.top + caret.bottom) / 2 - mirror.top - mirror.height / 2,
      ) < 3
    )
  })

  await settings()
  await toggle.check()
  await back()
  await scroll('.source-pane .cm-scroller', 0.5)
  await page.waitForFunction(() => {
    const rich = document.querySelector('.rich-pane')
    return (
      Math.abs(rich.scrollTop - (rich.scrollHeight - rich.clientHeight) * 0.6) >
      100
    )
  })
  await settings()
  await toggle.uncheck()
  await back()

  // Reload uses the persisted preference rather than the default.
  await page.reload()
  await waitForDocumentEditor(app, page)
  await settings()
  assert.equal(await toggle.isChecked(), false)
  assert.equal(
    await page.evaluate(() => localStorage.getItem('sync-preview-scroll')),
    'false',
  )
  await toggle.check()
  await back()
  await page.getByRole('button', { name: /^side-by-side$/i }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(page, source, markdown)
  await source.press(
    process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home',
  )
  await page.waitForFunction(
    () => document.querySelector('.rich-pane').scrollTop < 10,
  )
  await scroll('.source-pane .cm-scroller', 0.5)
  await page.waitForFunction(
    () => document.querySelector('.rich-pane').scrollTop > 100,
  )
})
