import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  testFormattedEngines as it,
  selectFormattedEngine,
} from './formatted-engine.mjs'
import { clickMenu, pressShortcut, replaceRichText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

it('empty formatted blocks remain editable and rich editing survives vim and view switches', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-rich-editability-'))
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
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await selectFormattedEngine(app, page, t.formattedEngine)
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.locator('#addon-vim').click()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await waitForDocumentEditor(app, page)
  await replaceRichText(page, rich, '/table')
  await rich.press('Enter')
  await rich.locator('td').first().click()
  await page.keyboard.press('Enter')
  assert.equal(await rich.getAttribute('contenteditable'), 'true')
  await page.keyboard.type('cell')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('<br>cell'),
  )
  await rich.locator('td').last().click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.type('after table')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('after table'),
  )
  await pressShortcut(app, `${mod}+Shift+\\`)
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.waitFor()
  await page.locator('[data-vim-plugin]').waitFor()
  await source.focus()
  await source.press('Escape')
  await source.pressSequentially('Goextra')
  await source.press('Escape')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('extra'),
  )
  // Accepted difference: the codemirror split pane stays editable; the rich editor previews read-only.
  assert.equal(
    await rich.getAttribute('contenteditable'),
    t.formattedEngine === 'codemirror' ? 'true' : 'false',
  )
  await pressShortcut(app, `${mod}+Shift+[`)
  await source.waitFor({ state: 'hidden' })
  await page.waitForFunction(
    (engine) =>
      engine === 'tiptap'
        ? document.querySelector('.tiptap')?.editor?.isEditable
        : document.querySelector('.rich-pane .hibi-formatted .cm-content')
            ?.isContentEditable,
    t.formattedEngine,
  )
  await rich.locator('td').first().click()
  await page.keyboard.type(' rich')
  assert.equal(await rich.getAttribute('contenteditable'), 'true')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('rich'),
  )
  assert.ok(
    (await page.evaluate(() => window.hibi.getDocument())).markdown.includes(
      '<br>',
    ),
  )
  for (const command of ['code', 'quote', 'h1']) {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    const revision = (await page.evaluate(() => window.hibi.getDocument()))
      .revision
    await pressShortcut(app, `${mod}+n`)
    await waitForAsync(
      page,
      async (revision) => (await window.hibi.getDocument()).revision > revision,
      revision,
    )
    await rich.waitFor()
    if (t.formattedEngine === 'tiptap')
      await page.waitForFunction(
        () =>
          document.querySelector('.tiptap')?.textContent === '' &&
          document.querySelector('.tiptap')?.getAttribute('contenteditable') ===
            'true',
      )
    else {
      await waitForAsync(
        page,
        async () => (await window.hibi.getDocument()).markdown === '',
      )
      assert.equal(await rich.getAttribute('contenteditable'), 'true')
    }
    await replaceRichText(page, rich, `/${command}`)
    await page.getByRole('listbox', { name: /slash commands/i }).waitFor()
    await rich.press('Enter')
    await rich
      .locator(
        (t.formattedEngine === 'tiptap'
          ? { code: 'pre', quote: 'blockquote', h1: 'h1' }
          : {
              code: '.hibi-lp-codeblock',
              quote: '.hibi-lp-quote',
              h1: '.hibi-lp-h1',
            })[command],
      )
      .waitFor()
    await rich.press(`${mod}+Enter`)
    await page.keyboard.type('outside')
    assert.equal(await rich.getAttribute('contenteditable'), 'true')
    assert.equal(
      await rich
        .locator(t.formattedEngine === 'tiptap' ? 'p' : '.cm-line')
        .last()
        .innerText(),
      'outside',
    )
  }
})

