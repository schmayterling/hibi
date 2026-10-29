import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines,
} from './formatted-engine.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('tiptap: the legacy formatted-engine switch replaces the editor root', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-switch-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, 'tiptap')
  // The switch is a local-storage flag for tests and development profiles.
  assert.equal(await page.locator('.rich-pane .hibi-formatted').count(), 0)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await page.locator('.rich-pane .hibi-formatted .cm-content').waitFor()
  assert.equal(await page.locator('.rich-pane .tiptap').count(), 0)
})

test('codemirror: notes open in the formatted view and edit their markdown', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-view-'))
  const file = join(folder, 'notes', 'note.md')
  await mkdir(join(folder, 'notes'))
  await writeFile(file, '# Title\n\n- one\n\nA **bold** word.\n')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  // Quitting with the edited note answers the unsaved-changes prompt.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, 'codemirror')
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await page.locator('.rich-pane .hibi-lp-h1', { hasText: 'Title' }).waitFor()
  assert.equal(await page.locator('.rich-pane .tiptap').count(), 0)
  // Hidden windows have no focus; markers under the caret need a focused editor.
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const saved = (check, text) =>
    waitForAsync(
      page,
      async ({ check, text }) => {
        const { markdown } = await window.hibi.getDocument()
        return check === 'includes'
          ? markdown.includes(text)
          : markdown.endsWith(text)
      },
      { check, text },
    )

  // Enter at the end of an item continues the list.
  await page.locator('.rich-pane .cm-line', { hasText: 'one' }).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('two')
  await saved('includes', '- one\n- two')
  assert.ok(
    await page
      .locator('.rich-pane .hibi-lp-list-item', { hasText: 'two' })
      .count(),
  )

  // The caret inside bold text reveals its markers; elsewhere they are hidden.
  await page.locator('.rich-pane .hibi-lp-strong').click()
  await page.locator('.rich-pane .hibi-lp-marker').first().waitFor()
  assert.equal(
    await page.locator('.rich-pane .hibi-lp-marker').count(),
    2,
    'both ** markers',
  )
  await page.locator('.rich-pane .hibi-lp-h1').click()
  await waitForAsync(
    page,
    () => document.querySelectorAll('.rich-pane .hibi-lp-marker').length === 1,
  )

  // Typing inside formatting edits the source text; undo restores it.
  await page.locator('.rich-pane .hibi-lp-strong').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' more')
  await saved('includes', 'A **bold** word. more')
  await pressShortcut(app, `${mod}+z`)
  await saved('endsWith', 'A **bold** word.\n')

  // Formatting shortcuts edit the Markdown source of the selection.
  await page.locator('.rich-pane .cm-line', { hasText: 'two' }).dblclick()
  await page.keyboard.press(`${mod}+b`)
  await saved('includes', '- **two**')
  await page.locator('.rich-pane .hibi-lp-strong', { hasText: 'two' }).waitFor()
})

test('behind the switch, hidden fence lines and multi-line link destinations stay intact while editing', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-view-'))
  const file = join(folder, 'notes', 'note.md')
  await mkdir(join(folder, 'notes'))
  await writeFile(
    file,
    '# Edits\n\nintro\n```js\ncode\n```\n\nsee [label](\nhttps://example.com/\n)\n',
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await page.locator('.rich-pane .hibi-lp-h1', { hasText: 'Edits' }).waitFor()
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const markdown = async () =>
    (await page.evaluate(() => window.hibi.getDocument())).markdown

  const caretLine = () =>
    page.evaluate(() => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      return view.state.doc.lineAt(view.state.selection.main.head).text
    })

  // Typing beside a multi-line link destination edits the label. Before,
  // the input did not reach the text and the view threw.
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.focus()
    view.dispatch({
      selection: { anchor: view.state.doc.toString().lastIndexOf(')') + 1 },
    })
  })
  await page.keyboard.type('x')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes(
      '[label](\nhttps://example.com/\n)x',
    ),
  )

  // Arrows step over hidden fence lines, so typing lands on visible lines.
  // Before, the caret could rest on one and the text went into the fence.
  // As in the rich view, right arrow also steps over the blank line between
  // blocks to the next block.
  await page.locator('.rich-pane .cm-line', { hasText: 'code' }).click()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await caretLine(), 'intro')
  await page.keyboard.type('Y')
  await page.locator('.rich-pane .cm-line', { hasText: 'code' }).click()
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowRight')
  assert.equal(await caretLine(), 'see [label](')
  await page.keyboard.type('Z')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('Z'),
  )
  assert.ok(
    (await markdown()).includes('introY\n```js\ncode\n```\n'),
    await markdown(),
  )
})

