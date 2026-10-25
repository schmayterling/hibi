import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut, replaceSourceText } from './keyboard.mjs'

test('code highlighting controls update both panes, persist, and discover addon languages', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-code-syntax-'))
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
  page.setDefaultTimeout(6500)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await pressShortcut(app, `${mod}+Shift+]`)
  const original = '```js\nconst answer = 42\n```'
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(
    page,
    page.getByRole('textbox', { name: /markdown editor/i }),
    original,
  )
  await page
    .locator('.source-pane .hibi-token-keyword')
    .filter({ hasText: /const/i })
    .waitFor()
  await clickMenu(app, 'Settings')
  await page
    .getByRole('tab', { name: /^code highlight$/i, exact: true })
    .click()
  await page
    .getByRole('checkbox', { name: /^javascript$/i, exact: true })
    .click()
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('.source-pane .hibi-token-keyword')].some(
        (element) => element.textContent === 'const',
      ) && !document.querySelector('.tiptap pre .hibi-token-keyword'),
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    original,
  )
  await page.reload()
  await clickMenu(app, 'Settings')
  await page
    .getByRole('tab', { name: /^code highlight$/i, exact: true })
    .click()
  assert.equal(
    await page
      .getByRole('checkbox', { name: /^javascript$/i, exact: true })
      .isChecked(),
    false,
  )
  await page
    .getByRole('checkbox', { name: /^javascript$/i, exact: true })
    .click()
  await page
    .locator('.tiptap pre .hibi-token-keyword')
    .waitFor({ state: 'attached' })
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.locator('#addon-typst').click()
  await page
    .getByRole('tab', { name: /^code highlight$/i, exact: true })
    .click()
  await page.getByRole('checkbox', { name: /^typst$/i, exact: true }).waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    original,
  )
})

test('long rich code blocks highlight near the viewport through scrolling and typing', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-code-viewport-'))
  const file = join(profile, 'long-code.md')
  const line = 'function sample(value) {\n  return value * 42 + "text";\n}\n'
  await writeFile(file, `# Long code\n\n\`\`\`js\n${line.repeat(4000)}\`\`\`\n`)
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
  page.setDefaultTimeout(10000)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await clickMenu(app, 'Open…')
  await page.locator('.tiptap h1', { hasText: 'Long code' }).waitFor()
  const tokens = page.locator('.tiptap pre [class^="hibi-token-"]')
  await tokens.first().waitFor({ state: 'attached' })
  // The block has about 40,000 tokens; only text near the viewport is decorated.
  assert.ok((await tokens.count()) < 4000)
  await page
    .locator('.tiptap pre')
    .evaluate((pre) => pre.scrollIntoView({ block: 'end' }))
  await page.waitForFunction(() => {
    const pre = document.querySelector('.tiptap pre')
    const last = [...pre.querySelectorAll('[class^="hibi-token-"]')].at(-1)
    return (
      last &&
      pre.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom <
        100
    )
  })
  assert.ok((await tokens.count()) < 4000)
  await tokens.last().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('const typed = 1')
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.tiptap pre .hibi-token-keyword')].some(
      (token) =>
        token.textContent === 'const' &&
        token.nextSibling?.textContent === ' ' &&
        token.nextSibling.nextSibling?.textContent === 'typed',
    ),
  )
  // Long lines scroll inside the block; highlighting follows both axes.
  const wide = join(profile, 'wide-code.md')
  const row = `${'const horizontal = 42; '.repeat(50)}\n`
  await writeFile(wide, `# Wide code\n\n\`\`\`js\n${row.repeat(80)}\`\`\`\n`)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, wide)
  await clickMenu(app, 'Open…')
  const block = page.locator('.tiptap:has(h1:text-is("Wide code")) pre')
  await block.waitFor()
  await block.evaluate((pre) => {
    pre.scrollLeft = pre.scrollWidth
    pre.scrollIntoView({ block: 'end' })
  })
  await block.evaluate(
    (pre) =>
      new Promise((resolve, reject) => {
        const started = performance.now()
        const check = () => {
          const box = pre.getBoundingClientRect()
          const pane = pre.closest('.rich-pane').getBoundingClientRect()
          const shown = [
            ...pre.querySelectorAll('[class^="hibi-token-"]'),
          ].some((token) => {
            const rect = token.getBoundingClientRect()
            return (
              rect.right > box.left &&
              rect.left < box.right &&
              rect.bottom > pane.top &&
              rect.top < pane.bottom
            )
          })
          if (shown) resolve()
          else if (performance.now() - started > 8000)
            reject(new Error('no highlighted code is visible'))
          else requestAnimationFrame(check)
        }
        check()
      }),
  )
})
