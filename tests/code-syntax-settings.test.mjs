import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu, pressShortcut, replaceSourceText } from './keyboard.mjs'

async function loadMarkdown(app, page, markdown) {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  // Fixture markdown loads through source mode; formatted typing inserts literal text.
  await pressShortcut(app, `${mod}+Shift+]`)
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(
    page,
    page.getByRole('textbox', { name: 'Markdown editor', exact: true }),
    markdown,
  )
  await page.evaluate(() => window.hibi.flushDocumentChanges())
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    markdown,
  )
  await pressShortcut(app, `${mod}+Shift+[`)
  await waitForDocumentEditor(app, page)
}

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
  await selectFormattedEngine(app, page, t.formattedEngine)
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
      ) &&
      !document.querySelector(
        '.rich-pane :is(pre, .hibi-lp-codeblock) .hibi-token-keyword',
      ),
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
  // The hidden rich pane refreshes its highlighting once it is shown.
  await page.getByRole('button', { name: /back to app/i }).click()
  await page.locator('.settings-screen').waitFor({ state: 'hidden' })
  await pressShortcut(app, `${mod}+Shift+[`)
  await page
    .locator('.rich-pane :is(pre, .hibi-lp-codeblock) .hibi-token-keyword')
    .waitFor()
    .catch(async (error) => {
      t.diagnostic(
        JSON.stringify(
          await page.evaluate(() => ({
            mode: document.querySelector('.editor-panes')?.className,
            blocks: document.querySelectorAll('.rich-pane .hibi-lp-codeblock')
              .length,
            keywords: document.querySelectorAll(
              '.rich-pane .hibi-token-keyword',
            ).length,
            firstCode: document
              .querySelector('.rich-pane .hibi-lp-codeblock')
              ?.outerHTML.slice(0, 400),
            prefix: document
              .querySelector('.rich-pane .cm-content')
              ?.cmTile.root.view.state.sliceDoc(0, 128),
          })),
        ),
      )
      throw error
    })
  await clickMenu(app, 'Settings')
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
  await selectFormattedEngine(app, page, t.formattedEngine)
  const cm = t.formattedEngine === 'codemirror'
  page.setDefaultTimeout(10000)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await clickMenu(app, 'Open…')
  await page
    .locator(cm ? '.rich-pane .hibi-lp-h1' : '.tiptap h1', {
      hasText: 'Long code',
    })
    .waitFor()
  const tokens = page.locator(
    '.rich-pane :is(pre, .hibi-lp-codeblock) [class*="hibi-token-"]',
  )
  await tokens.first().waitFor({ state: 'attached' })
  // The block has about 40,000 tokens; only text near the viewport is decorated.
  assert.ok((await tokens.count()) < 4000)
  if (cm) {
    await page.locator('.rich-pane .cm-content').evaluate((element) => {
      const view = element.cmTile.root.view
      view.dispatch({
        selection: {
          anchor: view.state.doc.line(view.state.doc.lines - 2).from,
        },
        scrollIntoView: true,
      })
    })
  } else
    await page
      .locator('.tiptap pre')
      .evaluate((pre) => pre.scrollIntoView({ block: 'end' }))
  await page.waitForFunction((cm) => {
    const pre = document.querySelector(
      cm ? '.rich-pane .hibi-lp-codeblock-last' : '.tiptap pre',
    )
    if (!pre) return false
    const last = [...pre.querySelectorAll('[class*="hibi-token-"]')].at(-1)
    return (
      last &&
      pre.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom <
        100
    )
  }, cm)
  assert.ok((await tokens.count()) < 4000)
  await tokens.last().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('const typed = 1')
  await page.waitForFunction(
    (cm) =>
      [
        ...document.querySelectorAll(
          '.rich-pane :is(pre, .hibi-lp-codeblock) .hibi-token-keyword',
        ),
      ].some(
        (token) =>
          token.textContent === 'const' &&
          (cm
            ? token.closest('.cm-line')?.textContent.trim() ===
              'const typed = 1'
            : token.nextSibling?.textContent === ' ' &&
              token.nextSibling.nextSibling?.textContent === 'typed'),
      ),
    cm,
  )
  // Long lines scroll inside the block; highlighting follows both axes.
  const wide = join(profile, 'wide-code.md')
  const row = `${'const horizontal = 42; '.repeat(50)}\n`
  await writeFile(wide, `# Wide code\n\n\`\`\`js\n${row.repeat(80)}\`\`\`\n`)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, wide)
  await clickMenu(app, 'Open…')
  await page
    .locator(cm ? '.rich-pane .hibi-lp-h1' : '.tiptap h1', {
      hasText: 'Wide code',
    })
    .waitFor()
  // CodeMirror draws a block's scroll box again when lines draw above it,
  // so its checks find the box anew; the rich editor keeps its pre.
  const box = cm ? '.rich-pane .hibi-lp-codescroll' : null
  const block = page
    .locator(box ?? '.tiptap:has(h1:text-is("Wide code")) pre')
    .first()
  await block.waitFor()
  await block.evaluate(async (pre, box) => {
    // A redraw may replace the box; wait for the new one.
    while (box && !pre.isConnected) {
      pre = document.querySelector(box) ?? pre
      if (!pre.isConnected) await new Promise(requestAnimationFrame)
    }
    pre.scrollLeft = pre.scrollWidth
    if (pre.matches('.rich-pane')) pre.scrollTop = pre.scrollHeight
    else pre.scrollIntoView({ block: 'end' })
  }, box)
  if (cm)
    await t.test('wide code can scroll horizontally', async () => {
      assert.ok(
        await block.evaluate(async (pre, box) => {
          // A redraw may replace the box; wait for the new one.
          while (box && !pre.isConnected) {
            pre = document.querySelector(box) ?? pre
            if (!pre.isConnected) await new Promise(requestAnimationFrame)
          }
          return pre.scrollLeft > 0
        }, box),
        'wide code retains horizontal scrolling',
      )
    })
  await block.evaluate(
    (pre, selector) =>
      new Promise((resolve, reject) => {
        const started = performance.now()
        const check = () => {
          if (selector && !pre.isConnected)
            pre = document.querySelector(selector) ?? pre
          // A redraw replaces the box; wait a frame for the new one.
          if (!pre.isConnected) {
            if (performance.now() - started > 8000)
              reject(new Error('no code box is drawn'))
            else requestAnimationFrame(check)
            return
          }
          const box = pre.getBoundingClientRect()
          const pane = pre.closest('.rich-pane').getBoundingClientRect()
          const shown = [
            ...pre.querySelectorAll('[class*="hibi-token-"]'),
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
    box,
  )
})

test(
  'rich highlighting waits while source mode hides it, and long lines stay windowed',
  () => ({ timeout: 45000 }),
  async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-code-hidden-'))
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
    const cm = t.formattedEngine === 'codemirror'
    page.setDefaultTimeout(10000)
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.getByRole('textbox', { name: /document editor/i }).waitFor()
    const rich = page.locator(cm ? '.rich-pane .cm-content' : '.tiptap')
    if (cm) await loadMarkdown(app, page, '```js\nconst hidden = 42;\n```')
    else
      await rich.evaluate((element) =>
        element.editor.commands.setContent('```js\nconst hidden = 42;\n```', {
          contentType: 'markdown',
        }),
      )
    await page.locator('.rich-pane .hibi-token-keyword').waitFor()
    // Source mode hides the rich pane with its style; it keeps its size.
    await pressShortcut(app, `${mod}+Shift+]`)
    await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('.rich-pane')).visibility ===
        'hidden',
    )
    if (cm)
      await rich.evaluate((element) => {
        // PM plugin metadata has no CM equivalent; observe hidden highlighting work and visible refresh.
        window.richRefreshes = 0
        window.richHighlightObserver = new MutationObserver((records) => {
          window.richRefreshes += records.length
        })
        window.richHighlightObserver.observe(element, {
          childList: true,
          subtree: true,
          attributes: true,
        })
      })
    else
      await rich.evaluate((element) => {
        const { editor } = element
        const plugin = editor.state.plugins.find((plugin) =>
          plugin.key.startsWith('codeHighlight'),
        )
        window.richRefreshes = 0
        editor.on('transaction', ({ transaction }) => {
          if (transaction.getMeta(plugin)) window.richRefreshes++
        })
      })
    await clickMenu(app, 'Settings')
    await page
      .getByRole('tab', { name: /^code highlight$/i, exact: true })
      .click()
    const javascript = page.getByRole('checkbox', {
      name: /^javascript$/i,
      exact: true,
    })
    const sourceKeyword = (shown) =>
      page.waitForFunction(
        (shown) =>
          [
            ...document.querySelectorAll('.source-pane .hibi-token-keyword'),
          ].some((token) => token.textContent === 'const') === shown,
        shown,
      )
    await javascript.click()
    await sourceKeyword(false)
    await javascript.click()
    await sourceKeyword(true)
    await page.getByRole('button', { name: /back to app/i }).click()
    await page.locator('.settings-screen').waitFor({ state: 'hidden' })
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
    assert.equal(await page.evaluate(() => window.richRefreshes), 0)
    await pressShortcut(app, `${mod}+Shift+[`)
    // Accepted difference: the rich editor refreshes its highlighting once when
    // shown; the language ended as it was, so CodeMirror has nothing to redraw.
    await page.waitForFunction(
      (cm) =>
        (cm || window.richRefreshes === 1) &&
        !!document.querySelector('.rich-pane .hibi-token-keyword'),
      cm,
    )
    if (cm) {
      await page.evaluate(() => window.richHighlightObserver.disconnect())
      // The shown view follows the language: no colors while it is off.
      const toggle = async () => {
        await clickMenu(app, 'Settings')
        await page
          .getByRole('tab', { name: /^code highlight$/i, exact: true })
          .click()
        await javascript.click()
        await page.getByRole('button', { name: /back to app/i }).click()
        await page.locator('.settings-screen').waitFor({ state: 'hidden' })
      }
      await toggle()
      await page.waitForFunction(
        () => !document.querySelector('.rich-pane .hibi-token-keyword'),
      )
      await toggle()
      await page.locator('.rich-pane .hibi-token-keyword').waitFor()
    }
    // One long line decorates the columns near the visible ones, also after typing.
    const longLine = `\`\`\`js\n${'const horizontal = 42; '.repeat(5000)}\n\`\`\``
    if (cm) await loadMarkdown(app, page, longLine)
    else
      await rich.evaluate((element) =>
        element.editor.commands.setContent(
          `\`\`\`js\n${'const horizontal = 42; '.repeat(5000)}\n\`\`\``,
          { contentType: 'markdown' },
        ),
      )
    const tokens = page.locator(
      '.rich-pane :is(pre, .hibi-lp-codeblock) [class*="hibi-token-"]',
    )
    await tokens.first().waitFor({ state: 'attached' })
    assert.ok((await tokens.count()) < 1000, 'the line is windowed')
    if (cm) {
      await rich.focus()
      await rich.evaluate((element) =>
        element.cmTile.root.view.dispatch({
          selection: { anchor: 15 },
          scrollIntoView: true,
        }),
      )
      await page.keyboard.insertText(' ')
      await page.evaluate(() => window.hibi.flushDocumentChanges())
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).markdown,
        `${longLine.slice(0, 15)} ${longLine.slice(15)}`,
      )
    } else
      await rich.evaluate((element) => {
        element.editor.commands.setTextSelection(10)
        element.editor.commands.insertContent(' ')
      })
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
    assert.ok((await tokens.count()) < 1000, 'typing keeps the line windowed')
  },
)

