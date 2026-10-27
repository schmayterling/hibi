import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { replaceSourceText } from './keyboard.mjs'

for (const hidden of [true, false]) {
  for (const applied of [false, true]) {
    test(`codemirror: ${hidden ? 'hidden' : 'shown'} formatted echo failing ${applied ? 'after' : 'before'} rendering stays read-only until retry`, {
      timeout: 60000,
    }, async (t) => {
      const profile = await mkdtemp(join(tmpdir(), 'hibi-echo-failure-'))
      const file = join(profile, 'note.md')
      await writeFile(file, 'start')
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
      const errors = []
      page.on('pageerror', (error) => errors.push(String(error)))
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      await waitForDocumentEditor(app, page)
      await page.evaluate(() =>
        localStorage.setItem('hibi:formatted-engine', 'codemirror'),
      )
      await page.reload()
      await waitForDocumentEditor(app, page)
      // Hidden windows have no focus; typing needs a focused editor.
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
      const markdown = (text) =>
        waitForAsync(
          page,
          async (text) => (await window.hibi.getDocument()).markdown === text,
          text,
        )
      await markdown('start')
      await page
        .getByRole('button', {
          name: hidden ? 'Source view' : /^side-by-side$/i,
          exact: true,
        })
        .click()
      await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
      const typed = 'source echo fixture'
      // Fail once at either side of the view update, retaining the same DOM.
      await page.evaluate(
        ({ applied, typed }) => {
          const element = document.querySelector('.rich-pane .cm-content')
          window.echoFailedElement = element
          const view = element.cmTile.root.view
          const update = view.update
          view.update = function (transactions) {
            if (transactions.at(-1)?.state.doc.toString() !== typed)
              return update.call(this, transactions)
            view.update = update
            if (applied) update.call(this, transactions)
            throw new Error('Fixture rejected the source echo.')
          }
        },
        { applied, typed },
      )
      const source = page.getByRole('textbox', {
        name: 'Markdown editor',
        exact: true,
      })
      await replaceSourceText(page, source, typed)
      await markdown(typed)
      const normal = () =>
        page.getByRole('button', { name: /^normal$/i, exact: true }).click()
      if (hidden) await normal()
      await page
        .getByText('Fixture rejected the source echo.', { exact: true })
        .waitFor()
      await waitForAsync(page, () => {
        const element = document.querySelector('.rich-pane .cm-content')
        return (
          !element.isContentEditable &&
          element.getAttribute('aria-readonly') === 'true' &&
          document.querySelector('.editor-panes').dataset.sourceReady ===
            'false'
        )
      })
      const state = () =>
        page.evaluate(async () => {
          const element = document.querySelector('.rich-pane .cm-content')
          return {
            formatted: element.cmTile.root.view.state.doc.toString(),
            source: document
              .querySelector('.source-pane .cm-content')
              .cmTile.root.view.state.doc.toString(),
            canonical: (await window.hibi.getDocument()).markdown,
            editable: element.isContentEditable,
            readOnly: element.getAttribute('aria-readonly'),
            sameElement: element === window.echoFailedElement,
          }
        })
      const failed = await state()
      assert.deepEqual(failed, {
        formatted: applied ? typed : 'start',
        source: typed,
        canonical: typed,
        editable: false,
        readOnly: 'true',
        sameElement: true,
      })
      // The failed pane cannot undo canonical source through host history.
      const rich = page.getByRole('textbox', {
        name: 'Document editor',
        exact: true,
      })
      await rich.focus()
      assert.equal(
        await rich.evaluate((element) => element === document.activeElement),
        true,
      )
      await rich.press('ControlOrMeta+z')
      assert.equal((await state()).canonical, typed)
      // The healthy sibling remains editable while the failed view is frozen.
      if (hidden) {
        await page
          .getByRole('button', { name: 'Source view', exact: true })
          .click()
        await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
      }
      await source.press('End')
      await page.keyboard.insertText('?')
      await markdown(`${typed}?`)
      if (hidden) await normal()
      assert.deepEqual(await state(), {
        ...failed,
        source: `${typed}?`,
        canonical: `${typed}?`,
      })
      await page.getByRole('button', { name: 'Retry', exact: true }).click()
      await waitForDocumentEditor(app, page)
      await rich.press('End')
      await page.keyboard.insertText('!')
      await markdown(`${typed}?!`)
      if (hidden) {
        await page
          .getByRole('button', { name: /^side-by-side$/i, exact: true })
          .click()
        await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
      }
      const retried = await state()
      assert.equal(retried.source, `${typed}?!`)
      assert.equal(retried.formatted, `${typed}?!`)
      assert.equal(retried.canonical, `${typed}?!`)
      assert.equal(retried.editable, true)
      assert.equal(retried.readOnly, null)
      assert.equal(retried.sameElement, false)
      assert.equal(
        await page.getByText('Fixture rejected the source echo.').count(),
        0,
      )
      assert.deepEqual(errors, [])
      t.diagnostic(JSON.stringify({ typed, failed, retried, errors }))
    })
  }
}
