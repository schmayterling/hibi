import assert from 'node:assert/strict'
import test from 'node:test'
import { MarkdownManager } from '@tiptap/markdown'
import { markdownConfiguration } from '../src/renderer/src/markdown.ts'

test('long single-line prose avoids native setext regex stack growth', () => {
  const { parser, options, core, addons } = markdownConfiguration([])
  const manager = new MarkdownManager({
    marked: parser,
    markedOptions: options,
    extensions: [...core, ...addons],
  })
  const text = 'x'.repeat(16 * 1024 * 1024 + 1)
  for (const source of [text, text + '\n\n']) {
    const json = manager.parse(source)
    assert.equal(json.content.length, source === text ? 1 : 2)
    assert.equal(json.content[0].type, 'paragraph')
    assert.equal(json.content[0].content[0].text, text)
  }
})
