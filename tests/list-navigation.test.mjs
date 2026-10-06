import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  launchBenchmarkApp,
  waitForEditor,
} from '../scripts/benchmark-flows.mjs'

test('failed list indentation keeps focus and lists keep one spacing rhythm', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-list-navigation-'))
  const app = await launchBenchmarkApp(profile)
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForEditor(page)
  for (const type of ['bulletList', 'taskList']) {
    await page.locator('.tiptap').evaluate((element, type) => {
      const editor = element.editor
      editor.commands.setContent({
        type: 'doc',
        content: [
          {
            type,
            content: ['one', 'two'].map((text) => ({
              type: type === 'taskList' ? 'taskItem' : 'listItem',
              attrs: { checked: false },
              content: [
                { type: 'paragraph', content: [{ type: 'text', text }] },
              ],
            })),
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
        ],
      })
      editor.state.doc.descendants((node, position) => {
        if (node.isText && node.text === 'two')
          editor.commands.setTextSelection(position + 1)
      })
      editor.view.focus()
    }, type)
    await page.keyboard.press('Tab')
    assert.equal(
      await page.locator('.tiptap ul ul').count(),
      1,
      `${type}: first Tab indents`,
    )
    const indented = await page
      .locator('.tiptap')
      .evaluate((el) => el.editor.getJSON())
    await page.keyboard.press('Tab')
    assert.deepEqual(
      await page.locator('.tiptap').evaluate((el) => el.editor.getJSON()),
      indented,
    )
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.classList.contains('tiptap'),
      ),
      true,
      `${type}: second Tab keeps editor focus`,
    )
  }
  const spacing = await page.locator('.tiptap').evaluate((element) => {
    const editor = element.editor
    return ['-', '- [ ]'].map((marker) => {
      editor.commands.setContent(
        [
          'before',
          'after',
          `${marker} one\n${marker} two\n\n  second\n${marker} three\n  ${marker} nested`,
          `${marker} code\n\n  \`\`\`\n  x\n  \`\`\`\n${marker} quote\n\n  > quoted\n${marker} last`,
          'end',
        ].join('\n\n'),
        { contentType: 'markdown' },
      )
      const box = (text) =>
        [...element.querySelectorAll('p, pre')]
          .find((block) => block.textContent === text)
          .getBoundingClientRect()
      const gap = (from, to) => Math.round(box(to).top - box(from).bottom)
      return {
        paragraph: gap('before', 'after'),
        intoList: gap('after', 'one'),
        withinItem: gap('two', 'second'),
        outOfList: gap('last', 'end'),
        item: gap('one', 'two'),
        nested: gap('three', 'nested'),
        afterCode: gap('x', 'quote'),
        afterQuote: gap('quoted', 'last'),
      }
    })
  })
  for (const gaps of spacing) {
    const { paragraph, item } = gaps
    assert.ok(item > 0 && item < paragraph, JSON.stringify(gaps))
    assert.deepEqual(gaps, {
      paragraph,
      intoList: paragraph,
      withinItem: paragraph,
      outOfList: paragraph,
      item,
      nested: item,
      afterCode: item,
      afterQuote: item,
    })
  }
  assert.deepEqual(spacing[1], spacing[0], 'task lists match bullet lists')
})
