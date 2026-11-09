const { Plugin } = require('obsidian')
module.exports = class Throws extends Plugin {
  onload() {
    const state = { loaded: true, unloaded: 0, cleaned: 0 }
    globalThis.__hibiThrowFixture = state
    this.register(() => state.cleaned++)
    this.addStatusBarItem().setText('Throwing fixture')
  }
  onunload() {
    globalThis.__hibiThrowFixture.unloaded++
    throw new Error('Fixture unload failure.')
  }
}