test('behind the switch, completions get prose context past the first 16 KiB', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-view-'))
  const file = join(folder, 'long.md')
  const addon = join(folder, 'profile', 'installed-addons', 'completion-probe')
  await mkdir(addon, { recursive: true })
  await writeFile(
    file,
    `${'Small prose paragraph with a few words.\n\n'.repeat(500)}last paragraph prose`,
  )
  // An addon records the context each completion request carries.
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'completion-probe',
      name: 'Completion probe',
      description: 'Records completion requests',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      startup: 'background',
      capabilities: ['source'],
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(addon, 'index.js'),
    'export default () => ({ async start(context) { window.completionProbe = { calls: [], ready: false }; await context.editor.registerCompletionProvider((request) => { window.completionProbe.calls.push({ prose: request.prose, head: request.selection.head }); return [] }); window.completionProbe.ready = true } })',
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['index.js', 'hibi-addon.json'],
      source: 'local',
    }),
  )
  await writeFile(
    join(folder, 'profile', 'addons.json'),
    JSON.stringify({ 'completion-probe': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await page.waitForFunction(() => window.completionProbe?.ready)
  const formatted = page.locator('.rich-pane .cm-content')
  await formatted.waitFor()
  await formatted.focus()
  await formatted.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  await page.keyboard.press('Control+Space')
  await page.waitForFunction(() => window.completionProbe.calls.length > 0)
  const call = await page.evaluate(() => window.completionProbe.calls.at(-1))
  // Before, the context was null past character 16,384.
  assert.ok(call.head > 16384, JSON.stringify(call))
  assert.equal(call.prose?.before, 'last paragraph prose', JSON.stringify(call))
})

test('behind the switch, frontmatter properties above the formatted view edit the note', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-properties-'))
  const file = join(folder, 'notes', 'note.md')
  await mkdir(join(folder, 'notes'))
  await writeFile(file, '---\ntitle: One\n---\n\n# Title\n\nBody text.\n')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await page.locator('.rich-pane .hibi-lp-h1', { hasText: 'Title' }).waitFor()
  const properties = page.locator('.rich-pane .frontmatter')
  await properties.waitFor()
  // The properties show the frontmatter; the text below does not repeat it.
  // Before, it showed again as a rule and a heading.
  await waitForAsync(
    page,
    () =>
      !document
        .querySelector('.rich-pane .cm-content')
        ?.textContent.includes('title: One'),
  )
  assert.equal(await page.locator('.rich-pane .hibi-lp-h2').count(), 0)
  await properties.locator('.frontmatter-yaml-toggle').click()
  await properties.getByLabel('Frontmatter YAML').fill('title: Two\n')
  await properties.getByRole('button', { name: 'Apply YAML' }).click()
  // One minimal edit of the source; the rest of the note is untouched.
  await waitForAsync(page, async () => {
    const { markdown } = await window.hibi.getDocument()
    return markdown === '---\ntitle: Two\n---\n\n# Title\n\nBody text.\n'
  })
})

