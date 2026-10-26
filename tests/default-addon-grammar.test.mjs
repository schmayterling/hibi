import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  stopElectronTree,
  waitForDocumentEditor,
} from './electron.mjs'
import { waitForAsync } from './poll.mjs'

// A default-on flavor missing from src/shared/built-in-grammar.ts turns off the
// source outline, plain visual typing and the math paragraph proof for everyone.
const original =
  '# Title\n\n```mermaid\ngraph TD\n# not a heading\n```\n\nneedle word $x$\n\n## Next\n\nelsewhere\n'

async function open(t, addons, source = original) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-default-grammar-'))
  const profile = join(folder, 'profile')
  const file = join(folder, 'note.md')
  await mkdir(profile)
  if (addons)
    await writeFile(join(profile, 'addons.json'), JSON.stringify(addons))
  await writeFile(file, source)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  const watchdog = setTimeout(() => stopElectronTree(app.process()), 55000)
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close().catch(() => {})
    clearTimeout(watchdog)
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'note.md',
  )
  await waitForDocumentEditor(app, page)
  await page.locator('.tiptap .mermaid-block').waitFor()
  return page
}

async function sourceOutline(page, count) {
  await page.getByRole('button', { name: /^source view$/i }).click()
  await page
    .getByRole('textbox', { name: 'Markdown editor', exact: true })
    .waitFor()
  await page.getByRole('button', { name: /^toggle right sidebar$/i }).click()
  await page.getByRole('button', { name: /^right sidebar views$/i }).click()
  await page
    .getByRole('menuitem', { name: 'On this page', exact: true })
    .click()
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll(
        '.outline-sidebar[data-side="right"] [role="treeitem"][id^="right-outline-source:"]',
      ).length === count,
    count,
  )
  return page
    .locator('.outline-sidebar[data-side="right"][data-open="true"]')
    .locator('.sidebar-label')
    .allTextContents()
}

// Typing at the end of the last paragraph parses at most that paragraph when a
// certified fast path exists; otherwise the whole body is parsed as candidates.
async function typedParses(page, text) {
  await page.evaluate(
    () => new Promise((resolve) => requestIdleCallback(resolve)),
  )
  await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.view.focus()
    const parse = editor.markdown.parse.bind(editor.markdown)
    window.grammarParses = []
    editor.markdown.parse = (source) => {
      window.grammarParses.push(source.length)
      return parse(source)
    }
  })
  await page.keyboard.insertText(text)
  await waitForAsync(
    page,
    async (text) =>
      (await window.hibi.getDocument()).markdown.includes(`elsewhere${text}`),
    text,
  )
  return page.evaluate(() => window.grammarParses)
}

test('default addons keep plain visual typing, caret history and the source outline', {
  timeout: 60000,
}, async (t) => {
  const page = await open(t)
  assert.deepEqual(
    await typedParses(page, 's'),
    [],
    'plain visual typing is certified with the default addons',
  )
  const word = await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor
    let from = -1
    editor.state.doc.descendants((node, position) => {
      if (from < 0 && node.isText && node.text.includes('needle'))
        from = position + node.text.indexOf('needle')
    })
    editor.commands.setTextSelection({ from, to: from + 'needle'.length })
    editor.commands.insertContent('pin')
    return { from, to: from + 'needle'.length }
  })
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('pin word'),
  )
  await page.evaluate(() =>
    document.querySelector('.tiptap').editor.commands.undo(),
  )
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('needle word'),
  )
  const selection = await page.evaluate(() => {
    const { from, to } =
      document.querySelector('.tiptap').editor.state.selection
    return { from, to }
  })
  assert.equal(
    selection.to,
    word.to,
    'undo keeps the caret at the restored word',
  )
  assert.deepEqual(await sourceOutline(page, 2), ['Title', 'Next'])
})

test('a quoted diagram keeps the source outline in step with the rich view', {
  timeout: 60000,
}, async (t) => {
  // The quote ends at its diagram, so the next two lines are a setext heading.
  const page = await open(
    t,
    undefined,
    '> ```mermaid\n> graph TD\n> A-->B\n> ```\noutside\n===\n\n# real\n',
  )
  const headings = await page.evaluate(() => {
    const labels = []
    document.querySelector('.tiptap').editor.state.doc.descendants((node) => {
      if (node.type.name === 'heading') labels.push(node.textContent)
    })
    return labels
  })
  assert.deepEqual(headings, ['outside', 'real'])
  assert.deepEqual(await sourceOutline(page, 2), headings)
})

test('default addons keep the math paragraph proof', {
  timeout: 60000,
}, async (t) => {
  const page = await open(t, { math: true })
  assert.equal(
    await page.evaluate(() =>
      Boolean(document.querySelector('.tiptap').editor.schema.nodes.inlineMath),
    ),
    true,
  )
  assert.deepEqual(
    await typedParses(page, '!'),
    ['elsewhere!\n'.length],
    'math paragraph proof is built with the default addons',
  )
})
