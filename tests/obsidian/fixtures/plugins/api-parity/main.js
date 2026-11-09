const {
  Plugin,
  requestUrl,
  request,
  moment,
  MarkdownRenderer,
} = require('obsidian')

module.exports = class extends Plugin {
  async onload() {
    const state = {
      requestUrl,
      request,
      moment,
      plugin: this,
      seen: [],
      loaded: true,
      fetch: window.fetch,
      locale: moment?.locale(),
      language: navigator.language,
    }
    window.__apiParity = state
    try {
      this.registerObsidianProtocolHandler('parity-fixture', (params) =>
        state.seen.push(params),
      )
    } catch (error) {
      state.protocolError = error.message
    }
    const root = document.createElement('div')
    root.id = 'parity-links'
    const link = document.createElement('a')
    link.href = 'obsidian://parity-fixture?from=plugin&flag'
    link.textContent = 'Fixture protocol'
    root.append(link)
    document.body.append(root)
    this.register(() => root.remove())
    await MarkdownRenderer.render(
      this.app,
      '[Rendered protocol](obsidian://parity-fixture?from=markdown)\n' +
        '[Hibi protocol](hibi://obsidian/parity-fixture?from=hibi)\n' +
        '[Unsafe protocol](javascript:alert(1))\n<span style="position:fixed">No styles</span>',
      root,
      '',
      this,
    )
    state.rendered = true
  }
}
