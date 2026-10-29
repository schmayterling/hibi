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

test('preview scrolling can be unlinked, saved, and linked again', {
  timeout: 90000,
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
  page.setDefaultTimeout(6000)
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

  // Caret changes must also leave the preview at its chosen reading position.
  const readingPosition = fromPreview.after.rich
  await source.press(
    process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home',
  )
  await source.press('ArrowDown')
  const afterCaret = await scroll('.source-pane .cm-scroller', 0.35)
  assert.ok(Math.abs(afterCaret.after.rich - readingPosition) < 2)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    markdown,
  )

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
