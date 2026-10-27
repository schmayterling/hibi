import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import {
  sourceFormatting,
  tableActions,
} from '../src/renderer/src/source-formatting.ts'

/** Run a toolbar action on a view of `doc` with `selection`, and read the result. */
function run(id, doc, selection, extensions = []) {
  const view = {
    state: EditorState.create({ doc, selection, extensions }),
    dispatch(spec) {
      this.state = this.state.update(spec).state
    },
    focus() {},
  }
  assert.equal(sourceFormatting(view).run(id), true)
  const { from, to } = view.state.selection.main
  return { doc: view.state.doc.toString(), from, to }
}

test('views that edit tables in place insert the rich editor table with the caret in its first header cell', () => {
  // Installed by the formatted view's table widgets.
  const cells = tableActions.of({ active: () => false, run: () => false })
  const table = '|  |  |\n| --- | --- |\n|  |  |\n|  |  |'
  assert.deepEqual(run('table', '', { anchor: 0 }, [cells]), {
    doc: `${table}\n\n`,
    from: 2,
    to: 2,
  })
  assert.deepEqual(run('table', 'hello', { anchor: 0, head: 5 }, [cells]), {
    doc: `${table}\n\n`,
    from: 2,
    to: 2,
  })
  assert.deepEqual(run('table', 'before\nafter', { anchor: 6 }, [cells]), {
    doc: `before\n\n${table}\n\nafter`,
    from: 10,
    to: 10,
  })
})

test('the source view keeps its table with header names and the caret after it', () => {
  const table = '| column 1 | column 2 |\n| --- | --- |\n|  |  |'
  assert.deepEqual(run('table', 'before', { anchor: 6 }), {
    doc: `before\n\n${table}\n\n`,
    from: `before\n\n${table}\n\n`.length,
    to: `before\n\n${table}\n\n`.length,
  })
})