test('behind the switch, properties edit notes with crlf line breaks and a byte order mark', {
  timeout: 120000,
}, async (t) => {
  for (const [label, prefix, eol] of [
    ['crlf', '', '\r\n'],
    ['bom crlf', '\uFEFF', '\r\n'],
  ]) {
    const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-properties-'))
    const file = join(folder, 'notes', 'note.md')
    await mkdir(join(folder, 'notes'))
    const note = (title) =>
      `${prefix}---${eol}title: ${title}${eol}---${eol}${eol}# Title${eol}`
    await writeFile(file, note('A'))
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    t.after(async () => {
      await app.close()
      await rm(folder, { recursive: true, force: true })
    })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    const page = await app.firstWindow()
    await waitForDocumentEditor(app, page)
    await page.evaluate(() =>
      localStorage.setItem('hibi:formatted-engine', 'codemirror'),
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, file)
    await pressShortcut(app, `${mod}+o`)
    await page.locator('.rich-pane .hibi-lp-h1', { hasText: 'Title' }).waitFor()
    const title = page
      .locator('.rich-pane .frontmatter')
      .getByRole('textbox', { name: 'title', exact: true })
    await title.waitFor()
    // Before, offsets of the source text landed one line late in the view:
    // `title: A` became `title: A` and `B---`.
    await title.fill('AB')
    const expected = note('AB')
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      expected,
    ).catch(async () =>
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).markdown,
        expected,
        label,
      ),
    )
  }
})

test('behind the switch, frontmatter after a byte order mark shows once', {
  timeout: 120000,
}, async (t) => {
  for (const eol of ['\n', '\r\n']) {
    const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-properties-'))
    const file = join(folder, 'notes', 'note.md')
    await mkdir(join(folder, 'notes'))
    await writeFile(
      file,
      `\uFEFF---${eol}title: One${eol}---${eol}${eol}# Title${eol}${eol}Body text.${eol}`,
    )
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    t.after(async () => {
      await app.close()
      await rm(folder, { recursive: true, force: true })
    })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    const page = await app.firstWindow()
    await waitForDocumentEditor(app, page)
    await page.evaluate(() =>
      localStorage.setItem('hibi:formatted-engine', 'codemirror'),
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, file)
    await pressShortcut(app, `${mod}+o`)
    await page.locator('.rich-pane .hibi-lp-h1', { hasText: 'Title' }).waitFor()
    await page.locator('.rich-pane .frontmatter').waitFor()
    // Before, a byte order mark kept the frontmatter in the text as a rule
    // and a heading.
    await waitForAsync(
      page,
      () =>
        !document
          .querySelector('.rich-pane .cm-content')
          ?.textContent.includes('title: One'),
    )
    assert.equal(
      await page.locator('.rich-pane .hibi-lp-h2').count(),
      0,
      JSON.stringify(eol),
    )
  }
})

test('behind the switch, a leading block that is not a metadata mapping stays in the text', {
  timeout: 120000,
}, async (t) => {
  for (const [label, note, check] of [
    ['scalar', '---\nhello\n---\n\n# Title\n', 'hello'],
    ['empty', '---\n---\n\n# Title\n', null],
  ]) {
    const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-properties-'))
    const file = join(folder, 'notes', 'note.md')
    await mkdir(join(folder, 'notes'))
    await writeFile(file, note)
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    t.after(async () => {
      await app.close()
      await rm(folder, { recursive: true, force: true })
    })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    const page = await app.firstWindow()
    await waitForDocumentEditor(app, page)
    await page.evaluate(() =>
      localStorage.setItem('hibi:formatted-engine', 'codemirror'),
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, file)
    await pressShortcut(app, `${mod}+o`)
    await page.locator('.rich-pane .hibi-lp-h1', { hasText: 'Title' }).waitFor()
    // The properties do not show it, so the text does, as the rich view.
    // Before, any pair of `---` lines was hidden.
    const shown = await page.evaluate(() => ({
      text: document.querySelector('.rich-pane .cm-content')?.textContent,
      rules: document.querySelectorAll('.rich-pane .hibi-lp-rule').length,
    }))
    if (check) assert.ok(shown.text.includes(check), `${label}: ${shown.text}`)
    else assert.ok(shown.rules > 0, `${label}: ${JSON.stringify(shown)}`)
  }
})

