import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { getSchema } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import { preserveRichSource } from '../src/renderer/src/rich-source-preservation.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('rich block insertion keeps CRLF and untouched Markdown', () => {
  const extensions = [StarterKit.configure({ trailingNode: false })]
  const schema = getSchema(extensions)
  const manager = new MarkdownManager({ extensions })
  const source = '# top\r\n\r\n## next\r\n'
  const before = schema.nodeFromJSON(manager.parse(source))
  const after = schema.nodes.doc.create(null, [
    schema.nodes.heading.create({ level: 1 }, schema.text('replacement')),
    ...before.content.content,
  ])
  assert.equal(
    preserveRichSource(
      source,
      manager.serialize(before.toJSON()),
      manager.serialize(after.toJSON()),
      (candidate) => schema.nodeFromJSON(manager.parse(candidate)).eq(after),
    ),
    `# replacement\r\n\r\n${source}`,
  )
})

for (const math of [false, true]) {
  test(`math enabled preserves source in a document ${math ? 'with' : 'without'} equations`, {
    timeout: 30000,
  }, async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'hibi-math-preservation-'))
    const profile = join(folder, 'profile')
    const file = join(folder, 'note.md')
    const equations = math
      ? `${'day\n\n'.repeat(40)}$x$\n\n$$y$$\n\n$$\nz\n$$\n\n`
      : ''
    const original = (
      '---\ntitle: "keep"\n---\n\nheading\n=======\n\n***\n\n_em_\n\n' +
      equations +
      'elsewhere\n'
    ).replaceAll('\n', '\r\n')
    await mkdir(profile)
    await writeFile(
      join(profile, 'addons.json'),
      JSON.stringify({ math: true }),
    )
    await writeFile(file, original)
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`, file],
    })
    t.after(async () => {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      await app.close()
      await rm(folder, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    await waitForAsync(
      page,
      async () =>
        !!window.hibi && (await window.hibi.getDocument()).name === 'note.md',
    )
    await waitForDocumentEditor(app, page)
    assert.equal(
      await page.evaluate(() =>
        Boolean(
          document.querySelector('.tiptap').editor.schema.nodes.inlineMath,
        ),
      ),
      true,
    )
    await page.evaluate(
      () => new Promise((resolve) => requestIdleCallback(resolve)),
    )
    await page.evaluate(() => {
      const editor = document.querySelector('.tiptap').editor
      editor.commands.setTextSelection(editor.state.doc.content.size - 1)
      editor.view.focus()
      const parse = editor.markdown.parse.bind(editor.markdown)
      window.preservationParses = []
      editor.markdown.parse = (source) => {
        window.preservationParses.push(source.length)
        return parse(source)
      }
    })
    await page.keyboard.insertText('!')
    await waitForAsync(page, async () =>
      (await window.hibi.getDocument()).markdown.includes('elsewhere!'),
    )
    async function saveExpected(expected, savedFile = file) {
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).markdown,
        expected,
      )
      await clickMenu(app, 'Save')
      await waitForAsync(
        page,
        async () => !(await window.hibi.getDocument()).dirty,
      )
      assert.equal(await readFile(savedFile, 'utf8'), expected)
      await waitForDocumentEditor(app, page)
    }
    const parses = await page.evaluate(() => window.preservationParses)
    assert.ok(
      parses.length <= 8,
      `candidate parse cap exceeded: ${parses.length}`,
    )
    assert.deepEqual(parses, ['elsewhere!\n'.length])
    let expected = original.replace('elsewhere', 'elsewhere!')
    await saveExpected(expected)
    const undoParses = await page.evaluate(() => {
      window.preservationParses = []
      document.querySelector('.tiptap').editor.commands.undo()
      return window.preservationParses.length
    })
    assert.ok(undoParses <= 8, 'undo must not rebuild paragraph proofs inline')
    await waitForAsync(
      page,
      async (original) =>
        (await window.hibi.getDocument()).markdown === original,
      original,
    )
    await saveExpected(original)
    await page.evaluate(() =>
      document.querySelector('.tiptap').editor.commands.redo(),
    )
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      expected,
    )
    await saveExpected(expected)
    for (const [type, latex] of math
      ? [
          ['inlineMath', 'x'],
          ['blockMath', 'y'],
        ]
      : []) {
      assert.equal(
        await page.evaluate(
          ({ type, latex }) => {
            const editor = document.querySelector('.tiptap').editor
            let position = -1
            editor.state.doc.descendants((node, pos) => {
              if (node.type.name === type && node.attrs.latex === latex)
                position = pos
            })
            if (position < 0) return false
            const command =
              type === 'inlineMath' ? 'updateInlineMath' : 'updateBlockMath'
            return editor.commands[command]({
              pos: position,
              latex: `${latex}^2`,
            })
          },
          { type, latex },
        ),
        true,
      )
      expected = expected.replace(`$${latex}$`, `$${latex}^2$`)
      await waitForAsync(
        page,
        async (latex) =>
          (await window.hibi.getDocument()).markdown.includes(`${latex}^2`),
        latex,
      )
      await saveExpected(expected)
    }
    const crlfFile = join(folder, 'crlf.md')
    await writeFile(crlfFile, 'p\r\n\r\nq')
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, crlfFile)
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).name === 'crlf.md',
    )
    await waitForDocumentEditor(app, page)
    assert.equal(
      await page.evaluate(
        () => document.querySelector('.tiptap').editor.state.doc.textContent,
      ),
      'pq',
    )
    await page.evaluate(
      () => new Promise((resolve) => requestIdleCallback(resolve)),
    )
    await page.evaluate(() => {
      const editor = document.querySelector('.tiptap').editor
      editor.commands.setTextSelection(editor.state.doc.content.size - 1)
      editor.view.focus()
      const parse = editor.markdown.parse.bind(editor.markdown)
      window.crlfParses = []
      editor.markdown.parse = (source) => {
        window.crlfParses.push(source)
        return parse(source)
      }
    })
    await page.keyboard.insertText('q')
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).markdown === 'p\r\n\r\nqq',
    )
    assert.deepEqual(
      await page.evaluate(() => window.crlfParses),
      ['qq'],
      'the CRLF edit must parse only its local paragraph',
    )
    await saveExpected('p\r\n\r\nqq', crlfFile)
  })
}

test('rich edits and autosave preserve untouched Obsidian syntax', {
  timeout: 30000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-obsidian-rich-'))
  const file = join(folder, 'note.md')
  const spacing = 'Spacing: one&nbsp;two and three\u00a0four.'
  const entities =
    'Entities: &copy; &#169; &#xA9; &#38;lt; &amp;copy; and `&copy;`.'
  const original =
    '# Notes\n\n> [!tip] Keep this callout.\n\n[[assets/some.svg]]\n\n- [ ] pending\n\n' +
    `${spacing}\n\n${entities}` +
    '\n\n&nbsp;\n\na\nb\n\nSource: keep this text.\n'
  await writeFile(file, original)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const rich = page.getByRole('textbox', { name: 'Document editor' })
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem(
      'hibi:autosave',
      JSON.stringify({ enabled: true, delay: 1000 }),
    ),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await clickMenu(app, 'Open…')
  await page.getByRole('tab', { name: 'note.md' }).waitFor()
  await rich.getByText('Source: keep this text.').waitFor()
  await waitForDocumentEditor(app, page)
  const loaded = await rich.evaluate((element) => ({
    text: element.textContent,
    serialized: element.editor.getMarkdown(),
  }))
  assert.ok(loaded.text.includes('Spacing: one\u00a0two and three\u00a0four.'))
  assert.ok(
    loaded.serialized.includes('Spacing: one\u00a0two and three\u00a0four.'),
  )
  assert.ok(loaded.serialized.includes('\n\n&nbsp;\n\n'))
  assert.ok(loaded.text.includes('Entities: © © © &lt; &copy; and &copy;.'))
  assert.ok(
    loaded.serialized.includes(
      'Entities: © © © &amp;lt; &amp;copy; and `&copy;`.',
    ),
  )
  await rich.getByText('Source: keep this text.').click()
  await page.keyboard.press('Enter')
  await waitForAsync(page, async () => (await window.hibi.getDocument()).dirty)
  const changed = (await page.evaluate(() => window.hibi.getDocument()))
    .markdown
  assert.match(changed, /\[\[assets\/some\.svg\]\]/)
  assert.match(changed, /> \[!tip\] Keep this callout\./)
  assert.ok(changed.includes(spacing))
  assert.ok(changed.includes(entities))
  assert.ok(changed.includes('\n\na\nb\n\n'))
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), changed)

  await rich.getByRole('checkbox').check()
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('- [x] pending'),
  )
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  const checked = await readFile(file, 'utf8')
  assert.ok(checked.includes(spacing))
  assert.ok(checked.includes(entities))
  assert.ok(checked.includes('\n\n&nbsp;\n\n'))
  assert.ok(checked.includes('\n\na\nb\n\n'))
  assert.match(checked, /- \[x\] pending/)
  assert.match(checked, /\[\[assets\/some\.svg\]\]/)
  assert.match(checked, /> \[!tip\] Keep this callout\./)
})

async function openFormattedPreservation(t, original, addons = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-cm-preservation-'))
  const file = join(folder, 'note.md')
  const profile = join(folder, 'profile')
  await mkdir(profile)
  await writeFile(join(profile, 'addons.json'), JSON.stringify(addons))
  await writeFile(file, original)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const rich = await selectFormattedEngine(app, page, 'codemirror')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const expected = async (text) => {
    try {
      await waitForAsync(
        page,
        async (text) => (await window.hibi.getDocument()).markdown === text,
        text,
      )
    } catch (error) {
      const actual = (await page.evaluate(() => window.hibi.getDocument()))
        .markdown
      let at = 0
      while (at < text.length && text[at] === actual[at]) at++
      t.diagnostic(
        JSON.stringify({
          expectedLength: text.length,
          actualLength: actual.length,
          at,
          expected: text.slice(Math.max(0, at - 60), at + 120),
          actual: actual.slice(Math.max(0, at - 60), at + 120),
          input: await rich.evaluate((element) => ({
            selection: element.cmTile.root.view.state.selection.toJSON(),
            focused: document.activeElement?.getAttribute('aria-label'),
            editable: element.isContentEditable,
          })),
        }),
      )
      throw error
    }
  }
  const caret = (at) =>
    rich.evaluate((element, at) => {
      const view = element.cmTile.root.view
      view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
      view.focus()
    }, at)
  const save = async (text, path = file) => {
    await expected(text)
    await clickMenu(app, 'Save')
    await waitForAsync(
      page,
      async () => !(await window.hibi.getDocument()).dirty,
    )
    assert.equal(await readFile(path, 'utf8'), text)
    await waitForDocumentEditor(app, page)
  }
  await expected(original)
  return { app, page, rich, file, folder, cdp, expected, caret, save }
}

test('codemirror: native block insertion keeps CRLF and untouched Markdown', {
  timeout: 30000,
}, async (t) => {
  const original = '# top\r\n\r\n## next\r\n'
  const { app, page, rich, cdp, caret, save, expected } =
    await openFormattedPreservation(t, original)
  await caret(0)
  await page.keyboard.insertText('# replacement\n\n')
  const changed = '# replacement\r\n\r\n' + original
  await save(changed)
  assert.equal(
    await rich.locator('.hibi-lp-h1', { hasText: 'replacement' }).count(),
    1,
  )
  await rich.focus()
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`,
  )
  await expected(original)
  await save(original)
  await cdp.detach()
})

