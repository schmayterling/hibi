import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  await writeFile(join(profile, 'addons.json'), JSON.stringify({ typst: true }))
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
  const spacing = []
  for (const marker of ['-', '- [ ]']) {
    await page.locator('.tiptap').evaluate(
      (element, markdown) => {
        element.editor.commands.setContent(markdown, {
          contentType: 'markdown',
        })
      },
      [
        'before',
        'after',
        `${marker} one\n${marker} two\n\n  second\n${marker} three\n  ${marker} nested`,
        `${marker} code\n\n  \`\`\`\n  x\n  \`\`\`\n${marker} quote\n\n  > quoted\n${marker} table\n\n  | a |\n  | - |\n  | 1 |\n${marker} typst\n\n  \`\`\`typst\n  = Hi\n  \`\`\`\n${marker} last`,
        'end',
      ].join('\n\n'),
    )
    await page.locator('.tiptap .typst-block').waitFor()
    spacing.push(
      await page.locator('.tiptap').evaluate((element) => {
        const box = (target) =>
          (typeof target === 'string'
            ? [...element.querySelectorAll('p, pre')].find(
                (block) => block.textContent === target,
              )
            : target
          ).getBoundingClientRect()
        const gap = (from, to) => Math.round(box(to).top - box(from).bottom)
        const table = element.querySelector('table')
        const typst = element.querySelector('.typst-block')
        return {
          paragraph: gap('before', 'after'),
          intoList: gap('after', 'one'),
          withinItem: gap('two', 'second'),
          outOfList: gap('last', 'end'),
          item: gap('one', 'two'),
          nested: gap('three', 'nested'),
          afterCode: gap('x', 'quote'),
          afterQuote: gap('quoted', 'table'),
          intoTable: gap('table', table),
          afterTable: gap(table, 'typst'),
          intoTypst: gap('typst', typst),
          afterTypst: gap(typst, 'last'),
        }
      }),
    )
  }
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
      intoTable: paragraph,
      afterTable: item,
      intoTypst: paragraph,
      afterTypst: item,
    })
  }
  assert.deepEqual(spacing[1], spacing[0], 'task lists match bullet lists')
})
