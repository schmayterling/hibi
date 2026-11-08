const { Plugin, TFile, TFolder } = require('obsidian')
module.exports = class VaultApiFixture extends Plugin {
  async onload() {
    await this.saveData(await this.exercise())
  }
  async exercise() {
    const vault = this.app.vault
    const events = []
    for (const name of ['create', 'modify', 'delete', 'rename'])
      this.registerEvent(
        vault.on(name, (file) => events.push([name, file.path])),
      )
    const folder = await vault.createFolder('api-fixture')
    if (!(folder instanceof TFolder) || folder.parent !== vault.getRoot())
      throw new Error('folder tree')
    const file = await vault.create(
      'api-fixture/note.md',
      '\ufeff---\r\ntitle: Old # keep\r\n---\r\n\r\nbody  \r\n[[untouched]]\r\n',
    )
    if (
      !(file instanceof TFile) ||
      file.basename !== 'note' ||
      file.extension !== 'md' ||
      file.parent !== folder
    )
      throw new Error('file tree')
    if (
      vault.getAbstractFileByPath(file.path) !== file ||
      !vault.getMarkdownFiles().includes(file) ||
      !vault.getFiles().includes(file) ||
      !vault.getAllLoadedFiles().includes(folder)
    )
      throw new Error('file lookup')
    const before = await vault.read(file)
    if ((await vault.cachedRead(file)) !== before)
      throw new Error('cached read')
    await vault.modify(file, before.replace('body', 'edited'))
    await vault.process(file, (text) => text.replace('edited', 'processed'))
    await vault.append(file, 'append\r\n')
    await this.app.fileManager.processFrontMatter(file, (properties) => {
      properties.title = 'New'
    })
    const content = await vault.read(file)
    if (!content.endsWith('\r\n\r\nprocessed  \r\n[[untouched]]\r\nappend\r\n'))
      throw new Error('frontmatter changed body bytes')
    const copy = await vault.copy(file, 'api-fixture/copy.md')
    if ((await vault.read(copy)) !== content) throw new Error('copy bytes')
    await this.app.fileManager.renameFile(copy, 'api-fixture/renamed.md')
    if (
      copy.path !== 'api-fixture/renamed.md' ||
      vault.getFileByPath(copy.path) !== copy
    )
      throw new Error('rename identity')
    if (
      !(await vault.adapter.exists(copy.path)) ||
      (await vault.adapter.stat(copy.path)).type !== 'file'
    )
      throw new Error('adapter stat')
    await vault.adapter.write(copy.path, 'adapter\r\n')
    if ((await vault.adapter.read(copy.path)) !== 'adapter\r\n')
      throw new Error('adapter write')
    const list = await vault.adapter.list(folder.path)
    if (list.files.length !== 2 || list.folders.length !== 0)
      throw new Error('adapter list')
    const binary = await vault.createBinary(
      'api-fixture/pixel.png',
      new Uint8Array([137, 80, 78, 71, 0, 255]).buffer,
    )
    if (new Uint8Array(await vault.readBinary(binary)).at(-1) !== 255)
      throw new Error('binary bytes')
    await vault.trash(binary, false)
    await vault.delete(copy)
    await vault.rename(file, 'api-fixture/final.md')
    const link = this.app.fileManager.generateMarkdownLink(
      file,
      'untouched.md',
      '#Heading',
      'Name',
    )
    if (!link.includes('Heading') || !link.includes('Name'))
      throw new Error('link settings')
    return {
      events,
      content,
      link,
      configDir: vault.configDir,
      parent: this.app.fileManager.getNewFileParent('untouched.md').path,
    }
  }
}
