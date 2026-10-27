import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { Schema } from '@tiptap/pm/model'
import { markdownPositions } from '../src/renderer/src/markdown-positions.ts'
import { electron } from './electron.mjs'
import {
  testFormattedEngines as it,
  selectFormattedEngine,
} from './formatted-engine.mjs'
import { replaceRichText } from './keyboard.mjs'

test('caret mapping skips formatting and link destinations, including repeated words', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'paragraph+' },
      paragraph: { content: 'text*' },
      text: {},
    },
  })
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('same same next')]),
  ])
  const source = '**same** [same](https://same.test) next'
  const map = markdownPositions(source, doc)
  assert.equal(map(1, 'rich'), 2)
  assert.equal(map(6, 'rich'), 10)
  assert.equal(map(source.indexOf('next'), 'source'), 11)
})

it('split view mirrors the caret without moving focus or selecting the other pane', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-mirror-'))
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
  page.setDefaultTimeout(6000)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await selectFormattedEngine(app, page, t.formattedEngine)
  await replaceRichText(page, rich, 'mirror this text')
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.waitFor()
  await page.evaluate(() => {
    document.hasFocus = () => true
  })
  await rich.focus()
  await rich.press('ArrowLeft')
  await page.locator('.source-pane .mirror-cursor').waitFor()
  assert.equal(
    await rich.evaluate((element) => element === document.activeElement),
    true,
  )
  await source.focus()
  await source.press('ArrowRight')
  await source.pressSequentially('!')
  await page.locator('.rich-pane .mirror-cursor').waitFor()
  assert.equal(
    await source.evaluate((element) => element === document.activeElement),
    true,
  )
  await source.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await page.locator('.mirror-cursor').waitFor({ state: 'hidden' })
  await source.press('ArrowRight')
  await page.locator('.mirror-cursor').waitFor()
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await page.locator('.mirror-cursor').waitFor({ state: 'hidden' })
})
