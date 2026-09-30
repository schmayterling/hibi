import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  launchBenchmarkApp,
  waitForEditor,
} from '../scripts/benchmark-flows.mjs'

test('failed list indentation keeps focus and task lists match bullet spacing', {
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
  const gaps = await page.locator('.tiptap').evaluate((element) => {
    const editor = element.editor
    return ['bulletList', 'taskList'].map((type) => {
      editor.commands.setContent({
        type: 'doc',
        content: [
          {
            type,
            content: [
              {
                type: type === 'taskList' ? 'taskItem' : 'listItem',
                attrs: { checked: false },
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'item' }],
                  },
                ],
              },
            ],
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
        ],
      })
      const list = element.querySelector('ul')
      return (
        list.nextElementSibling.getBoundingClientRect().top -
        list.querySelector('li p').getBoundingClientRect().bottom
      )
    })
  })
  assert.ok(Math.abs(gaps[0] - gaps[1]) < 1, `list gaps differ: ${gaps}`)
})
