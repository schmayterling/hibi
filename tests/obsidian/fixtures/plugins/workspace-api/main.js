const { Plugin, ItemView } = require('obsidian')
class FixtureView extends ItemView {
  getViewType() {
    return 'fixture-panel'
  }
  getDisplayText() {
    return 'Fixture panel'
  }
  async onOpen() {
    this.contentEl.textContent = 'Custom view hosted by Hibi.'
  }
}
module.exports = class WorkspaceFixture extends Plugin {
  async onload() {
    this.registerView('fixture-panel', (leaf) => new FixtureView(leaf))
    this.leaf = this.app.workspace.getRightLeaf(false)
    await this.leaf.setViewState({ type: 'fixture-panel', active: true })
  }
}
