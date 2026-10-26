import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { parser } from '@lezer/markdown'
import { formattedSyntax } from '../src/renderer/src/formatted-syntax.ts'
import { boundaryParser } from '../src/shared/markdown-boundary-syntax.ts'

const html = '<div>\nhtml line\n</div>'
const quote = (text) =>
  text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')
const names = (node) =>
  node.getChildren('HTMLBlock').length &&
  Array.from(
    (function* () {
      for (let child = node.firstChild; child; child = child.nextSibling)
        if (child.type.is('Block')) yield child.name
    })(),
  )
const worker = () =>
  boundaryParser({
    schema: 1,
    syntax: [],
    flavors: [],
    literal: [],
    opaque: [],
    prefix: 0,
    chunkSize: 4096,
    groupSize: 64,
    giantBlock: 65536,
  })
function tree(doc) {
  const syntax = formattedSyntax({ slice: 1000 })
  const state = EditorState.create({ doc, extensions: syntax.extension })
  return syntax.tree(state)
}
test('blank container lines end html before later paragraphs and lists in both parsers', () => {
  for (const opening of [
    html,
    '<custom-tag>\nhtml line\n</custom-tag>',
    '<div',
  ]) {
    for (const eol of ['\n', '\r\n']) {
      const doc = (
        quote(`${opening}\n\nafter paragraph\n\n- quoted item`) + '\n'
      ).replaceAll('\n', eol)
      for (const parsed of [tree(doc), worker().parse(doc)]) {
        const container = parsed.topNode.firstChild
        assert.deepEqual(
          names(container),
          ['HTMLBlock', 'Paragraph', 'BulletList'],
          doc,
        )
        const block = container.getChild('HTMLBlock')
        assert.equal(
          doc.slice(block.from, block.to).includes('after paragraph'),
          false,
        )
      }
    }
  }
})
test('html in list quotes ends on a marker-only line and stays within its container', () => {
  const doc =
    '- parent\n\n  > <div>\n  > html\n  > </div>\n  >\n  > after\n\noutside\n'
  const parsed = worker().parse(doc)
  const item = parsed.topNode.firstChild.firstChild
  const container = item.getChild('Blockquote')
  assert.deepEqual(names(container), ['HTMLBlock', 'Paragraph'])
  assert.equal(parsed.topNode.lastChild.name, 'Paragraph')
  assert.equal(
    doc.slice(parsed.topNode.lastChild.from, parsed.topNode.lastChild.to),
    'outside',
  )
})
test('raw html terminators keep their semantics, including blank lines and container exits', () => {
  for (const raw of [
    '<script>\n\ncode\n</script>',
    '<pre>\n\ncode\n</pre>',
    '<!-- comment\n\nend -->',
    '<?php\n\nend ?>',
    '<![CDATA[\n\nend ]]>',
  ]) {
    const doc = `${quote(raw)}\n>\n> after\n\noutside\n`
    const parsed = worker().parse(doc)
    const original = parser.parse(doc)
    assert.equal(parsed.toString(), original.toString(), raw)
  }
  const escaped = '> <div>\n> html\n\noutside\n'
  assert.equal(
    worker().parse(escaped).toString(),
    parser.parse(escaped).toString(),
  )
})
