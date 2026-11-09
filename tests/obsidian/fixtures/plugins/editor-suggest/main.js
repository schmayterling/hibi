const { Plugin, EditorSuggest } = require('obsidian')

const fixture = { triggers: 0, selected: [], unloaded: 0 }
window.__hibiSuggestFixture = fixture
const people = ['alice', 'alan', 'bob']

class People extends EditorSuggest {
  onTrigger(cursor, editor, file) {
    fixture.triggers++
    const line = editor.getLine(cursor.line).slice(0, cursor.ch)
    const match = /@(\w*)$/.exec(line)
    if (!match) return null
    fixture.file = file?.path ?? null
    return {
      start: { line: cursor.line, ch: match.index },
      end: cursor,
      query: match[1],
    }
  }
  // Answers after the list asked, as a lookup would.
  getSuggestions(context) {
    return new Promise((resolve) =>
      setTimeout(
        () => resolve(people.filter((name) => name.startsWith(context.query))),
        20,
      ),
    )
  }
  renderSuggestion(value, el) {
    const name = document.createElement('span')
    name.className = 'fixture-person'
    name.textContent = value
    el.append('@', name)
  }
  selectSuggestion(value, evt) {
    fixture.selected.push([value, evt instanceof KeyboardEvent])
    const { editor, start, end } = this.context
    editor.replaceRange(`@${value} `, start, end)
    editor.setCursor({ line: start.line, ch: start.ch + value.length + 2 })
  }
}

module.exports = class EditorSuggestFixture extends Plugin {
  onload() {
    this.registerEditorSuggest(new People(this.app))
  }
  onunload() {
    fixture.unloaded++
  }
}
