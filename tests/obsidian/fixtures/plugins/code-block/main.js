const { Plugin, MarkdownRenderChild } = require('obsidian')

module.exports = class CodeBlock extends Plugin {
  onload() {
    this.registerMarkdownCodeBlockProcessor(
      'fixture-count',
      (source, el, ctx) => {
        el.textContent = `lines: ${source.split('\n').length}`
        el.dataset.fixtureSource = ctx.sourcePath
        ctx.addChild(new MarkdownRenderChild(el))
      },
    )
  }
}
