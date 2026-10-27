import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('formatted multiline native input replaces one selection in one edit and preserves surrounding source', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-formatted-input-'))
  const file = join(profile, 'note.md')
  const original = '# heading\n\nbefore MIDDLE after 😀\n\n- keep me\n'
  const expected =
    '# heading\n\nbefore one\n\ntwo\nthree after 😀\n\n- keep me\n'
  await writeFile(file, original)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const rich = await selectFormattedEngine(app, page, 'codemirror')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await rich.locator('.cm-line', { hasText: 'before MIDDLE after' }).click()
  await page.keyboard.press('Home')
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight')
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight')
  assert.equal(await page.evaluate(() => getSelection().toString()), 'MIDDLE')
  const before = await page.evaluate(() => window.hibi.getDocument())
  await rich.evaluate((element) => {
    window.formattedInput = { prevented: [], inputs: [] }
    document.addEventListener('beforeinput', (event) =>
      window.formattedInput.prevented.push(event.defaultPrevented),
    )
    element.addEventListener('input', (event) =>
      window.formattedInput.inputs.push(event.inputType),
    )
  })
  await page.keyboard.insertText('one\r\n\ntwo\rthree')
  const saved = (text) =>
    waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
  await saved(expected)
  assert.deepEqual(await page.evaluate(() => window.formattedInput), {
    prevented: [true],
    inputs: ['insertText'],
  })
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).contentVersion,
    before.contentVersion + 1,
  )
  await pressShortcut(app, `${mod}+z`)
  await saved(original)
  await pressShortcut(
    app,
    process.platform === 'win32' ? 'Control+y' : `${mod}+Shift+z`,
  )
  await saved(expected)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  assert.equal(
    (await source.locator('.cm-line').allTextContents()).join('\n'),
    expected,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.saveDocument(false))).saveReceipt,
    true,
  )
  assert.equal(await readFile(file, 'utf8'), expected)
  await cdp.detach()
})