test('behind the switch, a composition over a selected table undoes in one step however late it starts', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-view-'))
  const file = join(folder, 'notes', 'note.md')
  const note = 'before\n\n| a | b |\n| - | - |\n| c | d |\n\nafter\n'
  await mkdir(join(folder, 'notes'))
  await writeFile(file, note)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await page.locator('.rich-pane .hibi-lp-table').waitFor()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const markdown = async (text, label) => {
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    ).catch(() => {})
    const { markdown } = await page.evaluate(() => window.hibi.getDocument())
    assert.equal(markdown, text, label)
  }
  // Undo goes through the document's history, which starts a step with each composition.
  for (const late of [false, true]) {
    await page.locator('.rich-pane .cm-line', { hasText: 'before' }).click()
    await page.keyboard.press(`${mod}+a`)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
    })
    if (late)
      await page.evaluate(() => {
        const now = Date.now
        Date.now = () => now() + 1000
        window.restoreNow = () => {
          Date.now = now
        }
      })
    try {
      for (const text of ['k', 'か'])
        await cdp.send('Input.imeSetComposition', {
          text,
          selectionStart: 1,
          selectionEnd: 1,
        })
      await cdp.send('Input.insertText', { text: 'か' })
      await markdown('か', `late: ${late}`)
      await pressShortcut(app, `${mod}+z`)
      await markdown(note, `undo, late: ${late}`)
    } finally {
      if (late) await page.evaluate(() => window.restoreNow())
    }
  }
})

test('behind the switch, a note that is only a table takes text and compositions without a key over its selection', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-view-'))
  const file = join(folder, 'notes', 'note.md')
  const note = '| a | b |\n| - | - |\n| c | d |'
  await mkdir(join(folder, 'notes'))
  await writeFile(file, note)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await page.locator('.rich-pane .hibi-lp-table').waitFor()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const markdown = async (text, label) => {
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    ).catch(() => {})
    const { markdown } = await page.evaluate(() => window.hibi.getDocument())
    assert.equal(markdown, text, label)
  }
  // Without a line, the selection's DOM needs a place below the table for Chromium to take input.
  for (const candidates of [[], ['n', 'ni', '你']]) {
    await page
      .locator('.rich-pane .cm-content[aria-label="Document editor"]')
      .focus()
    await page.keyboard.press(`${mod}+a`)
    for (const text of candidates)
      await cdp.send('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      })
    const text = candidates.at(-1) ?? '👍'
    await cdp.send('Input.insertText', { text })
    await markdown(text, text)
    await pressShortcut(app, `${mod}+z`)
    await markdown(note, `undo ${text}`)
  }
})

test('behind the switch, undoing a composition from inside a table to past it shows the tables it restores', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-view-'))
  const file = join(folder, 'notes', 'note.md')
  const table = '| a | b |\n| - | - |\n| c | d |'
  const note = `before\n\n${table}\n\nafter\n\n${table}\n\nend`
  const range = [note.indexOf('| c') + 3, note.length]
  await mkdir(join(folder, 'notes'))
  await writeFile(file, note)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await page.locator('.rich-pane .hibi-lp-table').nth(1).waitFor()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const markdown = async (text, label) => {
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    ).catch(() => {})
    const { markdown } = await page.evaluate(() => window.hibi.getDocument())
    assert.equal(markdown, text, label)
  }
  await page.locator('.rich-pane .cm-content').evaluate((element, range) => {
    const { view } = element.cmTile.root
    view.focus()
    view.dispatch({ selection: { anchor: range[0], head: range[1] } })
  }, range)
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'k',
    code: 'KeyK',
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  for (const text of ['k', 'か'])
    await cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: 1,
      selectionEnd: 1,
    })
  await cdp.send('Input.insertText', { text: 'か' })
  await markdown(`${note.slice(0, range[0])}か`, 'composed')
  // Undo goes through the document's history, whose edits carry no input event.
  await pressShortcut(app, `${mod}+z`)
  await markdown(note, 'undone')
  await waitForAsync(
    page,
    () => document.querySelectorAll('.rich-pane .hibi-lp-table').length === 2,
  ).catch(() => {})
  assert.equal(await page.locator('.rich-pane .hibi-lp-table').count(), 2)
})

