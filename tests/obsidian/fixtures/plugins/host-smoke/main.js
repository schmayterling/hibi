const { Plugin } = require('obsidian')

module.exports = class HostSmoke extends Plugin {
  async onload() {
    this.settings = (await this.loadData()) || { enabled: false }
    this.addCommand({
      id: 'count',
      name: 'Count fixture runs',
      callback: () => {
        this.settings.count = (this.settings.count || 0) + 1
        return this.saveData(this.settings)
      },
    })
  }
}
