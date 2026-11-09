const { Plugin } = require('obsidian')
module.exports = class PortablePeer extends Plugin {
  onload() {
    window.__hibiPortablePeer = {
      loaded: true,
      node: typeof require('fs').readFileSync === 'function',
    }
    this.register(() => {
      delete window.__hibiPortablePeer
    })
  }
}
