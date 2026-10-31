import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { marked } from 'marked'
import {
  electron,
  waitForDocumentEditor,
  waitForFormattedEditor,
} from './electron.mjs'
import { frozenOracle } from './frozen-oracle.mjs'
import { clickMenu, pressShortcut, withHeldClock } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

// Whether the removed rich editor read each formatted result as the document
// its native input made (`same`), and its source where the review kept the
// native spelling (`native source`), recorded before its removal.
const native = frozenOracle('formatted-stored-marks-native')
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const scenarios = [
  {
    name: 'ordinary input splits a backtick run',
    source: 'a `b``c`',
    raw: 5,
    actions: ['inline-code', 'inline-code'],
    text: 'x',
    expected: 'a ``b`x`c``',
  },
  {
    name: 'continued adjacent code',
    source: 'a `b`',
    raw: 5,
    actions: ['inline-code', 'inline-code'],
    text: 'x`y',
    expected: 'a ``bx`y``',
  },
  {
    name: 'continued inside code',
    source: 'a `bc`',
    raw: 4,
    actions: ['inline-code', 'inline-code'],
    text: 'x`y',
    expected: 'a ``bx`yc``',
  },
  {
    name: 'continued padded code',
    source: 'a `` b` ``',
    raw: 7,
    actions: ['inline-code', 'inline-code'],
    text: 'x`y',
    expected: 'a ``b`x`y``',
  },
  {
    name: 'continued longer code run',
    source: 'a `b``c`',
    raw: 8,
    actions: ['inline-code', 'inline-code'],
    text: 'x`y',
    expected: 'a ```b``cx`y```',
  },
  {
    name: 'code excludes bold',
    source: 'a **bold** b',
    raw: 6,
    actions: ['inline-code'],
    text: 'X',
    expected: 'a **bo**`X`**ld** b',
  },
  {
    name: 'code excludes pending marks',
    source: 'plain end',
    raw: 9,
    actions: ['bold', 'italic', 'inline-code'],
    text: 'X',
    expected: 'plain end`X`',
  },
  {
    name: 'code off enables bold',
    source: 'a `code` b',
    raw: 5,
    actions: ['inline-code', 'bold'],
    text: 'X',
    expected: 'a `co`**X**`de` b',
  },
  {
    name: 'literal star',
    source: 'plain end',
    raw: 9,
    actions: ['bold'],
    text: '*',
    expected: 'plain end**\\***',
  },
  {
    name: 'literal entity',
    source: 'plain end',
    raw: 9,
    actions: ['bold'],
    text: '&copy;',
    expected: 'plain end**&amp;copy;**',
  },
  {
    name: 'continued backticks',
    source: 'plain end',
    raw: 9,
    actions: ['inline-code'],
    text: 'a`b',
    expected: 'plain end``a`b``',
  },
]

