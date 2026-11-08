const { Plugin, editorInfoField, editorLivePreviewField } = require('obsidian')
const { StateField, RangeSetBuilder } = require('@codemirror/state')
const {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
} = require('@codemirror/view')

// Counts document changes; read back through state.field.
const edits = StateField.define({
  create: () => 0,
  update: (value, transaction) => value + (transaction.docChanged ? 1 : 0),
})
const mark = Decoration.mark({ class: 'fixture-todo' })
const todos = (view) => {
  const builder = new RangeSetBuilder()
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to)
    for (const match of text.matchAll(/TODO/g))
      builder.add(from + match.index, from + match.index + 4, mark)
  }
  return builder.finish()
}
const highlight = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = todos(view)
    }
    update(update) {
      if (update.docChanged || update.viewportChanged)
        this.decorations = todos(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)
const insertStamp = (view) => {
  const { from, to } = view.state.selection.main
  view.dispatch({ changes: { from, to, insert: '[stamp]' } })
  return true
}

module.exports = class EditorExtension extends Plugin {
  onload() {
    this.registerEditorExtension([
      edits,
      highlight,
      keymap.of([{ key: 'Mod-Alt-j', run: insertStamp }]),
      EditorView.editorAttributes.of((view) => ({
        'data-fixture-live': String(view.state.field(editorLivePreviewField)),
        'data-fixture-file': String(
          view.state.field(editorInfoField).file?.path ?? '',
        ),
      })),
    ])
  }
}
module.exports.edits = edits
