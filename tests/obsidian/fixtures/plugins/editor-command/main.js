const { Plugin } = require('obsidian')

module.exports = class EditorCommand extends Plugin {
  onload() {
    this.addCommand({
      id: 'wrap',
      name: 'Wrap selection',
      editorCallback: (editor) => {
        const selected = editor.getSelection()
        editor.replaceSelection(`==${selected}==`)
      },
    })
  }
}