for (const math of [false, true]) {
  test(`codemirror: math enabled preserves exact source ${math ? 'with' : 'without'} equations through editing and undo`, {
    timeout: 45000,
  }, async (t) => {
    const equations = math
      ? `${'day\n\n'.repeat(40)}$x$\n\n$$y$$\n\n$$\nz\n$$\n\n`
      : ''
    const original = (
      '---\ntitle: "keep"\n---\n\nheading\n=======\n\n***\n\n_em_\n\n' +
      equations +
      'elsewhere\n'
    ).replaceAll('\n', '\r\n')
    const { app, page, rich, file, folder, cdp, expected, caret, save } =
      await openFormattedPreservation(t, original, { math: true })
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    const normalized = original.replaceAll('\r\n', '\n')
    await caret(normalized.lastIndexOf('elsewhere') + 'elsewhere'.length)
    await page.keyboard.insertText('!')
    let changed = original.replace('elsewhere', 'elsewhere!')
    await save(changed)
    assert.equal(
      await rich.locator('.cm-line', { hasText: 'elsewhere!' }).count(),
      1,
    )
    await rich.focus()
    await pressShortcut(app, `${mod}+z`)
    await save(original)
    await rich.focus()
    await pressShortcut(app, `${mod}+Shift+z`)
    await save(changed)
    for (const [latex, marker, type] of math
      ? [
          ['x', '$x$', 'inline-math'],
          ['y', '$$y$$', 'block-math'],
        ]
      : []) {
      const before = changed
      const text = changed.replaceAll('\r\n', '\n')
      const from = text.indexOf(marker) + marker.indexOf(latex) + latex.length
      await caret(from)
      await page.keyboard.insertText('^2')
      changed = changed.replace(marker, () =>
        marker.replace(latex, `${latex}^2`),
      )
      await save(changed)
      await caret(changed.replaceAll('\r\n', '\n').lastIndexOf('elsewhere'))
      await rich
        .locator(`[data-type="${type}"][data-latex="${latex}^2"] .katex`)
        .waitFor()
      await pressShortcut(app, `${mod}+z`)
      await expected(before)
      await pressShortcut(app, `${mod}+Shift+z`)
      await expected(changed)
    }
    await save(changed, file)
    const crlfFile = join(folder, 'crlf.md')
    await writeFile(crlfFile, 'p\r\n\r\nq')
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, crlfFile)
    await clickMenu(app, 'Open…')
    await expected('p\r\n\r\nq')
    await waitForDocumentEditor(app, page)
    await caret(4)
    await page.keyboard.insertText('q')
    await save('p\r\n\r\nqq', crlfFile)
    assert.equal(await rich.locator('.cm-line', { hasText: /^qq$/ }).count(), 1)
    await cdp.detach()
  })
}

