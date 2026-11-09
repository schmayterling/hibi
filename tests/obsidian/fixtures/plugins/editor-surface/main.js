const {
  Plugin,
  MarkdownRenderChild,
  MarkdownRenderer,
  editorInfoField,
  editorLivePreviewField,
} = require('obsidian')
const { RangeSetBuilder, StateField } = require('@codemirror/state')
const {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
} = require('@codemirror/view')

const fixture = { sections: [], paths: [], unloaded: 0 }
window.__hibiEditorFixture = fixture

const changes = StateField.define({
  create: () => 0,
  update: (value, transaction) => value + (transaction.docChanged ? 1 : 0),
})
const todo = Decoration.mark({ class: 'fixture-todo' })
const marks = (view) => {
  const builder = new RangeSetBuilder()
  for (const { from, to } of view.visibleRanges)
    for (const match of view.state.sliceDoc(from, to).matchAll(/TODO/g))
      builder.add(from + match.index, from + match.index + 4, todo)
  return builder.finish()
}
const todos = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = marks(view)
    }
    update(update) {
      if (update.docChanged || update.viewportChanged)
        this.decorations = marks(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)
const stamp = (view) => {
  const { from, to } = view.state.selection.main
  view.dispatch({ changes: { from, to, insert: '[stamp]' } })
  return true
}
// Throws whenever an editor is created with it.
const broken = StateField.define({
  create() {
    throw new Error('fixture extension failed')
  },
  update: (value) => value,
})

module.exports = class EditorSurface extends Plugin {
  onload() {
    fixture.render = async (markdown) => {
      const el = document.createElement('div')
      await MarkdownRenderer.render(this.app, markdown, el, 'note.md', this)
      return el.innerHTML
    }
    this.registerEditorExtension([
      changes,
      todos,
      keymap.of([{ key: 'Mod-Alt-j', run: stamp }]),
      EditorView.editorAttributes.of((view) => ({
        'data-fixture-live': String(view.state.field(editorLivePreviewField)),
        'data-fixture-info': String(!!view.state.field(editorInfoField).editor),
      })),
    ])
    this.registerEditorExtension(broken)
    this.registerEditorExtension(
      EditorView.editorAttributes.of({ 'data-fixture-other': 'yes' }),
    )
    this.addCommand({
      id: 'wrap',
      name: 'Wrap fixture selection',
      editorCallback: (editor, view) => {
        fixture.editor = editor
        fixture.view = view
        editor.replaceSelection(`==${editor.getSelection()}==`)
      },
    })
    this.registerMarkdownCodeBlockProcessor(
      'fixture-count',
      (source, el, ctx) => {
        el.textContent = `lines: ${source.split('\n').length}`
        fixture.sections.push(ctx.getSectionInfo(el))
        fixture.paths.push(ctx.sourcePath)
        ctx.addChild(new MarkdownRenderChild(el))
      },
    )
  }
  onunload() {
    fixture.unloaded++
  }
}
