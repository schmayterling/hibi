import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

test('editor width slider changes both panes, persists, and cleans up when disabled', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-editor-width-'))
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'editor-width': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6500)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const slider = page.getByRole('slider', { name: 'Editor width', exact: true })
  await slider.waitFor()
  assert.equal(await slider.inputValue(), '800')
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  const before = await page.evaluate(() => window.hibi.getDocument())
  await slider.press('Home')
  assert.equal(await slider.inputValue(), '320')
  await slider.press('ArrowRight')
  assert.equal(await slider.inputValue(), '330')
  assert.equal(await slider.getAttribute('aria-valuetext'), '330 pixels')
  await slider.press('End')
  // Pointer input applies continuously before the drag is released.
  const track = await slider.boundingBox()
  await page.mouse.move(track.x + track.width - 7, track.y + track.height / 2)
  await page.mouse.down()
  await page.mouse.move(track.x + track.width / 2, track.y + track.height / 2)
  assert.ok(Number(await slider.inputValue()) < 1600)
  await page.mouse.up()
  // Keep the chosen width smaller than both panes to check fixed sizing.
  await slider.press('Home')
  for (let step = 0; step < 8; step++) await slider.press('ArrowRight')
  const saved = await slider.inputValue()
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${mod}+Shift+\\`)
  await page.getByRole('textbox', { name: /markdown editor/i }).waitFor()
  await page.waitForFunction((width) => {
    const panes = [...document.querySelectorAll('.rich-pane, .source-pane')]
    return (
      panes.length === 2 &&
      panes.every((pane) => {
        const editor = pane.querySelector('.rich-editor-host, .source-editor')
        if (!editor) return false
        const bounds = editor.getBoundingClientRect()
        const parent = pane.getBoundingClientRect()
        const expected = Math.min(parent.width, width)
        return (
          Math.abs(bounds.width - expected) < 2 &&
          Math.abs(
            bounds.left - parent.left - (parent.width - bounds.width) / 2,
          ) < 2
        )
      })
    )
  }, Number(saved))
  assert.deepEqual(await page.evaluate(() => window.hibi.getDocument()), before)
  await page.reload()
  await slider.waitFor()
  assert.equal(await slider.inputValue(), saved)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i }).click()
  await page.locator('#addon-editor-width').click()
  await page.waitForFunction(
    () => !document.querySelector('#addon-editor-width').checked,
  )
  await page.getByRole('button', { name: /back to app/i }).click()
  await slider.waitFor({ state: 'detached' })
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.rich-editor-host, .source-editor')].every(
      (editor) =>
        Math.abs(
          editor.getBoundingClientRect().width -
            editor.parentElement.getBoundingClientRect().width,
        ) < 2,
    ),
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i }).click()
  await page.locator('#addon-editor-width').click()
  await page.waitForFunction(
    () => document.querySelector('#addon-editor-width').checked,
  )
  await page.getByRole('button', { name: /back to app/i }).click()
  await slider.waitFor()
  assert.equal(await slider.inputValue(), saved)
  assert.deepEqual(errors, [])
})