test('codemirror: formatted edits and autosave preserve exact Obsidian syntax and entities', {
  timeout: 45000,
}, async (t) => {
  const spacing = 'Spacing: one&nbsp;two and three\u00a0four.'
  const entities =
    'Entities: &copy; &#169; &#xA9; &#38;lt; &amp;copy; and `&copy;`.'
  const original =
    '# Notes\n\n> [!tip] Keep this callout.\n\n[[assets/some.svg]]\n\n- [ ] pending\n\n' +
    `${spacing}\n\n${entities}` +
    '\n\n&nbsp;\n\na\nb\n\nSource: keep this text.\n'
  const { app, page, rich, file, cdp, expected, caret } =
    await openFormattedPreservation(t, original)
  await page.evaluate(() => {
    localStorage.setItem(
      'hibi:autosave',
      JSON.stringify({ enabled: true, delay: 1000 }),
    )
    localStorage.setItem('markdown-markers', 'false')
  })
  await page.reload()
  await waitForDocumentEditor(app, page)
  await expected(original)
  await rich
    .locator('.cm-line', { hasText: 'Source: keep this text.' })
    .waitFor()
  const visible = await rich.innerText()
  assert.ok(visible.includes('Spacing: one\u00a0two and three\u00a0four.'))
  assert.ok(visible.includes('Entities: © © © &lt; &copy; and &copy;.'))
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await caret(original.indexOf('Source:') + 'Source: keep this text.'.length)
  await page.keyboard.press('Enter')
  const changed = original.replace(
    'Source: keep this text.',
    'Source: keep this text.\n\n',
  )
  await expected(changed)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), changed)
  await pressShortcut(app, `${mod}+z`)
  await expected(original)
  await pressShortcut(app, `${mod}+Shift+z`)
  await expected(changed)
  await rich.getByRole('checkbox').check()
  const checked = changed.replace('- [ ] pending', '- [x] pending')
  await expected(checked)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), checked)
  await rich.focus()
  await pressShortcut(app, `${mod}+z`)
  await expected(changed)
  await pressShortcut(app, `${mod}+Shift+z`)
  await expected(checked)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), checked)
  await page.reload()
  await waitForDocumentEditor(app, page)
  await expected(checked)
  assert.equal(await rich.getByRole('checkbox').isChecked(), true)
  assert.ok(
    (await rich.innerText()).includes(
      'Entities: © © © &lt; &copy; and &copy;.',
    ),
  )
  await cdp.detach()
})
