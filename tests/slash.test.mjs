import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { filterCommands } from '../src/addons/slash-commands/commands.ts'
import { markdownSyntax } from '../src/renderer/src/markdown-syntax.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  testFormattedEngines as it,
  selectFormattedEngine,
} from './formatted-engine.mjs'
import {
  clickMenu,
  replaceRichText,
  replaceSourceText,
  withHeldClock,
} from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('slash search matches labels, descriptions, and extension keywords without case sensitivity', () => {
  assert.deepEqual(
    markdownSyntax
      .snapshot()
      .filter((feature) => feature.id.startsWith('core.') && !feature.slash),
    [],
  )
  const unregister = markdownSyntax.register('test', {
    id: 'table',
    label: 'Tables',
    group: 'test',
    level: 'block',
    matches: (token) => token.type === 'table',
    slash: {
      markdown: '| a | b |',
      description: 'Two columns with a header',
      keywords: 'table grid',
    },
  })
  const context = {
    editor: {
      getSyntaxFeatures: () => markdownSyntax.snapshot(),
    },
    commands: {
      getSlashCommands: () => [
        {
          id: 'custom',
          label: 'MixedCase',
          description: 'Example',
          keywords: 'UPPER',
        },
      ],
    },
  }
  try {
    for (const query of ['table', 'TABLE', 'two COLUMNS'])
      assert.ok(
        filterCommands(query, context).some(
          (command) => command.id === 'test.table',
        ),
      )
    for (const query of ['mixedcase', 'example', 'upper'])
      assert.ok(
        filterCommands(query, context).some(
          (command) => command.id === 'custom',
        ),
      )
    markdownSyntax.setEnabled('test.table', false)
    assert.ok(
      !filterCommands('table', context).some(
        (command) => command.id === 'test.table',
      ),
    )
  } finally {
    markdownSyntax.setEnabled('test.table', true)
    unregister()
  }
})

