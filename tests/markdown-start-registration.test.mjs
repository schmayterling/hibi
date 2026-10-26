import assert from 'node:assert/strict'
import test from 'node:test'
import { getSchema } from '@tiptap/core'
import { BlockMath } from '@tiptap/extension-mathematics'
import { MarkdownManager } from '@tiptap/markdown'
import { blockMath } from '../src/addons/math/syntax.ts'
import { markdownConfiguration } from '../src/renderer/src/markdown.ts'

function fixture(duplicate) {
  let calls = 0
  const start = () => {
    calls++
    return -1
  }
  const flavor = {
    id: 'math.latex',
    richExtensions: [
      BlockMath.extend({
        markdownTokenizer: {
          name: 'blockMath',
          level: 'block',
          start,
          tokenize: blockMath,
        },
      }),
    ],
    ...(duplicate
      ? {
          export: {
            extensions: [
              {
                extensions: [
                  {
                    name: 'blockMath',
                    level: 'block',
                    start,
                    tokenizer: blockMath,
                  },
                ],
              },
            ],
          },
        }
      : {}),
  }
  const { core, addons, parser, options } = markdownConfiguration([flavor])
  const extensions = [...core, ...addons]
  return {
    manager: new MarkdownManager({
      extensions,
      marked: parser,
      markedOptions: options,
    }),
    schema: getSchema(extensions),
    calls: () => calls,
  }
}

test('native and export registrations share one pure start hint without changing schema output', () => {
  const duplicate = fixture(true)
  const reference = fixture(false)
  const source = 'ordinary paragraph\n\n'.repeat(128)
  assert.deepEqual(
    duplicate.manager.parse(source),
    reference.manager.parse(source),
  )
  assert.equal(duplicate.calls(), reference.calls())
  assert.equal(duplicate.calls(), 128)
  for (const source of [
    '$$\nx+y\n$$\n\nordinary',
    '# heading\n\nordinary',
    '~~~\ncode\n~~~\n\nordinary',
  ]) {
    const actual = duplicate.schema.nodeFromJSON(
      duplicate.manager.parse(source),
    )
    const expected = reference.schema.nodeFromJSON(
      reference.manager.parse(source),
    )
    actual.check()
    expected.check()
    assert.deepEqual(actual.toJSON(), expected.toJSON())
  }
})
