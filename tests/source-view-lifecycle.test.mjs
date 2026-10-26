import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

test('source view applies saved gutters and active find after asynchronous construction', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-source-lifecycle-'))
  const file = join(profile, 'note.md')
  await writeFile(file, 'alpha\nbeta\nalpha\n')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await waitForDocumentEditor(app, page)
  await page.evaluate(() => localStorage.setItem('line-numbers', 'true'))
  await page.reload()
  await waitForDocumentEditor(app, page)
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+f' : 'Control+f',
  )
  await page
    .getByRole('textbox', { name: 'Find in document', exact: true })
    .fill('alpha')
  await page.waitForFunction(
    () => document.querySelector('.find-count')?.textContent === '1/2',
  )
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await page.locator('.cm-lineNumbers').waitFor()
  await page.waitForFunction(
    () => document.querySelectorAll('.cm-searchMatch').length === 2,
  )
  assert.equal(await page.locator('.find-count').textContent(), '1/2')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'alpha\nbeta\nalpha\n',
  )
})