test('stored mark review cases through native input and toolbar', {
  timeout: 120000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-stored-marks-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await cdp.detach()
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await waitForFormattedEditor(app, page)
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const snapshot = () =>
    page.evaluate(async () => {
      await window.hibi.flushDocumentChanges()
      return (await window.hibi.getDocument()).markdown
    })
  const compareNative = async (name, source) => {
    assert.equal(
      await rich.evaluate((element) =>
        element.cmTile.root.view.state.doc.toString(),
      ),
      source,
    )
    // Preserve the native spelling for the pre-existing adjacent literals.
    if (name === 'literal star' || name === 'literal entity') {
      assert.equal(source, native({ kind: 'native source', name }))
      return
    }
    assert.equal(
      native({ kind: 'same', name, source }),
      true,
      JSON.stringify({ name, source }),
    )
  }
  const compose = async (text) => {
    await cdp.send('Input.imeSetComposition', {
      text: '仮',
      selectionStart: 1,
      selectionEnd: 1,
    })
    await waitForAsync(page, () =>
      document
        .querySelector('[aria-label="Document editor"]')
        .textContent.includes('仮'),
    )
    await cdp.send('Input.insertText', { text })
  }
  const open = async (name, source, raw) => {
    const file = join(profile, `${name}.md`)
    await writeFile(file, source)
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      `${name}.md`,
    )
    await waitForDocumentEditor(app, page)
    await rich.focus()
    await rich.evaluate(
      (element, raw) =>
        element.cmTile.root.view.dispatch({ selection: { anchor: raw } }),
      raw,
    )
  }
  const action = async (id) => {
    await page.evaluate((id) => {
      const button = document.querySelector(
        `.editor-toolbar [data-toolbar-id="format.${id}"]`,
      )
      if (!button || button.disabled)
        throw new Error(`format action unavailable: ${id}`)
      button.click()
    }, id)
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    )
    await rich.focus()
  }
  const history = async (source, typed) => {
    await pressShortcut(app, `${mod}+z`)
    assert.equal(await snapshot(), source, 'one undo restores exact source')
    await pressShortcut(
      app,
      process.platform === 'win32' ? 'Control+y' : `${mod}+Shift+z`,
    )
    assert.equal(await snapshot(), typed, 'redo restores typed text')
  }
  for (const item of scenarios)
    await t.test(item.name, async () => {
      await open(item.name, item.source, item.raw)
      for (const id of item.actions) await action(id)
      await withHeldClock(page, () => page.keyboard.type(item.text))
      const typed = await snapshot()
      await compareNative(item.name, typed)
      await history(item.source, typed)
      assert.equal(marked.parseInline(typed), marked.parseInline(item.expected))
    })
  await t.test('retyping after undo keeps code', async (t) => {
    const source = 'a `b`'
    await open('undo-retype-code', source, 5)
    await action('inline-code')
    await action('inline-code')
    await withHeldClock(page, () => page.keyboard.type('x`y'))
    const typed = await snapshot()
    assert.equal(marked.parseInline(typed), marked.parseInline('a ``bx`y``'))
    await history(source, typed)
    await pressShortcut(app, `${mod}+z`)
    assert.equal(await snapshot(), source)
    await page.keyboard.type('Z')
    const replaced = await snapshot()
    await history(source, replaced)
    await t.test('replacement text retains native code mark', async () => {
      await compareNative('undo-retype', replaced)
      assert.equal(marked.parseInline(replaced), marked.parseInline('a `bZ`'))
    })
  })
  for (const cancel of [true, false])
    await t.test(
      `pending marks survive ime ${cancel ? 'cancellation' : 'commit'}`,
      async (t) => {
        const source = 'plain end'
        await open(cancel ? 'cancel' : 'commit', source, 9)
        await action('bold')
        await cdp.send('Input.imeSetComposition', {
          text: '仮',
          selectionStart: 1,
          selectionEnd: 1,
        })
        await waitForAsync(page, () =>
          document
            .querySelector('[aria-label="Document editor"]')
            .textContent.includes('仮'),
        )
        if (cancel) {
          await cdp.send('Input.imeSetComposition', {
            text: '',
            selectionStart: 0,
            selectionEnd: 0,
          })
          await waitForAsync(
            page,
            async (source) =>
              (await window.hibi.getDocument()).markdown === source,
            source,
          )
          await page.keyboard.type('X')
          const typed = await snapshot()
          await compareNative('cancelled-ime', typed)
          await history(source, typed)
          assert.equal(
            marked.parseInline(typed),
            marked.parseInline('plain end**X**'),
          )
        } else {
          await cdp.send('Input.insertText', { text: '日本' })
          const typed = await snapshot()
          await history(source, typed)
          await t.test('committed ime text keeps pending bold', async () => {
            await compareNative('committed-ime', typed)
            assert.equal(
              marked.parseInline(typed),
              marked.parseInline('plain end**日本**'),
            )
          })
        }
      },
    )
  for (const [id, text] of [
    ['bold', '*&copy;'],
    ['italic', '日本'],
    ['inline-code', 'a`b'],
  ])
    await t.test(`committed ime keeps ${id} and literal text`, async () => {
      await open('ime-' + id, 'plain end  tail', 10)
      await action(id)
      await compose(text)
      const typed = await snapshot()
      await compareNative('ime-' + id, typed)
      await history('plain end  tail', typed)
      await page.keyboard.type('Z')
      const continued = await snapshot()
      await compareNative('ime-continued-' + id, continued)
      await history(typed, continued)
    })

  for (const [source, raw] of [
    ['a `b`', 5],
    ['a `bc`', 4],
  ])
    await t.test(
      'committed ime continues existing code at ' + raw,
      async () => {
        await open('ime-existing-' + raw, source, raw)
        await action('inline-code')
        await action('inline-code')
        await compose('x`y')
        const typed = await snapshot()
        await compareNative('ime-existing-' + raw, typed)
        await history(source, typed)
      },
    )

  await t.test(
    'redo keeps code continuation and moving clears it',
    async () => {
      await open('redo-code', 'a `b`', 5)
      await action('inline-code')
      await action('inline-code')
      await withHeldClock(page, () => page.keyboard.type('x`y'))
      const typed = await snapshot()
      await history('a `b`', typed)
      await page.keyboard.type('Z')
      const continued = await snapshot()
      await compareNative('redo-continued', continued)
      await history(typed, continued)
      await rich.evaluate((element) =>
        element.cmTile.root.view.dispatch({ selection: { anchor: 0 } }),
      )
      await page.keyboard.type('Q')
      await compareNative('moved-selection', await snapshot())
    },
  )

  for (const detour of [false, true])
    await t.test(
      `redo restores pending bold${detour ? ' past a later group that took its typing back' : ''}`,
      async () => {
        const name = `redo-pending-${detour}`
        await open(name, 'plain end', 9)
        await action('bold')
        await withHeldClock(page, () => page.keyboard.type('X '))
        const typed = await snapshot()
        if (detour) {
          await rich.evaluate((element) =>
            element.cmTile.root.view.dispatch({ selection: { anchor: 0 } }),
          )
          await withHeldClock(page, async () => {
            await page.keyboard.type('Q')
            await page.keyboard.press('Backspace')
          })
          assert.equal(await snapshot(), typed)
        }
        await history('plain end', typed)
        await page.keyboard.type('Z')
        const continued = await snapshot()
        await compareNative(name, continued)
        assert.equal(
          marked.parseInline(continued),
          marked.parseInline('plain end**X Z**'),
        )
      },
    )

  await t.test('undo restores pending bold', async () => {
    await open('undo-pending', 'plain end', 9)
    await action('bold')
    await page.keyboard.type('X')
    await pressShortcut(app, `${mod}+z`)
    assert.equal(await snapshot(), 'plain end')
    await page.keyboard.type('Y')
    const typed = await snapshot()
    await compareNative('undo-pending', typed)
    assert.equal(
      marked.parseInline(typed),
      marked.parseInline('plain end**Y**'),
    )
  })

  await t.test(
    'candidate updates stay literal until one marked commit',
    async () => {
      await open('candidates', 'plain end', 9)
      await action('bold')
      for (const text of ['仮', '候補']) {
        await cdp.send('Input.imeSetComposition', {
          text,
          selectionStart: text.length,
          selectionEnd: text.length,
        })
        await waitForAsync(
          page,
          (text) =>
            document
              .querySelector('[aria-label="Document editor"]')
              .textContent.includes(text),
          text,
        )
        assert.equal(await snapshot(), 'plain end' + text)
      }
      await cdp.send('Input.insertText', { text: '日本' })
      const typed = await snapshot()
      assert.equal(typed, 'plain end**日本**')
      await compareNative('committed-ime', typed)
      await history('plain end', typed)
    },
  )

  await t.test(
    'source edits clear pending marks and retain source focus',
    async () => {
      await open('external', 'plain end', 9)
      await page
        .getByRole('button', { name: /^side-by-side$/i, exact: true })
        .click()
      await page
        .locator('.mode-side-by-side[data-source-ready="true"]')
        .waitFor()
      await rich.focus()
      await action('bold')
      const source = page.getByRole('textbox', {
        name: 'Markdown editor',
        exact: true,
      })
      await source.focus()
      await source.evaluate((element) => {
        const view = element.cmTile.root.view
        view.dispatch({
          changes: { from: 0, insert: 'other ' },
          selection: { anchor: 15 },
          userEvent: 'input.type',
        })
      })
      assert.equal(
        await source.evaluate((element) => element === document.activeElement),
        true,
      )
      assert.equal(await snapshot(), 'other plain end')
      await rich.focus()
      await rich.evaluate((element) =>
        element.cmTile.root.view.dispatch({ selection: { anchor: 15 } }),
      )
      await page.keyboard.type('X')
      assert.equal(await snapshot(), 'other plain endX')
    },
  )
})