test('codemirror: enter in an empty table cell inserts a line break', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-native-editability-'))
  const file = join(profile, 'note.md')
  await writeFile(file, '| a | b |\n| --- | --- |\n| | |\n')
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
  page.setDefaultTimeout(6000)
  await selectFormattedEngine(app, page, 'codemirror')
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await rich.locator('td').first().click()
  await page.keyboard.press('Enter')
  assert.equal(await rich.getAttribute('contenteditable'), 'true')
  await page.keyboard.type('cell')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('<br>cell'),
  ).catch(async (error) => {
    t.diagnostic(
      JSON.stringify(
        await page.evaluate(async () => ({
          markdown: (await window.hibi.getDocument()).markdown,
          focused: document.activeElement?.getAttribute('aria-label'),
        })),
      ),
    )
    throw error
  })
})

test('codemirror: canonical empty blocks remain editable across vim and source switches', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-native-editability-'))
  const file = join(profile, 'note.md')
  await writeFile(file, '| a | b |\n| --- | --- |\n| <br> | |\n')
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
  page.setDefaultTimeout(6000)
  await selectFormattedEngine(app, page, 'codemirror')
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.locator('#addon-vim').click()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await waitForDocumentEditor(app, page)

  // Seed canonical blocks independently of the still-unmigrated API 2 slash addon.
  await rich.locator('td').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type('cell')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('<br>cell'),
  )
  await rich.locator('td').last().click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.type('after table')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('after table'),
  )
  await pressShortcut(app, `${mod}+Shift+\\`)
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.waitFor()
  await page.locator('[data-vim-plugin]').waitFor()
  await source.focus()
  await source.press('Escape')
  await source.pressSequentially('Goextra')
  await source.press('Escape')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('extra'),
  )
  assert.equal(await rich.getAttribute('contenteditable'), 'true')
  await pressShortcut(app, `${mod}+Shift+[`)
  await source.waitFor({ state: 'hidden' })
  await rich.locator('td').first().click()
  await page.keyboard.type(' rich')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('rich'),
  )
  assert.ok(
    (await page.evaluate(() => window.hibi.getDocument())).markdown.includes(
      '<br>',
    ),
  )
  for (const [block, selector] of [
    ['```\n\n```', '.hibi-lp-codeblock'],
    ['> ', '.hibi-lp-quote'],
    ['# ', '.hibi-lp-h1'],
  ]) {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    const revision = (await page.evaluate(() => window.hibi.getDocument()))
      .revision
    await pressShortcut(app, `${mod}+n`)
    await waitForAsync(
      page,
      async (revision) => (await window.hibi.getDocument()).revision > revision,
      revision,
    )
    await waitForDocumentEditor(app, page)
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).markdown === '',
    )
    // Typed text is literal in the formatted view, so write the block's source.
    await rich.evaluate((element, block) => {
      const view = element.cmTile.root.view
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: block },
        selection: { anchor: block.length },
      })
      view.focus()
    }, block)
    await waitForAsync(
      page,
      async (block) => (await window.hibi.getDocument()).markdown === block,
      block,
    ).catch(async (error) => {
      t.diagnostic(
        JSON.stringify(
          await page.evaluate(
            async (block) => ({
              block,
              markdown: (await window.hibi.getDocument()).markdown,
              focused: document.activeElement?.getAttribute('aria-label'),
            }),
            block,
          ),
        ),
      )
      throw error
    })
    await rich.locator(selector).waitFor()
    await rich.press(`${mod}+Enter`)
    await page.keyboard.type('outside')
    await waitForAsync(page, async () =>
      (await window.hibi.getDocument()).markdown.endsWith('outside'),
    )
    assert.equal(await rich.getAttribute('contenteditable'), 'true')
    const paragraph = rich.locator('.cm-line').last()
    assert.equal(await paragraph.innerText(), 'outside')
    assert.equal(
      await paragraph.evaluate((element) =>
        element.matches(
          '.hibi-lp-codeblock, .hibi-lp-codetext, .hibi-lp-quote, .hibi-lp-h1',
        ),
      ),
      false,
    )
  }
})
