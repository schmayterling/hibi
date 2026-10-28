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
        if (request.editor !== 'rich') return []
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
  const reset = async (text) => {
    await page.evaluate(
      (text) =>
        window.formattedCompletion.context.editor.updateMarkdown(() => text),
      text,
    )
    await saved(text)
    await rich.press('End')
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
