const { Plugin, getAllTags, parseFrontMatterAliases } = require('obsidian')

module.exports = class MetadataFixture extends Plugin {
  onload() {
    this.registerEvent(
      this.app.metadataCache.on('changed', (file, data, cache) => {
        capture({
          path: file.path,
          data,
          cache,
          tags: getAllTags(cache),
          aliases: parseFrontMatterAliases(cache.frontmatter),
        })
      }),
    )
    this.app.metadataCache.getFileCache(
      this.app.vault.getFileByPath('untouched.md'),
    )
  }
}
