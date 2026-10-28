import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { pressPastCompletionDelay, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('formatted completions keep exact source, history, composition, privacy and disposal', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-formatted-completions-'))
  const folder = join(profile, 'installed-addons', 'formatted-completion-probe')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'formatted-completion-probe',
      name: 'Formatted completion probe',
      description: 'Formatted completion contract test.',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      startup: 'background',
      capabilities: [],
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(folder, 'index.js'),
    `export default () => ({
    async start(context) {
      const probe = window.formattedCompletion = { context, events: [], requests: 0,
        accepted: [], invalid: false, replacement: 'hello' }
      const stopTyping = context.editor.onTypingContext(event => probe.events.push(event))
      const stop = await context.editor.registerCompletionProvider(request => {
        if (request.editor !== 'rich' && !probe.source) return []
        probe.requests++
        if (!request.before.endsWith('hel')) return []
        return [{ label: 'hello', insertText: probe.replacement,
          from: probe.invalid ? -1 : request.selection.head - 3,
          to: request.selection.head }]
      }, { onAccepted(request, item) { probe.accepted.push({ request, item }) } })
      const stopActions = await context.editor.registerContextActionProvider(request => [{
        label: 'Probe action',
        edit: { from: request.selection.head, to: request.selection.head, insertText: '!' },
      }])
      probe.dispose = () => { stopTyping(); stop(); stopActions() }
      probe.ready = true
    },
  })`,
  )
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'formatted-completion-probe': true }),
  )
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
  page.setDefaultTimeout(7000)
  const rich = await selectFormattedEngine(app, page, t.formattedEngine)
  await page.waitForFunction(() => window.formattedCompletion?.ready)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const saved = (text) =>
    waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
  const settle = () =>
    page.evaluate(async () => {
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
    })
  const reset = async (text, content) => {
    await page.evaluate(
      (text) =>
        window.formattedCompletion.context.editor.updateMarkdown(() => text),
      text,
    )
    await saved(text)
    await (content ? page.locator(content) : rich).press('End')
    await settle()
    await page.evaluate(() => {
      window.formattedCompletion.events = []
    })
  }
  const menu = page.getByRole('listbox', { name: 'Completions' })
  await rich.click()
  await page.keyboard.type('hel')
  await menu.getByRole('option', { name: 'hello', exact: true }).waitFor()
  await pressPastCompletionDelay(page, 'Enter')
  await menu.waitFor({ state: 'hidden' })
  await saved('hello')
  assert.equal(
    await page.evaluate(() => window.formattedCompletion.accepted.length),
    1,
  )
  await pressShortcut(app, `${mod}+z`)
  await saved('hel')
  await page.waitForFunction(
    () => window.formattedCompletion.events.at(-1)?.kind === 'undo',
  )
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y',
  )
  await saved('hello')
  assert.equal(
    await page.evaluate(() => window.formattedCompletion.accepted.length),
    1,
  )
  await pressShortcut(app, `${mod}+z`)
  await saved('hel')
  await page.evaluate(() => {
    window.formattedCompletion.replacement = '[[proof-note]]'
  })
  await page.keyboard.press('Control+Space')
  await menu.getByRole('option', { name: 'hello', exact: true }).waitFor()
  await pressPastCompletionDelay(page, 'Enter')
  await saved('[[proof-note]]')
  await pressShortcut(app, `${mod}+z`)
  await saved('hel')
  await page.keyboard.press('Control+Space')
  await menu.getByRole('option', { name: 'hello', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  await saved('hel')
  // Inspect the dispatched event after every handler has run, before ending
  // the composition or replacing the note. Acceptance alone misses fallback
  // bindings that insert a tab, move the caret, or arm Escape–Tab navigation.
  await page.evaluate(() => {
    window.addEventListener(
      'keydown',
      (event) => {
        window.formattedCompletion.lastKey = event
      },
      true,
    )
  })
  const accepted = () =>
    page.evaluate(() => window.formattedCompletion.accepted.length)
  const composingKeys = async (pane) => {
    const content =
      pane === 'source' ? page.locator('.source-pane .cm-content') : rich
    const snapshot = () =>
      content.evaluate(async (dom) => {
        const cm = dom.matches('.cm-content')
        const view = cm ? dom.cmTile.root.view : dom.editor.view
        const selection = cm ? view.state.selection.main : view.state.selection
        const event = window.formattedCompletion.lastKey
        return {
          markdown: (await window.hibi.getDocument()).markdown,
          anchor: selection.anchor,
          head: selection.head,
          started: cm ? view.compositionStarted : view.composing,
          changed: cm ? view.composing : false,
          armed: cm && view.inputState.tabFocusMode > 0,
          key: event?.key,
          isComposing: event?.isComposing,
          prevented: event?.defaultPrevented,
        }
      })
    const prepare = async () => {
      await reset(
        'hel\n\nbelow',
        pane === 'source' ? '.source-pane .cm-content' : undefined,
      )
      await content.evaluate((dom) => {
        if (dom.matches('.cm-content')) {
          dom.cmTile.root.view.dispatch({ selection: { anchor: 3 } })
          dom.cmTile.root.view.focus()
        } else {
          dom.editor.commands.setTextSelection(4)
          dom.editor.view.focus()
        }
      })
      await page.waitForFunction(
        (selector) => {
          const dom = document.querySelector(selector)
          const cm = dom.matches('.cm-content')
          const view = cm ? dom.cmTile.root.view : dom.editor.view
          return !(cm ? view.compositionStarted : view.composing)
        },
        pane === 'source'
          ? '.source-pane .cm-content'
          : '.rich-pane [contenteditable="true"]',
      )
      await page.keyboard.press('Control+Space')
      await menu.getByRole('option', { name: 'hello', exact: true }).waitFor()
    }
    for (const key of [
      'Tab',
      'Enter',
      'ArrowDown',
      'ArrowUp',
      'PageDown',
      'PageUp',
      'Escape',
      'Control+Space',
    ]) {
      await t.test(
        `${pane}: native composing ${key} belongs to the input method`,
        async () => {
          await prepare()
          const beforeAccepted = await accepted()
          await cdp.send('Input.imeSetComposition', {
            text: 'hel',
            selectionStart: 3,
            selectionEnd: 3,
            replacementStart: 0,
            replacementEnd: 3,
          })
          const before = await snapshot()
          assert.equal(before.started, true)
          assert.equal(before.changed, false)
          assert.equal(before.markdown, 'hel\n\nbelow')
          try {
            await pressPastCompletionDelay(page, key)
            await menu.waitFor({ state: 'hidden' })
            const after = await snapshot()
            if (key === 'Enter') {
              // The browser's default may add paragraph/line breaks. It must
              // preserve the text on both sides of the composing range.
              assert.match(after.markdown, /^hel\n{2,4}below$/)
            } else {
              assert.equal(after.markdown, before.markdown)
            }
            assert.equal(after.isComposing, true)
            assert.equal(after.prevented, false)
            assert.equal(after.armed, false)
            assert.equal(await accepted(), beforeAccepted)
            if (key === 'Tab' || key === 'Escape') {
              assert.equal(after.anchor, before.anchor)
              assert.equal(after.head, before.head)
            }
          } finally {
            await content.focus()
            await cdp.send('Input.insertText', { text: 'hel' })
          }
        },
      )
    }
    const cm = await content.evaluate((dom) => dom.matches('.cm-content'))
    for (const started of cm ? [false, true] : [true]) {
      await t.test(
        `${pane}: composing guard before the first paint (${started ? 'started' : 'event'})`,
        async () => {
          await prepare()
          const before = await snapshot()
          const beforeAccepted = await accepted()
          // This is one synchronous dispatch: no paint or text change can
          // intervene between compositionstart and the command key.
          const result = await content.evaluate((dom, started) => {
            const cm = dom.matches('.cm-content')
            const view = cm ? dom.cmTile.root.view : dom.editor.view
            if (started)
              dom.dispatchEvent(
                new CompositionEvent('compositionstart', { bubbles: true }),
              )
            const phase = {
              started: cm ? view.compositionStarted : view.composing,
              changed: cm ? view.composing : false,
            }
            const event = new KeyboardEvent('keydown', {
              key: 'Tab',
              code: 'Tab',
              keyCode: 9,
              bubbles: true,
              cancelable: true,
              isComposing: !started,
            })
            dom.dispatchEvent(event)
            if (started)
              dom.dispatchEvent(
                new CompositionEvent('compositionend', { bubbles: true }),
              )
            return { ...phase, prevented: event.defaultPrevented }
          }, started)
          assert.deepEqual(result, {
            started,
            changed: false,
            prevented: false,
          })
          await menu.waitFor({ state: 'hidden' })
          const after = await snapshot()
          assert.equal(after.markdown, before.markdown)
          assert.equal(after.anchor, before.anchor)
          assert.equal(after.head, before.head)
          assert.equal(after.armed, false)
          assert.equal(await accepted(), beforeAccepted)
        },
      )
    }
  }
  await composingKeys('rich')
  await page.evaluate(() => {
    window.formattedCompletion.source = true
  })
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await composingKeys('source')
  await page.evaluate(() => {
    window.formattedCompletion.source = false
  })
  await page.getByRole('button', { name: 'normal', exact: true }).click()
  await reset('hel')
  await page.evaluate(() => {
    window.formattedCompletion.invalid = true
  })
  const beforeInvalid = await page.evaluate(
    () => window.formattedCompletion.requests,
  )
  await page.keyboard.press('Control+Space')
  await page.waitForFunction(
    (before) => window.formattedCompletion.requests > before,
    beforeInvalid,
  )
  await settle()
  assert.equal(await menu.isVisible(), false)
  await saved('hel')
  await page.evaluate(() => {
    window.formattedCompletion.invalid = false
  })
  const actions = page.getByRole('menu', { name: 'Editor actions' })
  await rich.press('Shift+F10')
  await actions.getByRole('menuitem', { name: 'Probe action' }).waitFor()
  const beforeActions = await page.evaluate(
    () => window.formattedCompletion.requests,
  )
  await page.keyboard.press('Control+Space')
  await settle()
  assert.equal(await menu.isVisible(), false)
  assert.equal(
    await page.evaluate(() => window.formattedCompletion.requests),
    beforeActions,
  )
  await page.keyboard.press('Escape')
  await actions.waitFor({ state: 'hidden' })
  await reset('before chosen after 😀')
  await rich.focus()
  await settle()
  await rich.press('Home')
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight')
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight')
  assert.equal(await page.evaluate(() => getSelection().toString()), 'chosen')
  await cdp.send('Input.imeSetComposition', {
    text: '日',
    selectionStart: 1,
    selectionEnd: 1,
  })
  await settle()
  assert.deepEqual(
    await page.evaluate(() => window.formattedCompletion.events),
    [],
  )
  await cdp.send('Input.imeSetComposition', {
    text: '日本',
    selectionStart: 2,
    selectionEnd: 2,
  })
  await cdp.send('Input.insertText', { text: '日本語' })
  await saved('before 日本語 after 😀')
  await page.waitForFunction(() =>
    window.formattedCompletion.events.some(
      (event) => event.kind === 'composition',
    ),
  )
  assert.equal(
    await page.evaluate(() => window.formattedCompletion.events.length),
    1,
  )
  await t.test('typing context uses the named editor offsets', async () => {
    assert.deepEqual(
      await page.evaluate(() => window.formattedCompletion.events[0].change),
      t.formattedEngine === 'codemirror'
        ? { from: 7, to: 13, insertedLength: 3 }
        : { from: 8, to: 14, insertedLength: 3 },
    )
    const event = await page.evaluate(
      () => window.formattedCompletion.events[0],
    )
    const live = await rich.evaluate((element) => {
      if (element.matches('.cm-content')) {
        const { state } = element.cmTile.root.view
        const head = state.selection.main.head
        return { head, before: state.sliceDoc(0, head) }
      }
      const { state } = element.editor
      return {
        head: state.selection.head,
        before: state.doc.textBetween(0, state.selection.head),
      }
    })
    assert.equal(event.selection.head, live.head)
    assert.equal(event.before, live.before)
    assert.equal(
      event.change.from + event.change.insertedLength,
      event.selection.head,
    )
  })
  assert.equal(
    await page.evaluate(() => window.formattedCompletion.events[0].before),
    'before 日本語',
  )
  await pressShortcut(app, `${mod}+z`)
  await saved('before chosen after 😀')
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y',
  )
  await saved('before 日本語 after 😀')
  if (t.formattedEngine === 'codemirror') {
    await t.test('typing context counts crlf once', async () => {
      await reset('line\r\nbefore chosen after 😀')
      await page.waitForFunction(
        () =>
          document
            .querySelector('.cm-content')
            ?.cmTile?.root.view.state.doc.toString() ===
          'line\nbefore chosen after 😀',
      )
      await rich.evaluate((element) => {
        element.cmTile.root.view.dispatch({
          selection: { anchor: 12, head: 18 },
        })
      })
      await page.keyboard.insertText('日本語')
      await saved('line\r\nbefore 日本語 after 😀')
      await page.waitForFunction(() => window.formattedCompletion.events.length)
      const event = await page.evaluate(
        () => window.formattedCompletion.events[0],
      )
      const live = await rich.evaluate((element) => {
        const { state } = element.cmTile.root.view
        const head = state.selection.main.head
        return {
          head,
          before: state.sliceDoc(state.doc.lineAt(head).from, head),
        }
      })
      assert.deepEqual(event.change, { from: 12, to: 18, insertedLength: 3 })
      assert.equal(event.selection.head, live.head)
      assert.equal(event.before, live.before)
      assert.equal(event.before, 'before 日本語')
      assert.equal(
        event.change.from + event.change.insertedLength,
        event.selection.head,
      )
    })
  }
  await reset('password: secret')
  await page.keyboard.type('x')
  await settle()
  assert.deepEqual(
    await page.evaluate(() => window.formattedCompletion.events),
    [],
  )
  await reset('hel')
  await page.keyboard.press('Control+Space')
  await menu.getByRole('option', { name: 'hello', exact: true }).waitFor()
  await page.evaluate(() => window.formattedCompletion.dispose())
  await menu.waitFor({ state: 'hidden' })
  const beforeDispose = await page.evaluate(() => ({
    requests: window.formattedCompletion.requests,
    events: window.formattedCompletion.events.length,
  }))
  await page.keyboard.type('x')
  await saved('helx')
  await settle()
  assert.deepEqual(
    await page.evaluate(() => ({
      requests: window.formattedCompletion.requests,
      events: window.formattedCompletion.events.length,
    })),
    beforeDispose,
  )
  await cdp.detach()
})