test('behind the switch, an edit from the source pane while composing in a table source keeps the composition', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-view-'))
  const file = join(folder, 'notes', 'note.md')
  const table = '| a | b |\n| - | - |\n| c | d |'
  const note = `before\n\n${table}\n\nafter\n\n${table}\n\nend`
  const range = [note.indexOf('| c') + 3, note.indexOf('after') + 2]
  await mkdir(join(folder, 'notes'))
  await writeFile(file, note)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await page.locator('.rich-pane .hibi-lp-table').nth(1).waitFor()
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await page.locator('.mode-side-by-side[data-source-ready="true"]').waitFor()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.locator('.rich-pane .cm-content').evaluate((element, range) => {
    const { view } = element.cmTile.root
    view.focus()
    view.dispatch({ selection: { anchor: range[0], head: range[1] } })
  }, range)
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'k',
    code: 'KeyK',
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  const candidate = (text) =>
    cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    })
  await candidate('k')
  // The source pane appends while the formatted pane composes.
  await page.locator('.source-pane .cm-content').evaluate((element) => {
    const { view } = element.cmTile.root
    view.dispatch({
      changes: { from: view.state.doc.length, insert: '!' },
      userEvent: 'input.type',
    })
  })
  await candidate('か')
  await cdp.send('Input.insertText', { text: 'か' })
  const expected = `${note.slice(0, range[0])}か${note.slice(range[1])}!`
  await waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown === text,
    expected,
  ).catch(() => {})
  const { markdown } = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(markdown, expected)
})

test('behind the switch, an echo before the first composition candidate keeps the caret', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-view-'))
  const file = join(folder, 'notes', 'note.md')
  const table = '| a | b |\n| - | - |\n| c | d |'
  const note = `before\n\n${table}\n\nafter\n\n${table}\n\nend`
  const range = [note.indexOf('| c') + 3, note.indexOf('after') + 2]
  await mkdir(join(folder, 'notes'))
  await writeFile(file, note)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await page.locator('.rich-pane .hibi-lp-table').nth(1).waitFor()
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await page.locator('.mode-side-by-side[data-source-ready="true"]').waitFor()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.locator('.rich-pane .cm-content').evaluate((element, range) => {
    const { view } = element.cmTile.root
    view.focus()
    view.dispatch({ selection: { anchor: range[0], head: range[1] } })
  }, range)
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'k',
    code: 'KeyK',
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  const candidate = (text) =>
    cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    })
  await page.waitForFunction(() => {
    const source = document.querySelector('.source-pane .cm-content').cmTile
      .root.view
    const formatted = document.querySelector('.rich-pane .cm-content').cmTile
      .root.view
    return source.state.doc.toString() === formatted.state.doc.toString()
  })
  // The source pane appends before the first candidate arrives.
  await page.locator('.source-pane .cm-content').evaluate((element) => {
    const { view } = element.cmTile.root
    view.dispatch({
      changes: { from: view.state.doc.length, insert: '!' },
      userEvent: 'input.type',
    })
  })
  await page.waitForFunction(() =>
    document
      .querySelector('.rich-pane .cm-content')
      .cmTile.root.view.state.doc.toString()
      .endsWith('!'),
  )
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  )
  const focused = await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .evaluate((element) => document.activeElement === element)
  await candidate('k')
  await candidate('か')
  await cdp.send('Input.insertText', { text: 'か' })
  const expected = `${note.slice(0, range[0])}か${note.slice(range[1])}!`
  await waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown === text,
    expected,
  ).catch(() => {})
  const { markdown } = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(markdown, expected)
  assert.equal(focused, true)
})

