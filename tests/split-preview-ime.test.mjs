import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  waitForDocumentEditor,
  waitForFormattedEditor,
} from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

for (const [pane, mode] of [
  ['source', 'side-by-side'],
  ['rich', 'side-by-side'],
  ['rich', 'normal'],
]) {
  test(`native ${pane} IME in ${mode} survives catch-up, save, selection and undo`, {
    timeout: 45000,
  }, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-cm-split-ime-'))
    const file = join(profile, 'ime.md')
    const original = 'before 😀\r\n\r\nmiddle end\r\n\r\nomega'
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
    page.setDefaultTimeout(7000)
    await waitForFormattedEditor(app, page)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    if (mode === 'side-by-side') {
      await page
        .getByRole('button', { name: /^side-by-side$/i, exact: true })
        .click()
      await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
      // Accepted difference: the codemirror split pane stays editable.
      assert.equal(
        await page
          .getByRole('textbox', { name: 'Document editor', exact: true })
          .evaluate((element) => element.isContentEditable),
        true,
      )
      assert.equal(
        await page
          .getByRole('textbox', { name: 'Markdown editor', exact: true })
          .evaluate((element) => element.isContentEditable),
        true,
      )
    }
    const input = page.locator(`.${pane}-pane .cm-content`)
    const offset = original.replaceAll('\r\n', '\n').indexOf('end')
    await input.evaluate((element, offset) => {
      const view = element.cmTile.root.view
      window.cmIme = { view, events: [] }
      for (const type of [
        'compositionstart',
        'compositionupdate',
        'compositionend',
      ])
        element.addEventListener(
          type,
          (event) =>
            window.cmIme.events.push({
              type,
              data: event.data,
              trusted: event.isTrusted,
            }),
          true,
        )
      view.dispatch({ selection: { anchor: offset } })
      view.focus()
    }, offset)
    const compose = (
      text,
      selectionStart = text.length,
      selectionEnd = selectionStart,
    ) =>
      cdp.send('Input.imeSetComposition', {
        text,
        selectionStart,
        selectionEnd,
      })
    const expectSource = (text) =>
      waitForAsync(
        page,
        async (text) => (await window.hibi.getDocument()).markdown === text,
        text,
      )
    const candidate = (text) =>
      original.replace('middle end', `middle ${text}end`)
    const caughtUp = async (text) => {
      assert.equal(
        await page.evaluate((text) => {
          const view = window.cmIme.view
          return (
            view.composing &&
            view.hasFocus &&
            document
              .querySelector('.rich-pane .cm-content')
              .textContent.includes(text)
          )
        }, text),
        true,
      )
    }
    await compose('に')
    await expectSource(candidate('に'))
    // Real candidate pauses cross the typing-history timeout.
    await new Promise((resolve) => setTimeout(resolve, 600))
    await caughtUp('に')
    await compose('日本')
    await expectSource(candidate('日本'))
    await input.evaluate(() => {
      window.cmIme.beforeSelection = window.cmIme.view.state.doc
    })
    await compose('日本', 0, 1)
    await page.waitForFunction(
      () => !window.cmIme.view.state.selection.main.empty,
    )
    assert.deepEqual(
      await input.evaluate(() => {
        const f = window.cmIme
        return {
          unchanged: f.view.state.doc === f.beforeSelection,
          composing: f.view.composing,
          anchor: f.view.state.selection.main.anchor,
          head: f.view.state.selection.main.head,
        }
      }),
      { unchanged: true, composing: true, anchor: offset, head: offset + 1 },
    )
    await expectSource(candidate('日本'))
    await new Promise((resolve) => setTimeout(resolve, 600))
    await compose('日本語')
    await expectSource(candidate('日本語'))
    await cdp.send('Input.insertText', { text: '日本語😀' })
    const committed = candidate('日本語😀')
    await expectSource(committed)
    await page.waitForFunction(() => !window.cmIme.view.composing)
    const events = await page.evaluate(() => window.cmIme.events)
    assert.equal(
      events.filter((event) => event.type === 'compositionstart').length,
      1,
    )
    assert.equal(
      events.filter((event) => event.type === 'compositionend').length,
      1,
    )
    assert.ok(
      events
        .filter((event) => event.type !== 'compositionend')
        .every((event) => event.trusted),
      JSON.stringify(events),
    )
    assert.equal(
      events.find((event) => event.type === 'compositionend').data,
      '日本語😀',
    )
    assert.equal(
      await input.evaluate((element) =>
        element.cmTile.root.view.state.doc.toString(),
      ),
      committed.replaceAll('\r\n', '\n'),
    )
    assert.equal(
      await input.evaluate(
        (element) => element.cmTile.root.view.state.selection.main.head,
      ),
      offset + '日本語😀'.length,
    )
    const saved = await page.evaluate(() => window.hibi.saveDocument(false))
    assert.equal(saved.saveReceipt, true)
    assert.equal(await readFile(file, 'utf8'), committed)
    if (mode === 'side-by-side') {
      await page
        .getByRole('textbox', { name: 'Document editor', exact: true })
        .focus()
      await page
        .locator('.rich-pane .cm-content .cm-line', { hasText: '日本語😀' })
        .waitFor()
    }
    await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
    await expectSource(committed)
    if (mode === 'side-by-side') {
      await page
        .getByRole('button', { name: /^side-by-side$/i, exact: true })
        .click()
      await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
    }
    await input.focus()
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await pressShortcut(app, `${mod}+z`)
    await expectSource(original)
    assert.deepEqual(
      await input.evaluate((element) => {
        const { anchor, head } = element.cmTile.root.view.state.selection.main
        return { anchor, head }
      }),
      { anchor: offset, head: offset },
    )
    await pressShortcut(app, `${mod}+Shift+z`)
    await expectSource(committed)
    await compose('試')
    await cdp.send('Input.insertText', { text: '試' })
    const second = candidate('日本語😀試')
    await expectSource(second)
    await compose('字')
    await cdp.send('Input.insertText', { text: '字' })
    await expectSource(candidate('日本語😀試字'))
    await pressShortcut(app, `${mod}+z`)
    await expectSource(second)
    await pressShortcut(app, `${mod}+z`)
    await expectSource(committed)
    await compose('選')
    await cdp.send('Input.insertText', { text: '選' })
    const selected = candidate('日本語😀選')
    await expectSource(selected)
    await page.waitForFunction(() => !window.cmIme.view.composing)
    await input.press('ArrowLeft')
    await cdp.send('Input.insertText', { text: 'z' })
    await expectSource(candidate('日本語😀z選'))
    await pressShortcut(app, `${mod}+z`)
    await expectSource(selected)
    await pressShortcut(app, `${mod}+z`)
    await expectSource(committed)
    await cdp.detach()
  })
}
