import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { TreeFragment } from '@lezer/common'
import { GFM, parser } from '@lezer/markdown'
import {
  fenceBodyChanges,
  markedFenceText,
  readFence,
} from '../src/addons/_shared/formatted-fence.ts'
import { ChunkedMarkdownParser } from '../src/renderer/src/chunked-markdown.ts'

const markdown = parser.configure(GFM)
const body = Array.from(
  { length: 10000 },
  (_, i) => `%% body ${i} ${'x'.repeat(16)}`,
)

function fenceNode(tree) {
  let node
  tree.iterate({
    enter(ref) {
      if (ref.name === 'FencedCode' && !node) node = ref.node
    },
  })
  assert.ok(node)
  return node
}

for (const [label, open, prefix] of [
  ['list', '- ', '  '],
  ['quote', '> ', '> '],
  ['quote in list', '- parent\n\n  > ', '  > '],
  ['list in quote', '> - ', '>   '],
]) {
  test(`a long fence in a ${label} keeps its closing bounds across windows`, () => {
    for (const opaque of [false, true]) {
      const text = `Intro.\n\n${open}~~~mermaid\n${prefix}graph TD\n${body.map((line) => prefix + line).join('\n')}\n${prefix}~~~\n\nAfter.\n`
      const state = EditorState.create({ doc: text })
      const probe = {
        parsedChunks: 0,
        parsedUnits: 0,
        scannedUnits: 0,
        reusedNodes: 0,
        builtGroups: 0,
      }
      const chunked = new ChunkedMarkdownParser(markdown, markdown, {
        probe,
        ...(opaque ? { opaque: new Set(['FencedCode']) } : {}),
      })
      const input = {
        length: text.length,
        lineChunks: false,
        chunk: (from) => text.slice(from),
        read: (from, to) => text.slice(from, to),
      }
      const exact = fenceNode(markdown.parse(text))
      const expected = `graph TD\n${body.join('\n')}`
      let tree
      for (const position of [
        text.length - 1000,
        0,
        Math.floor(text.length / 2),
        text.length - 1000,
        0,
      ]) {
        const scans = probe.scannedUnits
        const parse = chunked.startChunkedParse(
          input,
          tree ? TreeFragment.addTree(tree) : [],
          { from: position, to: Math.min(text.length, position + 1000) },
        )
        let maximumStep = 0
        for (;;) {
          const before = probe.parsedUnits + probe.scannedUnits
          const done = parse.advance()
          maximumStep = Math.max(
            maximumStep,
            probe.parsedUnits + probe.scannedUnits - before,
          )
          if (done) {
            tree = done
            break
          }
        }
        const node = fenceNode(tree)
        const detail = JSON.stringify({ label, opaque, position, maximumStep })
        assert.ok(maximumStep < 2 * 65536 + 8192, detail)
        assert.equal(node.from, exact.from, detail)
        assert.equal(node.to, exact.to, detail)
        assert.equal(node.lastChild.name, 'CodeMark', detail)
        assert.equal(node.lastChild.from, exact.lastChild.from, detail)
        assert.ok(node.getChildren('CodeText').length < body.length, detail)
        const fence = readFence(state.doc, node)
        assert.ok(fence, detail)
        assert.equal(markedFenceText(fence), expected, detail)
        if (position === 0) assert.equal(probe.scannedUnits, scans, detail)
      }
      // Editing through the sparse tree must stop before the original closing line.
      const node = fenceNode(tree)
      const fence = readFence(state.doc, node)
      const changes = fenceBodyChanges(
        state.doc,
        node,
        `${expected}\n%% appended`,
        { indent: fence.indent, indented: true },
      )
      const edited = state.update({ changes })
      const closing = state.doc.lineAt(node.to).from
      assert.equal(
        edited.state.doc.toString(),
        `${text.slice(0, closing)}${prefix}%% appended\n${text.slice(closing)}`,
      )
      assert.equal(
        edited.changes.invert(state.doc).apply(edited.state.doc).toString(),
        text,
      )
    }
  })
}