test('behind the switch, edits from elsewhere that change the columns of a table keep typing in its open cell', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-view-'))
  const file = join(folder, 'notes', 'note.md')
  await mkdir(join(folder, 'notes'))
  await writeFile(file, 'before\n\n| a | b |\n| - | - |\n| c | d |\n\nafter\n')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, 'codemirror')
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await page.locator('.rich-pane .hibi-lp-table').waitFor()
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await page.locator('.mode-side-by-side[data-source-ready="true"]').waitFor()
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const markdown = async () =>
    (await page.evaluate(() => window.hibi.getDocument())).markdown
  await page.locator('.rich-pane .hibi-lp-table td', { hasText: 'c' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type('X')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('| cX |'),
  )
  // The source pane adds a column before the edited cell's, then an edit
  // without a selection, as an addon's, aligns the columns in the formatted
  // view: the caret stays after X in the cell, now the second.
  for (const [pane, edits, editor, typed, row, drawn] of [
    [
      'source',
      [
        ['| a', '| n '],
        ['| - | - |', '| - '],
        ['| cX', '| m '],
      ],
      'cX',
      'Y',
      '| m | cXY | d |',
      'th:nth-child(3)',
    ],
    [
      'rich',
      [['- | - | - |', ':']],
      'cXY',
      'Z',
      '| m | cXYZ | d |',
      'th[style*="left"]',
    ],
  ]) {
    await page.evaluate(
      ({ pane, edits }) => {
        const view = document.querySelector(`.${pane}-pane .cm-content`).cmTile
          .root.view
        const text = view.state.doc.toString()
        view.dispatch({
          changes: edits.map(([before, insert]) => ({
            from: text.indexOf(before),
            insert,
          })),
        })
      },
      { pane, edits },
    )
    await page.locator(`.rich-pane .hibi-lp-table ${drawn}`).waitFor()
    const focus = await page.evaluate(async () => {
      for (let frame = 0; frame < 2; frame++)
        await new Promise(requestAnimationFrame)
      const active = document.activeElement
      return {
        cell: active.closest('td')?.cellIndex ?? null,
        editor: active.closest('.hibi-lp-cell-editor')?.textContent ?? null,
      }
    })
    assert.deepEqual(focus, { cell: 1, editor }, pane)
    await page.keyboard.type(typed)
    await waitForAsync(
      page,
      async (row) => (await window.hibi.getDocument()).markdown.includes(row),
      row,
    ).catch(() => {})
    assert.ok((await markdown()).includes(row), await markdown())
  }
  assert.equal(
    await markdown(),
    'before\n\n| n | a | b |\n| :- | - | - |\n| m | cXYZ | d |\n\nafter\n',
  )
})

test('behind the switch, a composition in a table cell goes on through edits from elsewhere that change the columns', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-view-'))
  const file = join(folder, 'notes', 'note.md')
  await mkdir(join(folder, 'notes'))
  await writeFile(file, 'before\n\n| a | b |\n| - | - |\n| c | d |\n\nafter\n')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, 'codemirror')
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await page.locator('.rich-pane .hibi-lp-table').waitFor()
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await page.locator('.mode-side-by-side[data-source-ready="true"]').waitFor()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const candidate = (text) =>
    cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    })
  // Each edit inserts after a text of the note: from the source pane, or
  // without a selection in the formatted view, as an addon's.
  for (const [cell, pane, edits, row] of [
    [
      'td:has-text("c")',
      'source',
      [
        ['before\n\n', '| n '],
        ['| a | b |\n', '| - '],
        ['| - | - |\n', '| m '],
      ],
      '| m | cか | d |',
    ],
    ['th:has-text("a")', 'rich', [['| ak | b |\n| ', ':']], '| n | aか | b |'],
    [
      'td:has-text("d")',
      'rich',
      [
        ['| b |', ' e |'],
        ['| - | - |', ' - |'],
        ['| dk |', ' f |'],
      ],
      '| m | cか | dか | f |',
    ],
  ]) {
    await page.locator(`.rich-pane .hibi-lp-table ${cell}`).click()
    await page.keyboard.press('End')
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
    })
    await candidate('k')
    await page.evaluate(
      ({ pane, edits }) => {
        window.composingCell = document.activeElement
        const view = document.querySelector(`.${pane}-pane .cm-content`).cmTile
          .root.view
        const text = view.state.doc.toString()
        view.dispatch({
          changes: edits.map(([before, insert]) => ({
            from: text.indexOf(before) + before.length,
            insert,
          })),
        })
      },
      { pane, edits },
    )
    const composing = await page.evaluate(async () => {
      for (let frame = 0; frame < 2; frame++)
        await new Promise(requestAnimationFrame)
      return {
        kept: document.activeElement === window.composingCell,
        composing: document.activeElement.cmTile.root.view.composing,
      }
    })
    assert.deepEqual(composing, { kept: true, composing: true }, row)
    await candidate('か')
    await cdp.send('Input.insertText', { text: 'か' })
    await waitForAsync(
      page,
      async (row) => (await window.hibi.getDocument()).markdown.includes(row),
      row,
    ).catch(() => {})
    const { markdown } = await page.evaluate(() => window.hibi.getDocument())
    assert.ok(markdown.includes(row), markdown)
  }
  const { markdown } = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(
    markdown,
    'before\n\n| n | aか | b | e |\n| :- | - | - | - |\n| m | cか | dか | f |\n\nafter\n',
  )
})

