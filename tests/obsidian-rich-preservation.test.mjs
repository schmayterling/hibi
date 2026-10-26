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
import { clickMenu } from './keyboard.mjs'
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
