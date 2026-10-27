import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { pressShortcut, replaceRichText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('native composition replaces selected text in one undo step and cancels at the caret', {
  timeout: 45000,
}, async (t) => {
  const engine = t.formattedEngine
  const profile = await mkdtemp(join(tmpdir(), 'hibi-engine-composition-'))
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
  const rich = await selectFormattedEngine(app, page, engine)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const saved = (text) =>
    waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
  await replaceRichText(page, rich, 'before chosen after 😀')
  await saved('before chosen after 😀')
  await rich.press('Home')
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight')
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight')
  assert.equal(await page.evaluate(() => getSelection().toString()), 'chosen')
  for (const text of ['日', '日本']) {
    await cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    })
    await waitForAsync(
      page,
      (text) =>
        document.querySelector('[aria-label="Document editor"]').textContent ===
        `before ${text} after 😀`,
      text,
    )
  }
  await cdp.send('Input.insertText', { text: '日本語' })
  await saved('before 日本語 after 😀')
  await pressShortcut(app, `${mod}+z`)
  await saved('before chosen after 😀')
  await pressShortcut(
    app,
    process.platform === 'win32' ? 'Control+y' : `${mod}+Shift+z`,
  )
  await saved('before 日本語 after 😀')
  await rich.press('End')
  await cdp.send('Input.imeSetComposition', {
    text: '仮',
    selectionStart: 1,
    selectionEnd: 1,
  })
  await waitForAsync(
    page,
    () =>
      document.querySelector('[aria-label="Document editor"]').textContent ===
      'before 日本語 after 😀仮',
  )
  await cdp.send('Input.imeSetComposition', {
    text: '',
    selectionStart: 0,
    selectionEnd: 0,
  })
  await saved('before 日本語 after 😀')
  assert.equal(await rich.innerText(), 'before 日本語 after 😀')
  await page.keyboard.type('!')
  await saved('before 日本語 after 😀!')
  await pressShortcut(app, `${mod}+z`)
  await saved('before 日本語 after 😀')
  await cdp.detach()
})