it('slash commands work in both editors, preserve undo, and coexist with vim', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-slash-'))
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
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const rich = page.getByRole('textbox', { name: /document editor/i })
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  const menu = page.getByRole('listbox', { name: /slash commands/i })
  const read = () =>
    page.evaluate(async () => (await window.hibi.getDocument()).markdown)
  const undo = process.platform === 'darwin' ? 'Meta+z' : 'Control+z'
  const setFormattedFixture = (markdown) =>
    rich.evaluate((element, markdown) => {
      const view = element.cmTile.root.view
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: markdown },
        selection: { anchor: markdown.length },
      })
      view.focus()
    }, markdown)
  await waitForDocumentEditor(app, page)
  await t.test(
    'formatted slash actions retain menu, cancellation and history',
    async () => {
      await replaceRichText(page, rich, '/h2')
      await menu.waitFor()
      await rich.press('Enter')
      assert.equal(await rich.getByRole('heading', { level: 2 }).count(), 1)
      await rich.press(undo)
      assert.equal(await read(), '/h2')
      await replaceRichText(page, rich, '/h6')
      await menu.waitFor()
      await rich.press('Enter')
      assert.equal(await rich.getByRole('heading', { level: 6 }).count(), 1)
      await replaceRichText(page, rich, '/')
      await menu.waitFor()
      await page.waitForFunction(
        () =>
          document.querySelectorAll('.slash-menu:popover-open [role="option"]')
            .length > 12,
      )
      assert.ok((await menu.getByRole('option').count()) > 12)
      await menu
        .getByRole('option', { name: /^text plain paragraph$/i, exact: true })
        .click()
      assert.equal(await read(), '')
      await replaceRichText(page, rich, '/')
      await menu.waitFor()
      await rich.press('ArrowDown')
      await rich.press('Enter')
      assert.equal(await rich.getByRole('heading', { level: 1 }).count(), 1)
      await replaceRichText(page, rich, '/quote')
      await menu.waitFor()
      await menu
        .getByRole('option', { name: /^Quotes Indented quotation$/ })
        .click()
      assert.equal(
        await rich
          .locator(
            t.formattedEngine === 'tiptap'
              ? 'blockquote'
              : '.cm-line.hibi-lp-quote',
          )
          .count(),
        1,
      )
      await replaceRichText(page, rich, '/')
      await menu.waitFor()
      const beforeDismiss = await read()
      await rich.press('Escape')
      await menu.waitFor({ state: 'hidden' })
      assert.equal(await read(), beforeDismiss)
      await rich.pressSequentially('literal')
      assert.equal(await menu.isVisible(), false)
      if (t.formattedEngine === 'tiptap')
        await rich.evaluate((element) => {
          const editor = element.editor
          editor.commands.setContent('<p>/table</p>')
          editor.commands.setTextSelection(7)
          editor.commands.focus()
        })
      else await replaceRichText(page, rich, '/table')
      assert.equal(await read(), '/table')
      await menu.waitFor()
      await rich.press('Tab')
      assert.equal(await rich.locator('table').count(), 1)
      if (t.formattedEngine === 'tiptap')
        await rich.evaluate((element) => {
          const editor = element.editor
          editor.commands.setContent('<p>/</p>')
          editor.commands.setTextSelection(2)
          editor.commands.focus()
        })
      else await setFormattedFixture('/')
      await menu.waitFor()
      await rich.press('Escape')
      await menu.waitFor({ state: 'hidden' })
      if (t.formattedEngine === 'tiptap')
        await rich.evaluate((element) => {
          const editor = element.editor
          editor.commands.insertContent('literal')
          editor.commands.setContent('<p>/table</p>')
          editor.commands.setTextSelection(7)
        })
      else {
        await page.keyboard.insertText('literal')
        await setFormattedFixture('/table')
      }
      await menu.waitFor()
      assert.match(await menu.innerText(), /Tables/)
      await rich.press('Tab')
      assert.equal(await rich.locator('table').count(), 1)
      // A DOM fill cannot remove the table and quote nodes from earlier commands.
      if (t.formattedEngine === 'tiptap')
        await rich.evaluate((element) =>
          element.editor.commands.setContent('<p></p>'),
        )
      else await setFormattedFixture('')
      await replaceRichText(page, rich, '/alerts')
      await menu.waitFor()
      await rich.press('Enter')
      assert.equal(
        await rich
          .locator(
            t.formattedEngine === 'tiptap'
              ? '.github-alert'
              : '.hibi-lp-alert-title',
          )
          .count(),
        1,
      )
      assert.match(await read(), /> \[!NOTE\]/)
    },
  )

  await t.test(
    'physical typing replaces a selected table and undo restores it',
    async () => {
      if (t.formattedEngine === 'tiptap')
        await rich.evaluate((element) => {
          element.editor.commands.setContent('<p>/table</p>')
          element.editor.commands.setTextSelection(7)
          element.editor.commands.focus()
        })
      else await setFormattedFixture('/table')
      await menu.waitFor()
      await rich.press('Tab')
      assert.equal(await rich.locator('table').count(), 1)
      const original = await read()
      await rich.press('ControlOrMeta+a')
      await page.keyboard.press('r')
      await waitForAsync(
        page,
        async () => (await window.hibi.getDocument()).markdown === 'r',
      )
      assert.equal(await read(), 'r')
      assert.equal(await rich.locator('table').count(), 0)
      await rich.press(undo)
      await waitForAsync(
        page,
        async (expected) =>
          (await window.hibi.getDocument()).markdown === expected,
        original,
      )
      assert.equal(await read(), original)
      assert.equal(await rich.locator('table').count(), 1)
    },
  )

  await page.mouse.move(450, 18)
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await source.waitFor()
  await replaceSourceText(page, source, '/code')
  await menu.waitFor()
  await source.press('Enter')
  await withHeldClock(page, () => source.pressSequentially('sample'))
  assert.equal(await read(), '```\nsample\n```')
  await source.press(undo)
  await source.press(undo)
  assert.equal(await read(), '/code')
  await replaceSourceText(page, source, '/h6')
  await menu.waitFor()
  await source.press('Enter')
  assert.equal(await read(), '###### ')
  await replaceSourceText(page, source, '/h1')
  await menu.waitFor()
  await page.mouse.click(500, 20)
  await menu.waitFor({ state: 'hidden' })
  assert.equal(await read(), '/h1')

  for (const text of [
    'https://example.com/path',
    '/tmp/file',
    '```\n/code\n```',
    '---\ntitle: note\n/h1\n---',
  ]) {
    await replaceSourceText(page, source, text)
    if (text.startsWith('```') || text.startsWith('---')) {
      await source.press('ArrowUp')
      await source.press('End')
    }
    await page.waitForFunction(
      () => !document.querySelector('.slash-menu:popover-open'),
    )
    assert.equal(await read(), text)
  }
  await replaceSourceText(page, source, '/not-a-command')
  await menu.waitFor()
  assert.match(await menu.innerText(), /No commands found/)
  await source.press('Escape')

  await replaceSourceText(page, source, '/h2')
  await menu.waitFor()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(720, 520),
  )
  await page.waitForFunction(() => innerWidth === 720 && innerHeight === 520)
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  await menu.waitFor()
  await replaceSourceText(page, source, `${'paragraph\n\n'.repeat(24)}/h2`)
  await source.press('ArrowLeft')
  await source.press('ArrowRight')
  await menu.waitFor()
  const bounds = await page
    .locator('.slash-menu:popover-open')
    .evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: innerWidth,
        height: innerHeight,
      }
    })
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width)
  assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height)
  await source.press('Enter')
  await source.pressSequentially('heading')
  await page.mouse.move(400, 18)
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  if (t.formattedEngine === 'codemirror')
    // Accepted difference: the codemirror split pane stays editable.
    assert.equal(await rich.getAttribute('contenteditable'), 'true')
  await t.test(
    'formatted heading slash commands survive split mode',
    async () => {
      if (t.formattedEngine === 'tiptap')
        await page.waitForFunction(
          () => document.querySelector('.tiptap')?.editor?.isEditable === false,
        )
      await rich.getByRole('heading', { level: 2 }).last().waitFor()
      await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
      if (t.formattedEngine === 'tiptap')
        await page.waitForFunction(
          () => document.querySelector('.tiptap')?.editor?.isEditable,
        )
      else await rich.and(page.locator('[contenteditable="true"]')).waitFor()
      if (t.formattedEngine === 'tiptap')
        await rich
          .getByRole('heading', { level: 2 })
          .last()
          .evaluate((heading) => {
            const editor = heading.closest('.tiptap').editor
            editor.commands.setTextSelection(editor.view.posAtDOM(heading, 0))
            editor.commands.focus()
          })
      else
        await rich.evaluate((element) => {
          const view = element.cmTile.root.view
          const from = view.state.doc.toString().lastIndexOf('## ') + 3
          view.dispatch({ selection: { anchor: from } })
          view.focus()
        })
      await rich.pressSequentially('/quote')
      await menu.waitFor()
      await rich.press('Enter')
      assert.equal(
        await rich
          .locator(
            t.formattedEngine === 'tiptap'
              ? 'blockquote'
              : '.cm-line.hibi-lp-quote',
          )
          .count(),
        1,
      )
      assert.match(await read(), />/)
      await page.mouse.move(400, 18)
      await page
        .getByRole('button', { name: /^side-by-side$/i, exact: true })
        .click()
      await page.waitForFunction(
        (engine) =>
          (engine === 'codemirror' ||
            document.querySelector('.tiptap')?.editor?.isEditable === false) &&
          document
            .querySelector('.source-pane .cm-content')
            ?.textContent.includes('>'),
        t.formattedEngine,
      )
      assert.equal(
        await rich
          .locator(
            t.formattedEngine === 'tiptap'
              ? 'blockquote'
              : '.cm-line.hibi-lp-quote',
          )
          .count(),
        1,
      )
    },
  )
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()

  await page.mouse.move(450, 18)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.locator('#addon-slash-commands').click()
  await page.waitForFunction(
    () =>
      !document.querySelector('style[data-addon-style="slash-commands.menu"]'),
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await replaceSourceText(page, source, '/h1')
  assert.equal(await menu.count(), 0)
  const beforeToggle = await read()
  await page.mouse.move(450, 18)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.locator('#addon-slash-commands').click()
  await page.locator('#addon-vim').click()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  assert.equal(await read(), beforeToggle)
  await page
    .getByRole('status')
    .filter({ hasText: /vim · normal/i })
    .waitFor()
  await source.press('Escape')
  await source.press('/')
  await page.locator('.cm-vim-panel input').waitFor()
  assert.equal(await page.locator('.slash-menu:popover-open').count(), 0)
  await page.locator('.cm-vim-panel input').press('Escape')
  await source.pressSequentially('gg0cc')
  await page.keyboard.type('/h3')
  await menu.waitFor()
  await source.press('Enter')
  assert.equal(await read(), '### ')
  await page
    .getByRole('status')
    .filter({ hasText: /vim · insert/i })
    .waitFor()
  assert.deepEqual(errors, [])
})
