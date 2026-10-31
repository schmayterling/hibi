import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForFormattedEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('editable split preserves catch-up, save, mapped selections and dormant bookmarks', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-cm-split-catchup-'))
  const file = join(profile, 'split.md')
  const original = '# title\n\nalpha **bold** content\n\nomega'
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
  const rich = await waitForFormattedEditor(app, page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await source.waitFor()
  // Accepted difference: the codemirror split pane stays editable.
  assert.equal(
    await rich.evaluate((element) => element.isContentEditable),
    true,
  )
  const expectSource = async (text) => {
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
    if (
      (await page.locator('.source-pane').getAttribute('aria-hidden')) ===
      'false'
    )
      assert.equal(
        await source.evaluate((element) =>
          element.cmTile.root.view.state.doc.toString(),
        ),
        text,
      )
  }
  const typeSource = async (text, at = 'end') => {
    await source.focus()
    await source.evaluate(
      (element, { text, at }) => {
        const view = element.cmTile.root.view
        if (!view.hasFocus) throw new Error('source must own input')
        const from = at === 'start' ? 0 : view.state.doc.length
        view.dispatch({
          changes: { from, insert: text },
          selection: { anchor: from + text.length },
          userEvent: 'input.type',
        })
      },
      { text, at },
    )
  }
  const selection = () =>
    rich.evaluate((element) => {
      const { anchor, head } = element.cmTile.root.view.state.selection.main
      return { anchor, head }
    })
  const bookmark = async () =>
    rich.evaluate((element) => {
      const view = element.cmTile.root.view
      const at = view.state.doc.toString().indexOf('omega')
      if (at < 0) throw new Error('missing bookmark text')
      view.dispatch({ selection: { anchor: at + 1, head: at + 4 } })
      return { anchor: at + 1, head: at + 4 }
    })
  const formatted = (text) =>
    page.waitForFunction(
      (text) =>
        document
          .querySelector('.rich-pane .cm-content')
          .cmTile.root.view.state.doc.toString() === text,
      text,
    )
  const first = `${original} source`
  await typeSource(' source')
  await expectSource(first)
  const saved = await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(saved.saveReceipt, true)
  assert.equal(await readFile(file, 'utf8'), first)
  await formatted(first)

  const beforePrefix = await bookmark()
  const prefixed = `preface\n\n${first}`
  await typeSource('preface\n\n', 'start')
  await expectSource(prefixed)
  await formatted(prefixed)
  assert.deepEqual(await selection(), {
    anchor: beforePrefix.anchor + 9,
    head: beforePrefix.head + 9,
  })
  const beforeMode = await bookmark()
  const modePrefix = 'visible\n\n'
  const visible = modePrefix + prefixed
  await typeSource(modePrefix, 'start')
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await formatted(visible)
  assert.deepEqual(await selection(), {
    anchor: beforeMode.anchor + modePrefix.length,
    head: beforeMode.head + modePrefix.length,
  })
  await expectSource(visible)
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await source.waitFor()
  const later = `${visible} later`
  await typeSource(' later')
  await rich.focus()
  await formatted(later)
  await bookmark()
  await rich.focus()
  assert.equal(await page.evaluate(() => getSelection().toString()), 'meg')
  await app.evaluate(({ clipboard }) => clipboard.clear())
  await rich.press('ControlOrMeta+c')
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    'meg',
  )

  await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    view.focus()
  })
  await page.evaluate(() => window.hibi.flushDocumentChanges())
  const beforeTyping = await page.evaluate(() => window.hibi.getDocument())
  await page.keyboard.insertText('!')
  await page.evaluate(() => window.hibi.flushDocumentChanges())
  const splitTyped = await page.evaluate(() => window.hibi.getDocument())
  // Typing in the codemirror split pane makes one source edit, and undo takes it back.
  assert.equal(splitTyped.markdown, `${later}!`)
  assert.equal(splitTyped.contentVersion, beforeTyping.contentVersion + 1)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${mod}+z`)
  await expectSource(later)
  await formatted(later)
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    view.focus()
  })
  await page.keyboard.insertText('!')
  await expectSource(`${later}!`)
  await pressShortcut(app, `${mod}+z`)
  await expectSource(later)
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await source.waitFor()

  const hiddenBookmark = await bookmark()
  await typeSource(' hidden')
  const beforeHide = `${later} hidden`
  await expectSource(beforeHide)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await source.waitFor()
  await rich.evaluate((element) => {
    window.dormantFormatted = {
      view: element.cmTile.root.view,
      doc: element.cmTile.root.view.state.doc,
      mutations: 0,
    }
    window.dormantFormatted.observer = new MutationObserver((records) => {
      window.dormantFormatted.mutations += records.length
    })
    window.dormantFormatted.observer.observe(element, {
      subtree: true,
      characterData: true,
      childList: true,
    })
  })
  const prefix = 'asleep\n\n'
  const hiddenSource = prefix + beforeHide
  await typeSource(prefix, 'start')
  await expectSource(hiddenSource)
  await page.evaluate(async () => {
    for (let frame = 0; frame < 3; frame++)
      await new Promise(requestAnimationFrame)
  })
  assert.deepEqual(
    await page.evaluate(() => {
      const f = window.dormantFormatted
      f.observer.disconnect()
      return {
        sameDocument: f.view.state.doc === f.doc,
        mutations: f.mutations,
        hidden: document.querySelector('.rich-pane').inert,
      }
    }),
    { sameDocument: true, mutations: 0, hidden: true },
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await formatted(hiddenSource)
  await expectSource(hiddenSource)
  assert.deepEqual(await selection(), {
    anchor: hiddenBookmark.anchor + prefix.length,
    head: hiddenBookmark.head + prefix.length,
  })
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(await readFile(file, 'utf8'), hiddenSource)
  await cdp.detach()
})
