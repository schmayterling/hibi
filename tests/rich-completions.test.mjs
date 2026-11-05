import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForFormattedEditor } from './electron.mjs'
import { pressPastCompletionDelay, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

async function launchCompletionProbe(t) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-rich-completions-'))
  const folder = join(profile, 'installed-addons', 'completion-probe')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'completion-probe',
      name: 'Completion probe',
      description: 'Rich completion adapter test.',
      kind: 'extension',
      apiVersion: 3,
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
      window.completionSignals = []
      window.completionAccepted = []
      context.editor.onTypingContext(event => window.completionSignals.push(event))
      window.completionCalls = 0
      window.completionUnsafeRange = false
      window.completionReplacement = 'hello'
      const dispose = await context.editor.registerCompletionProvider(async (request) => {
        if (request.editor !== 'rich') return []
        window.completionCalls++
        if (!request.before.endsWith('hel')) return []
        return [{
          label: 'hello',
          detail: 'plain text',
          insertText: window.completionReplacement,
          from: window.completionUnsafeRange ? ${-1} : request.selection.head - 3,
          to: request.selection.head,
        }]
      }, { onAccepted(request, item) { window.completionAccepted.push({request, item}) } })
      window.completionFallback = false
      const stopFallback = await context.editor.registerCompletionProvider((request) => {
        if (request.editor !== 'rich') return []
        window.completionCalls++
        if (!window.completionFallback || !request.before.endsWith('hel')) return []
        return [{ label: 'help', insertText: 'help', from: request.selection.head - 3, to: request.selection.head }]
      })
      window.stopPrimaryCompletionProbe = dispose
      const stopActions = await context.editor.registerContextActionProvider((request) => [{
        label: 'Probe action',
        edit: { from: request.selection.head, to: request.selection.head, insertText: '!' },
      }])
      window.stopCompletionProbe = () => {
        stopActions()
        dispose()
        stopFallback()
      }
      window.completionProbeReady = true
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
    JSON.stringify({
      'completion-probe': true,
    }),
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
  const rich = await waitForFormattedEditor(app, page)
  page.setDefaultTimeout(8000)
  await rich.waitFor()
  await page.waitForFunction(() => window.completionProbeReady === true)
  return { app, page, rich }
}