test(
  'scrolled tab-indented, wide-character, and wrapped long lines keep visible highlighting',
  () => ({ timeout: 45000 }),
  async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-code-columns-'))
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
    const cm = t.formattedEngine === 'codemirror'
    page.setDefaultTimeout(10000)
    await page.getByRole('textbox', { name: /document editor/i }).waitFor()
    const rich = page.locator(cm ? '.rich-pane .cm-content' : '.tiptap')
    const show = async (markdown, place) => {
      if (cm) await loadMarkdown(app, page, markdown)
      else
        await rich.evaluate(
          (element, markdown) =>
            element.editor.commands.setContent(markdown, {
              contentType: 'markdown',
            }),
          markdown,
        )
      await page
        .locator(
          '.rich-pane :is(pre, .hibi-lp-codeblock) [class*="hibi-token-"]',
        )
        .first()
        .waitFor({ state: 'attached' })
      const box = cm ? '.rich-pane .hibi-lp-codescroll' : null
      const block = page.locator(box ?? '.tiptap pre').first()
      await block.evaluate(place, box)
      if (cm)
        assert.equal(
          (await page.evaluate(() => window.hibi.getDocument())).markdown,
          markdown,
        )
      // Highlighted text must appear where the block is scrolled to.
      await block.evaluate(
        (pre, selector) =>
          new Promise((resolve, reject) => {
            const started = performance.now()
            const check = () => {
              if (selector && !pre.isConnected)
                pre = document.querySelector(selector) ?? pre
              // A redraw replaces the box; wait a frame for the new one.
              if (!pre.isConnected) {
                if (performance.now() - started > 8000)
                  reject(new Error('no code box is drawn'))
                else requestAnimationFrame(check)
                return
              }
              const box = pre.getBoundingClientRect()
              const pane = pre.closest('.rich-pane').getBoundingClientRect()
              const shown = [
                ...pre.querySelectorAll('[class*="hibi-token-"]'),
              ].some((token) => {
                const rect = token.getBoundingClientRect()
                return (
                  rect.right > box.left &&
                  rect.left < box.right &&
                  rect.bottom > Math.max(box.top, pane.top) &&
                  rect.top < Math.min(box.bottom, pane.bottom)
                )
              })
              if (shown) resolve()
              else if (performance.now() - started > 8000)
                reject(new Error('no highlighted code is visible'))
              else requestAnimationFrame(check)
            }
            check()
          }),
        box,
      )
    }
    const right = async (pre, box) => {
      // A redraw may replace the box; wait for the new one.
      while (box && !pre.isConnected) {
        pre = document.querySelector(box) ?? pre
        if (!pre.isConnected) await new Promise(requestAnimationFrame)
      }
      pre.scrollIntoView({ block: 'start' })
      pre.scrollLeft = pre.scrollWidth
    }
    // An ASCII header, then lines indented by tabs far to the right.
    await show(
      `\`\`\`js\nconst header = 42;\n${`${'\t'.repeat(300)}const tabbed = 42;\n`.repeat(40)}\`\`\``,
      right,
    )
    // One line of 20,000 wide characters.
    await show(
      `\`\`\`js\nconst text = "${'漢'.repeat(20_000)}";\n\`\`\``,
      right,
    )
    // A short first line, then one long line that wraps.
    await page.addStyleTag({
      content:
        '.rich-pane :is(pre, .hibi-lp-codeblock) { white-space: pre-wrap; overflow-wrap: anywhere; }',
    })
    await show(
      `\`\`\`js\nconst header = 42;\n${'const wrapped = 42; '.repeat(5000)}\n\`\`\``,
      async (pre, box) => {
        // A redraw may replace the box; wait for the new one.
        while (box && !pre.isConnected) {
          pre = document.querySelector(box) ?? pre
          if (!pre.isConnected) await new Promise(requestAnimationFrame)
        }
        const pane = pre.closest('.rich-pane')
        const content = pre.matches('.rich-pane')
          ? pre.querySelector('.cm-content')
          : pre
        pane.scrollTop +=
          content.getBoundingClientRect().top -
          pane.getBoundingClientRect().top +
          content.offsetHeight / 2
      },
    )
  },
)
