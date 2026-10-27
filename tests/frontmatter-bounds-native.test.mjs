import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { uiName } from './ui.mjs'

test('bounded metadata stays present, preserves crlf counts and suppresses source slash queries', {
  timeout: 120000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-bounded-metadata-'))
  const lines = (count, eol) =>
    Array.from(
      { length: count },
      (_, i) => `k${String(i).padStart(6, '0')}: some value here`,
    ).join(eol)
  const fixtures = [
    [
      'crlf',
      `---\r\n${lines(10083, '\r\n')}\r\n---\r\n\r\nbody words here\r\n`,
      false,
    ],
    [
      'large',
      `\uFEFF---\n${lines(12000, '\n')}\n...\n\nbody words here\n`,
      true,
    ],
  ]
  await writeFile(
    join(folder, 'addons.json'),
    JSON.stringify({ 'word-count': true }),
  )
  for (const [name, source] of fixtures)
    await writeFile(join(folder, `${name}.md`), source)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${folder}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const idle = () =>
    page.evaluate(async () => {
      for (let step = 0; step < 6; step++)
        await new Promise((resolve) => requestIdleCallback(resolve))
    })
  const frames = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
  for (const [name, source, oversized] of fixtures) {
    await app.evaluate(
      ({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        })
      },
      join(folder, `${name}.md`),
    )
    await clickMenu(app, 'Open…')
    await page.waitForFunction(
      (length) =>
        document.querySelector('.rich-pane .cm-content')?.cmTile?.root?.view
          ?.state.doc.length === length,
      source.replaceAll('\r\n', '\n').length,
    )
    await waitForDocumentEditor(app, page)
    await page.locator('.rich-pane .cm-content').focus()
    t.diagnostic(`checking ${name}`)
    await idle()
    if (!oversized)
      await page.waitForFunction(() =>
        /^3 words/.test(
          document.querySelector('[data-status-id="word-count.total"]')
            ?.textContent ?? '',
        ),
      )
    await page.locator('.rich-pane .cm-content').evaluate((element) => {
      const view = element.cmTile.root.view
      view.focus()
      view.dispatch({
        selection: { anchor: view.state.doc.length },
        scrollIntoView: true,
      })
    })
    await page.keyboard.press('Enter')
    await page.keyboard.type('/')
    await idle()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowRight')
    try {
      await page.getByRole('listbox', { name: /slash commands/i }).waitFor()
    } catch (error) {
      t.diagnostic(
        JSON.stringify(
          await page.locator('.rich-pane .cm-content').evaluate((element) => {
            const view = element.cmTile.root.view
            return {
              length: view.state.doc.length,
              head: view.state.selection.main.head,
              suffix: view.state.doc.sliceString(view.state.doc.length - 40),
              focus: view.hasFocus,
              editable: element.contentEditable,
              readOnly: view.state.readOnly,
              viewport: view.viewport,
              scroll: view.scrollDOM.scrollTop,
              fields: view.state.values
                .filter(
                  (value) =>
                    value &&
                    typeof value.open === 'boolean' &&
                    'oversized' in value,
                )
                .map(
                  ({ open, closer, end, oversized, complete, searched }) => ({
                    open,
                    closer,
                    end,
                    oversized,
                    complete,
                    searched,
                  }),
                ),
            }
          }),
        ),
      )
      throw error
    }
    await frames()
    assert.equal(
      await page
        .getByRole('option', { name: /frontmatter add page properties/i })
        .count(),
      0,
    )
    await page.keyboard.press('Escape')
    await page.locator('.rich-pane .cm-content').evaluate((element, length) => {
      const view = element.cmTile.root.view
      view.dispatch({
        changes: { from: length, to: view.state.doc.length, insert: '' },
        selection: { anchor: length },
        userEvent: 'delete.backward',
      })
    }, source.replaceAll('\r\n', '\n').length)
    assert.equal(
      await page.evaluate(
        async () => (await window.hibi.getDocument()).markdown,
      ),
      source,
    )
    if (oversized) {
      await page.mouse.move(450, 18)
      await page
        .getByRole('button', { name: uiName('source view', true), exact: true })
        .click()
      await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
      await idle()
      await page
        .getByRole('textbox', { name: /markdown editor/i })
        .evaluate((element) => {
          const view = element.cmTile.root.view
          const from = view.state.doc.line(2).from
          view.focus()
          view.dispatch({
            changes: { from, insert: '/' },
            selection: { anchor: from + 1 },
            userEvent: 'input.type',
          })
        })
      await frames()
      assert.equal(await page.locator('.slash-menu:popover-open').count(), 0)
    }
  }
})
