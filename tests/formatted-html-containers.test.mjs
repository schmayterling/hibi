import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { parser } from '@lezer/markdown'
import { ChunkedMarkdownParser } from '../src/renderer/src/chunked-markdown.ts'
import { formattedSyntax } from '../src/renderer/src/formatted-syntax.ts'
import { boundaryParser } from '../src/shared/markdown-boundary-syntax.ts'
import { ContainerHTML } from '../src/shared/markdown-html-syntax.ts'

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
test('crlf blank lines also end html in list-only and top-level containers', () => {
  for (const doc of [
    '<div>\r\nraw\r\n</div>\r\n\r\nafter\r\n',
    '- before\r\n\r\n  <div>\r\n  raw\r\n  </div>\r\n  \r\n  after\r\n',
  ]) {
    const parsed = worker().parse(doc)
    const container = doc.startsWith('-')
      ? parsed.topNode.firstChild.firstChild
      : parsed.topNode
    assert.equal(container.lastChild.name, 'Paragraph', doc)
    assert.equal(
      doc.slice(container.lastChild.from, container.lastChild.to).trim(),
      'after',
    )
  }
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
  const lazy = '> <div>\nlazy\n'
  const exit = worker().parse(lazy).topNode
  assert.equal(exit.firstChild.name, 'Blockquote')
  assert.equal(exit.firstChild.lastChild.name, 'HTMLBlock')
  assert.equal(exit.lastChild.name, 'Paragraph')
  assert.equal(lazy.slice(exit.lastChild.from, exit.lastChild.to), 'lazy')
  const escaped = '> <div>\n> html\n\noutside\n'
  assert.equal(
    worker().parse(escaped).toString(),
    parser.parse(escaped).toString(),
  )
})

test('html opener classification skips inline scans in wide quoted paragraphs', () => {
  const measure = (mib) => {
    const line = {
      next: 60,
      indent: 0,
      baseIndent: 0,
      pos: 2,
      text:
        '> <span>' +
        'text '.repeat(Math.ceil((mib * 1024 * 1024) / 5)) +
        '</span>',
    }
    const cx = {
      depth: 2,
      parentType: (depth) => ({
        name: depth === 1 ? 'Blockquote' : 'Document',
      }),
    }
    const original = String.prototype.charCodeAt
    let calls = 0
    try {
      String.prototype.charCodeAt = function (...args) {
        if (++calls > 4096)
          throw new Error('html opener classification walked inline content')
        return original.apply(this, args)
      }
      assert.equal(ContainerHTML.parseBlock[0].parse(cx, line), false)
    } finally {
      String.prototype.charCodeAt = original
    }
    return calls
  }
  const small = measure(2),
    large = measure(50)
  console.log(JSON.stringify({ classificationCharacters: { small, large } }))
  assert.equal(large, small)
  assert.ok(large < 4096)
})

test('a 50 mib quoted html block advances through bounded source ranges', () => {
  const measure = (length) => {
    const head = '> <div>\n',
      unit = '> html line\n'
    let reads = 0,
      widest = 0
    const read = (from, to) => {
      reads += to - from
      widest = Math.max(widest, to - from)
      let text = ''
      if (from < head.length) {
        text = head.slice(from, Math.min(to, head.length))
        from = head.length
      }
      if (from < to) {
        const offset = (from - head.length) % unit.length
        text += unit
          .repeat(Math.ceil((to - from + offset) / unit.length))
          .slice(offset, offset + to - from)
      }
      return text
    }
    const md = worker()
    const parse = new ChunkedMarkdownParser(md, md, {
      chunkSize: 1024,
      giantBlock: 4096,
    }).startChunkedParse(
      {
        length,
        lineChunks: false,
        read,
        chunk: (from) => read(from, Math.min(length, from + unit.length)),
      },
      [],
      { from: 0, to: 1024 },
    )
    let result = null,
      largest = 0
    for (let i = 0; i < 32 && !result; i++) {
      const before = reads
      result = parse.advance()
      largest = Math.max(largest, reads - before)
    }
    assert.ok(result)
    assert.ok(widest <= 16 * 1024, String(widest))
    return { reads, largest, widest }
  }
  const small = measure(2 * 1024 * 1024),
    large = measure(50 * 1024 * 1024)
  console.log(JSON.stringify({ small, large }))
  assert.deepEqual(large, small)
})