test('rich completion contracts retain menu ownership, rendering, privacy and provider disposal', {
  timeout: 60000,
}, async (t) => {
  const { app, page, rich } = await launchCompletionProbe(t)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const menu = page.getByRole('listbox', { name: 'Completions' })
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
  const reset = async (text, anchor = text.length, head = anchor) => {
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      window.completionSignals = []
    })
    await rich.evaluate(
      (element, { text, anchor, head }) => {
        const view = element.cmTile.root.view
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor, head },
        })
        view.focus()
      },
      { text, anchor, head },
    )
    await saved(text)
    await settle()
    assert.deepEqual(await page.evaluate(() => window.completionSignals), [])
  }
  const choose = async () => {
    await page.keyboard.press('Control+Space')
    await menu.getByRole('option', { name: /hello/ }).waitFor()
    await pressPastCompletionDelay(page, 'Enter')
    await menu.waitFor({ state: 'hidden' })
  }
  assert.deepEqual(await page.evaluate(() => window.completionSignals), [])
  await t.test(
    'accepted completion is one native undo step with one callback',
    async () => {
      await rich.click()
      await page.keyboard.type('hel')
      await menu.getByRole('option', { name: /hello/ }).waitFor()
      await pressPastCompletionDelay(page, 'Enter')
      await saved('hello')
      assert.equal(
        await page.evaluate(() => window.completionAccepted.length),
        1,
      )
      await pressShortcut(app, mod + '+z')
      await saved('hel')
      await page.waitForFunction(
        () => window.completionSignals.at(-1)?.kind === 'undo',
      )
      assert.equal(
        await page.evaluate(() => window.completionAccepted.length),
        1,
      )
    },
  )
  await reset('hel')
  await page.evaluate(() => {
    window.completionReplacement = '[[proof-note]]'
  })
  await choose()
  await saved('[[proof-note]]')
  await t.test('wiki completion renders a named link', async () => {
    await rich.getByRole('link', { name: 'proof-note', exact: true }).waitFor()
  })
  await t.test(
    'wiki completion redo and subsequent typing keep separate undo steps',
    async () => {
      await pressShortcut(app, mod + '+z')
      await saved('hel')
      await pressShortcut(app, mod + '+Shift+z')
      await saved('[[proof-note]]')
      await rich.press('ControlOrMeta+End')
      await page.keyboard.insertText('x')
      await saved('[[proof-note]]x')
      await pressShortcut(app, mod + '+z')
      await saved('[[proof-note]]')
      await pressShortcut(app, mod + '+z')
      await saved('hel')
    },
  )
  await page.evaluate(() => {
    window.completionReplacement = 'hello'
  })
  await reset('hel')
  await page.keyboard.press('Control+Space')
  await menu.getByRole('option', { name: /hello/ }).waitFor()
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  await saved('hel')

  await reset('/he')
  const slashCalls = await page.evaluate(() => window.completionCalls)
  await page.keyboard.type('l')
  const slash = page.getByRole('listbox', { name: 'Slash commands' })
  await slash.waitFor()
  await settle()
  await t.test(
    'slash menu owns keys and suppresses completion requests',
    async () => {
      assert.equal(await menu.isVisible(), false)
      assert.equal(
        await page.evaluate(() => window.completionCalls),
        slashCalls,
      )
      await page.keyboard.press('ArrowDown')
      assert.equal(await slash.isVisible(), true)
      await page.keyboard.press('Escape')
      await slash.waitFor({ state: 'hidden' })
    },
  )

  await reset('hel')
  const actions = page.getByRole('menu', { name: 'Editor actions' })
  await rich.press('Shift+F10')
  await actions.getByRole('menuitem', { name: 'Probe action' }).waitFor()
  const actionCalls = await page.evaluate(() => window.completionCalls)
  await page.keyboard.press('Control+Space')
  await settle()
  await t.test(
    'editor actions own keys and suppress completion requests',
    async () => {
      assert.equal(await menu.isVisible(), false)
      assert.equal(
        await page.evaluate(() => window.completionCalls),
        actionCalls,
      )
    },
  )
  await page.keyboard.press('Escape')
  await actions.waitFor({ state: 'hidden' })
  await page.keyboard.press('Control+Space')
  await menu.getByRole('option', { name: /hello/ }).waitFor()
  await rich.press('Shift+F10')
  await actions.getByRole('menuitem', { name: 'Probe action' }).waitFor()
  await t.test(
    'opening editor actions closes an open completion list',
    async () => {
      await menu.waitFor({ state: 'hidden' })
    },
  )
  await page.keyboard.press('Escape')
  await actions.waitFor({ state: 'hidden' })
  const beforeUnsafe = await page.evaluate(() => {
    window.completionUnsafeRange = true
    return window.completionCalls
  })
  await page.keyboard.press('Control+Space')
  await page.waitForFunction(
    (before) => window.completionCalls > before,
    beforeUnsafe,
  )
  await settle()
  await t.test('unsafe completion ranges leave source unchanged', async () => {
    assert.equal(await menu.isVisible(), false)
    await saved('hel')
  })
  await page.evaluate(() => {
    window.completionUnsafeRange = false
  })

  for (const text of [
    '`secret`',
    '```\nsecret\n```',
    '[secret](https://private.example)',
    'password: secret',
    '/heading',
  ]) {
    const caret = text.startsWith('```')
      ? text.lastIndexOf('\n')
      : text.startsWith('`')
        ? text.length - 1
        : text.startsWith('[')
          ? text.indexOf(']')
          : text.length
    await reset(text, caret)
    await page.keyboard.type('x')
    await settle()
    await t.test(
      'typing context remains private in ' + JSON.stringify(text),
      async () => {
        assert.deepEqual(
          await page.evaluate(() => window.completionSignals),
          [],
        )
      },
    )
  }
  await reset('boundaryword')
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    () => window.completionSignals.at(-1)?.before === 'boundaryword\n',
  )
  await t.test(
    'newline boundary reports the exact native source change',
    async () => {
      const event = await page.evaluate(() => window.completionSignals.at(-1))
      const change = event.change
      assert.equal(
        'boundaryword'.slice(0, change.from) +
          '\n\n' +
          'boundaryword'.slice(change.to),
        'boundaryword\n\n',
      )
      assert.equal(change.insertedLength, 2)
      await saved('boundaryword\n\n')
    },
  )
  for (const [text, anchor, head, composing, commit, expected] of [
    ['bro ', 4, 4, '日本', '日本語', 'bro 日本語'],
    ['aa tail', 1, 1, 'a', 'aa', 'aaaa tail'],
    ['chosen tail', 0, 6, '日', '日本語', '日本語 tail'],
  ]) {
    await reset(text, anchor, head)
    await cdp.send('Input.imeSetComposition', {
      text: composing,
      selectionStart: composing.length,
      selectionEnd: composing.length,
    })
    await page.waitForFunction(
      () =>
        document.querySelector('.rich-pane .cm-content').cmTile.root.view
          .composing,
    )
    assert.deepEqual(await page.evaluate(() => window.completionSignals), [])
    await cdp.send('Input.insertText', { text: commit })
    await saved(expected)
    await settle()
    await t.test(
      'composition reports one committed source range for ' +
        JSON.stringify(text),
      async () => {
        const events = await page.evaluate(() => window.completionSignals)
        assert.equal(events.length, 1)
        assert.equal(events[0].kind, 'composition')
        assert.deepEqual(events[0].change, {
          from: anchor,
          to: head,
          insertedLength: commit.length,
        })
        assert.equal(
          events[0].before,
          expected.slice(0, anchor + commit.length),
        )
      },
    )
  }
  await reset('hel')
  await choose()
  await saved('hello')
  const accepted = await page.evaluate(() => window.completionAccepted.length)
  await page.keyboard.type(' ')
  await page.waitForFunction(
    () => window.completionSignals.at(-1)?.before === 'hello ',
  )
  await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({ selection: { anchor: 0, head: 5 } })
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'private pasted text')
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await saved('private pasted text ')
  await t.test(
    'paste replacement redacts context without accepting a completion',
    async () => {
      await page.waitForFunction(
        () => window.completionSignals.at(-1)?.kind === 'replace',
      )
      assert.deepEqual(
        await page.evaluate(() => ({
          before: window.completionSignals.at(-1).before,
          after: window.completionSignals.at(-1).after,
        })),
        { before: '', after: '' },
      )
      assert.equal(
        await page.evaluate(() => window.completionAccepted.length),
        accepted,
      )
    },
  )
  await reset('hel')
  await page.evaluate(() => {
    window.completionFallback = true
  })
  await page.keyboard.press('Control+Space')
  const primary = menu.getByRole('option', { name: /hello/ })
  const fallback = menu.getByRole('option', { name: 'help', exact: true })
  await primary.waitFor()
  await fallback.waitFor()
  await primary.hover()
  assert.equal(await primary.getAttribute('aria-selected'), 'true')
  await page.evaluate(() => window.stopPrimaryCompletionProbe())
  await primary.waitFor({ state: 'hidden' })
  await t.test(
    'disposing primary provider selects and accepts surviving fallback',
    async () => {
      assert.equal(await fallback.getAttribute('aria-selected'), 'true')
      await pressPastCompletionDelay(page, 'Enter')
      await menu.waitFor({ state: 'hidden' })
      await saved('help')
    },
  )
  await reset('hel')
  await page.keyboard.press('Control+Space')
  await fallback.waitFor()
  await page.evaluate(() => window.stopCompletionProbe())
  await menu.waitFor({ state: 'hidden' })
  const calls = await page.evaluate(() => window.completionCalls)
  await page.keyboard.type('x')
  await settle()
  assert.equal(await page.evaluate(() => window.completionCalls), calls)
})
