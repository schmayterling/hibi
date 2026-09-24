import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { analyze } from '../src/addons/review/analyze.ts'
import { textProjection } from '../src/renderer/src/text-projection.ts'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('review checks exact literal spans and bounds its results', () => {
  const projection = textProjection(
    '---\ntitle: teh\n---\n\nTeh very very note.\n\n`teh`\n\n[teh](https://teh.example)',
    true,
  )
  const findings = analyze(projection)
  assert.equal(findings.length, 3)
  assert.equal(findings[0].replacement, 'The')
  assert.equal(findings[1].replacement, '')
  assert.equal(analyze(textProjection('teh '.repeat(1000), false)).length, 100)
})

test('review highlights and fixes both editors, keeps undo, and disposes annotations', {
  timeout: 40000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-review-'))
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ review: true }),
  )
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
  page.setDefaultTimeout(8000)
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .fill('teh very very note')
  await page.locator('.toolbar-slot[data-hidden="false"]').waitFor()
  await page
    .locator('[data-toolbar-id="review.open"]')
    .first()
    .waitFor({ state: 'attached' })
  const review = page.getByRole('button', {
    name: 'Review document',
    exact: true,
  })
  if (await review.isVisible()) await review.click()
  else {
    await page.getByRole('button', { name: 'More formatting actions' }).click()
    await page.getByRole('menuitem', { name: 'Review document' }).click()
  }
  const finding = page.getByRole('button', {
    name: 'Change “teh” to “the”',
    exact: true,
  })
  await finding.click()
  await page.locator('.tiptap .editor-annotation').waitFor()
  assert.equal(
    await page.locator('.tiptap .editor-annotation').textContent(),
    'teh',
  )
  await mkdir('test-results', { recursive: true })
  await page.screenshot({
    path: 'test-results/review-findings.png',
    animations: 'disabled',
  })
  await page.getByRole('button', { name: 'Pin review', exact: true }).click()
  await page
    .getByRole('region', { name: 'Pinned review', exact: true })
    .waitFor()
  await page.screenshot({
    path: 'test-results/review-pinned.png',
    animations: 'disabled',
  })
  await page.getByRole('button', { name: 'Hide panel', exact: true }).click()
  await page
    .getByRole('button', { name: 'Apply: Change “teh” to “the”', exact: true })
    .click()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'the very very note',
  )
  await page.evaluate(() =>
    document.querySelector('.tiptap').editor.commands.undo(),
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'teh very very note',
  )
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.cm-content')?.isContentEditable,
  )
  await finding.click()
  await page.locator('.cm-content .editor-annotation').waitFor()
  await page
    .getByRole('button', { name: 'Apply: Change “teh” to “the”', exact: true })
    .click()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'the very very note',
  )
  await page
    .getByRole('button', { name: 'Apply: Remove repeated “very”', exact: true })
    .click()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'the very note',
  )
  await page.getByText('No suggestions', { exact: true }).waitFor()
  await mkdir('test-results', { recursive: true })
  await page.screenshot({
    path: 'test-results/review.png',
    animations: 'disabled',
  })
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-review').click()
  await page.waitForFunction(
    () => !document.querySelector('#addon-review').checked,
  )
  assert.equal(await page.locator('.editor-annotation').count(), 0)
})