// triple-001 in formatted-engine-gaps.md: the rich editor node-selects a
// block it draws as one node, and the formatted view selects its source.
const atoms = {
  html: ['<div>\nhtmlword here\n</div>', 'rawHtmlBlock', 'htmlword'],
  comment: ['<!-- commentword -->', 'rawHtmlBlock', 'commentword'],
  rule: ['***', 'horizontalRule', 'hr, .hibi-lp-rule'],
  image: ['![alt](pic.png)', 'image', 'img[alt="alt"]'],
  math: ['$$\nx^2\n$$', 'blockMath', '[data-type="block-math"]'],
  mermaid: [
    '```mermaid\ngraph TD\n  A --> B\n```',
    'mermaidBlock',
    '.mermaid-block',
  ],
  typst: ['```typst\n= typsthead\n```', 'typstBlock', '.typst-block'],
}
const atomNote = `first words\n\n${Object.values(atoms)
  .map(([source]) => source)
  .join('\n\n')}\n\nlast words\n`

testFormattedEngines(
  'a triple-click on a block drawn as one node selects it, and typed text replaces it',
  {
    timeout: 120000,
  },
  async (t) => {
    const engine = t.formattedEngine
    const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-atoms-'))
    const file = join(folder, 'notes', 'note.md')
    await mkdir(join(folder, 'notes'))
    await mkdir(join(folder, 'profile'))
    await writeFile(file, atomNote)
    // A 40×30 PNG.
    await writeFile(
      join(folder, 'notes', 'pic.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADVQXn+AAAAJklEQVR42u3NMQEAAAgDoK1/aE3hJxQgu1ryAKFQKBQKhUKhUCj8Bg/OH9qw+A0vAAAAAElFTkSuQmCC',
        'base64',
      ),
    )
    await writeFile(
      join(folder, 'profile', 'addons.json'),
      JSON.stringify({ math: true, typst: true }),
    )
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    t.after(async () => {
      await app.close()
      await rm(folder, { recursive: true, force: true })
    })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    await selectFormattedEngine(app, page, engine)
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, file)
    await pressShortcut(app, `${mod}+o`)
    // The addons' blocks draw once they load.
    for (const drawn of [
      '[data-type="block-math"]',
      '.mermaid-block',
      '.typst-block',
    ])
      await page.locator(`.rich-pane ${drawn}`).waitFor()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const markdown = async () =>
      (await page.evaluate(() => window.hibi.getDocument())).markdown
    const settled = (expected) =>
      waitForAsync(
        page,
        async (expected) =>
          (await window.hibi.getDocument()).markdown === expected,
        expected,
        { timeout: 3000 },
      ).catch(() => {})
    /** A point in the block: on its text for HTML, else on its drawing. */
    /** A point in the block, once scrolled to it: on its text for HTML, else on its drawing. */
    const point = (at) =>
      page.evaluate(async (at) => {
        const frames = async () => {
          for (let frame = 0; frame < 3; frame++)
            await new Promise(requestAnimationFrame)
        }
        await frames()
        const root = document.querySelector(
          '.rich-pane [aria-label="Document editor"]',
        )
        const box = (element) => {
          const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
          )
          while (walker.nextNode()) {
            const index = walker.currentNode.data.indexOf(at)
            if (index < 0) continue
            const range = document.createRange()
            range.setStart(walker.currentNode, index + 2)
            range.setEnd(walker.currentNode, index + 3)
            const { left, top, height } = range.getBoundingClientRect()
            return { x: left + 1, y: top + height / 2 }
          }
          return null
        }
        if (/^[a-z]+word$/.test(at)) {
          ;[...root.querySelectorAll('*')]
            .findLast((element) => element.textContent.includes(at))
            .scrollIntoView({ block: 'center' })
          await frames()
          return box(root)
        }
        root.querySelector(at).scrollIntoView({ block: 'center' })
        await frames()
        const { left, top, width, height } = root
          .querySelector(at)
          .getBoundingClientRect()
        return { x: left + Math.min(20, width / 2), y: top + height / 2 }
      }, at)
    const selected = () =>
      page.evaluate(async () => {
        for (let frame = 0; frame < 2; frame++)
          await new Promise(requestAnimationFrame)
        const root = document.querySelector(
          '.rich-pane [aria-label="Document editor"]',
        )
        if (root.editor) return root.editor.state.selection.node?.type.name
        const view = root.cmTile.root.view
        const { from, to } = view.state.selection.main
        return view.state.sliceDoc(from, to)
      })
    for (const [kind, [source, node, at]] of Object.entries(atoms)) {
      await page
        .locator('.rich-pane p, .rich-pane .cm-line', { hasText: 'last words' })
        .last()
        .click()
      const { x, y } = await point(at)
      await page.mouse.click(x, y, { clickCount: 3 })
      assert.equal(await selected(), engine === 'tiptap' ? node : source, kind)
      // Focus leaves the rich editor for a moment after presses on a formula.
      await page.waitForFunction(() =>
        document.activeElement?.matches(
          '.rich-pane [aria-label="Document editor"]',
        ),
      )
      await page.keyboard.type('Z')
      // The rich editor takes no text over a selected rule.
      const replaced =
        engine === 'tiptap' && kind === 'rule'
          ? atomNote
          : atomNote.replace(source, 'Z')
      await settled(replaced)
      assert.equal(await markdown(), replaced, kind)
      await pressShortcut(app, `${mod}+z`)
      await settled(atomNote)
      assert.equal(await markdown(), atomNote, `${kind} undone`)
      // One press on a drawing selects the block as well, and Backspace
      // removes it with the blank line after it. The formatted view shows
      // HTML as editable source, where a press places the caret; the rich
      // editor's press on a formula opens its formula dialog.
      if ((engine === 'tiptap' ? ['math'] : ['html', 'comment']).includes(kind))
        continue
      await page
        .locator('.rich-pane p, .rich-pane .cm-line', { hasText: 'last words' })
        .last()
        .click()
      const press = await point(at)
      await page.mouse.click(press.x, press.y)
      assert.equal(
        await selected(),
        engine === 'tiptap' ? node : source,
        `${kind} pressed`,
      )
      await page.waitForFunction(() =>
        document.activeElement?.matches(
          '.rich-pane [aria-label="Document editor"]',
        ),
      )
      await page.keyboard.press('Backspace')
      const removed =
        engine === 'tiptap' && kind === 'rule'
          ? atomNote
          : atomNote.replace(`${source}\n\n`, '')
      await settled(removed)
      assert.equal(await markdown(), removed, `${kind} removed`)
      await pressShortcut(app, `${mod}+z`)
      await settled(atomNote)
      assert.equal(await markdown(), atomNote, `${kind} restored`)
    }
  },
)
