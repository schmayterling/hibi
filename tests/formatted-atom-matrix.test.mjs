import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { blockMathSyntax } from '../src/addons/math/formatted-syntax.ts'
import { formattedTree } from '../src/renderer/src/formatted-contributions.ts'
import {
  openAtEnd,
  openSelection,
} from '../src/renderer/src/formatted-text-end.ts'
import { sourceFormatting } from '../src/renderer/src/source-formatting.ts'
import { formattedMarkdownParser } from '../src/shared/formatted-markdown.ts'
import { frozenOracle } from './frozen-oracle.mjs'

/*
 * Every toolbar action on every block the view selects whole, in each
 * container. formatted-atom-actions clicks a few of them in the app.
 */
const atoms = {
  divider: '---',
  image: '![old](pic.png)',
  math: '$$\nx^2\n$$',
  html: '<div>\nlast\n</div>',
  comment: '<!-- last -->',
  mermaid: '```mermaid\ngraph TD\n  A --> B\n```',
  typst: '```typst\n= last\n```',
}
const containers = {
  document: (block) => `plain\n\n${block}\n`,
  list: (block) => `plain\n\n- item\n\n  ${block.replaceAll('\n', '\n  ')}\n`,
  quote: (block) =>
    `plain\n\n> quoted\n>\n> ${block.replaceAll('\n', '\n> ')}\n`,
}
const ordered = (block) =>
  `plain\n\n1. item\n\n   ${block.replaceAll('\n', '\n   ')}\n`
const actions = [
  'image',
  'quote',
  'divider',
  'bullet-list',
  'numbered-list',
  'checklist',
  'outdent',
  'table',
  'bold',
  'heading-1',
  'paragraph',
  'code-block',
  'hard-break',
  'unlink',
  'indent',
]
/**
 * What the removed rich view did, recorded before its removal: its toolbar
 * states, and whether its parser read the formatted view's source as the
 * document its own action made.
 */
const rich = frozenOracle('formatted-atom-actions-rich')
const parser = formattedMarkdownParser([blockMathSyntax])

function selectedAtom(source) {
  const tree = (state) => parser.parse(state.doc.toString())
  const target = {
    state: EditorState.create({
      doc: source,
      extensions: [
        formattedTree.of(tree),
        openSelection({ tree, replaced: () => true }),
      ],
    }),
    dom: { isConnected: true },
    dispatch(spec) {
      this.state = this.state.update(spec).state
    },
    focus() {},
  }
  openAtEnd(target)
  return target
}
const snapshot = ({ state }) => ({
  source: state.doc.toString(),
  selected: !state.selection.main.empty,
})
const compare = (key, value) =>
  assert.equal(
    rich({ kind: 'model', key, ...value }),
    true,
    `${key}: ${JSON.stringify(value)}`,
  )

for (const [container, wrap] of Object.entries(containers))
  for (const [kind, block] of Object.entries(atoms))
    test(`toolbar on a selected ${kind} in a ${container}`, () => {
      const source = wrap(block)
      const name = `${container} ${kind}`
      const inspection = sourceFormatting(selectedAtom(source)).inspect()
      const toolbar = rich({ kind: 'native', key: `${name}: toolbar` })
      assert.deepEqual(
        toolbar.map(([id]) => {
          const { disabled, pressed } = inspection.state(id)
          return [id, !disabled, !!pressed]
        }),
        toolbar,
        name,
      )
      for (const action of actions) {
        const target = selectedAtom(source)
        const formatting = sourceFormatting(target)
        // A shortcut reaches run with the action disabled, as a click cannot.
        if (action === 'image')
          assert.ok(
            formatting.capture().insertMarkdown('![pic](assets/pic.png)'),
          )
        else formatting.run(action)
        // atom-list-001: the rich view's numbered-list edit refused the change
        // or kept two-space continuation, so this result is the formatted view's own.
        const numbered = container === 'list' && action === 'numbered-list'
        const key = `${name}: ${action}`
        if (numbered)
          assert.deepEqual(snapshot(target), {
            source: ordered(block),
            selected: true,
          })
        else compare(key, snapshot(target))
        // Typing in a new table goes through its cell editor, in the app.
        if (action === 'table' && container !== 'document') continue
        target.dispatch(target.state.replaceSelection('Z'))
        if (numbered)
          assert.equal(
            rich({
              kind: 'literal',
              key: `${key} then type`,
              source: snapshot(target).source,
            }),
            true,
            key,
          )
        else compare(`${key} then type`, snapshot(target))
      }
    })
