import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

test('loads a browser Obsidian plugin through its bundled Hibi addon', {
  timeout: 60000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-obsidian-e2e-'))
  const profile = join(root, 'profile')
  const source = join(root, 'sample-plugin')
  const workspace = join(root, 'notes')
  const otherWorkspace = join(root, 'other-notes')
  await mkdir(profile)
  await mkdir(source)
  await mkdir(workspace)
  await mkdir(otherWorkspace)
  await writeFile(join(workspace, 'Note.md'), '# note')
  await writeFile(join(otherWorkspace, 'Other.md'), '# other')
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'obsidian-plugin-loader': true }),
  )
  await writeFile(
    join(source, 'manifest.json'),
    JSON.stringify({
      id: 'sample-plugin',
      name: 'Sample plugin',
      description: 'Tests the Obsidian compatibility bridge.',
      author: 'Test',
      version: '1.0.0',
      minAppVersion: '1.0.0',
      isDesktopOnly: false,
    }),
  )
  await writeFile(
    join(source, 'styles.css'),
    '.sample-plugin-test { color: red }',
  )
  await writeFile(
    join(source, 'main.js'),
    `const { Plugin, Modal, Notice, PluginSettingTab, Setting } = require('obsidian');
class SampleModal extends Modal { onOpen() { this.contentEl.setText('sample modal opened'); } }
class SampleSettings extends PluginSettingTab {
  display() {
    this.containerEl.empty();
    new Setting(this.containerEl).setName('Sample preference').addText((input) =>
      input.setValue(this.plugin.value).onChange(async (value) => {
        this.plugin.value = value;
        await this.plugin.saveData({ value });
      }));
  }
}
module.exports = class Sample extends Plugin {
  async onload() {
    const saved = await this.loadData();
    this.value = saved?.value || 'original';
    this.addRibbonIcon('dice', 'Sample action', () => new Notice('Sample clicked'));
    this.addStatusBarItem().setText('sample ready');
    this.addCommand({ id: 'open-modal', name: 'Open sample modal', callback: () => new SampleModal(this.app).open() });
    this.addCommand({ id: 'edit-vault', name: 'Edit sample vault', callback: async () => {
      const file = this.app.vault.getFileByPath('Note.md');
      window.sampleVaultBefore = await this.app.vault.read(file);
      await this.app.vault.process(file, (text) => text + '\\nfrom plugin');
      await this.app.vault.create('Created.md', '# created');
      window.sampleVaultDone = this.app.vault.getMarkdownFiles().length;
    } });
    this.addSettingTab(new SampleSettings(this.app, this));
    window.sampleWorkspaceFiles = this.app.vault.getMarkdownFiles().map((file) => file.path);
    window.sampleHeading = this.app.metadataCache.getFileCache(this.app.vault.getMarkdownFiles()[0])?.headings[0]?.heading;
    window.sampleLoads = (window.sampleLoads || 0) + 1;
  }
  onunload() { window.sampleUnloads = (window.sampleUnloads || 0) + 1; }
};`,
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, selected) => {
    globalThis.obsidianSelectedFolder = selected
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [globalThis.obsidianSelectedFolder],
    })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, workspace)
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .waitFor()
  await page.evaluate(() => window.hibi.openWorkspace())
  await app.evaluate((_electron, selected) => {
    globalThis.obsidianSelectedFolder = selected
  }, source)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  async function command(name) {
    await pressShortcut(app, `${mod}+k`)
    const input = page.getByRole('combobox', { name: /search commands/i })
    await input.fill(name)
    await page.getByRole('option').first().click()
  }
  await command('Manage Obsidian plugins')
  await page.getByRole('button', { name: 'Install plugin folder…' }).click()
  const enable = page.getByRole('checkbox', { name: 'Enable Sample plugin' })
  await enable.waitFor()
  assert.equal(await enable.isChecked(), false)
  const plugin = await page.evaluate(
    async () =>
      (await window.hibi.queryAddon('obsidian-plugin-loader', 'list'))[0],
  )
  assert.equal(
    await page.evaluate(async (url) => (await fetch(url)).status, plugin.url),
    404,
  )
  await enable.click()
  await page.waitForFunction(() => window.sampleLoads === 1)
  assert.equal(await page.evaluate(() => window.sampleHeading), 'note')
  await page.getByText('sample ready', { exact: true }).waitFor()
  await command('Edit sample vault')
  await page.waitForFunction(() => window.sampleVaultDone === 2)
  assert.equal(await page.evaluate(() => window.sampleVaultBefore), '# note')
  assert.equal(
    await readFile(join(workspace, 'Note.md'), 'utf8'),
    '# note\nfrom plugin',
  )
  assert.equal(
    await readFile(join(workspace, 'Created.md'), 'utf8'),
    '# created',
  )
  await assert.rejects(
    page.evaluate(async () =>
      window.hibi.invokeAddon('obsidian-plugin-loader', 'vaultCreate', {
        workspaceId: (await window.hibi.getWorkspace()).id,
        path: '../escape.md',
        content: 'no',
      }),
    ),
  )
  await writeFile(join(workspace, 'Note.md'), '# external edit')
  await assert.rejects(
    page.evaluate(async () =>
      window.hibi.invokeAddon('obsidian-plugin-loader', 'vaultModify', {
        workspaceId: (await window.hibi.getWorkspace()).id,
        path: 'Note.md',
        expected: '# note\nfrom plugin',
        content: '# stale overwrite',
      }),
    ),
    /changed since the plugin read it/,
  )
  assert.equal(
    await readFile(join(workspace, 'Note.md'), 'utf8'),
    '# external edit',
  )
  await command('Open sample modal')
  await page.getByText('sample modal opened', { exact: true }).waitFor()
  await page.getByRole('dialog').getByRole('button', { name: /close/i }).click()
  await page.getByRole('button', { name: 'Plugin settings' }).click()
  const preference = page.getByRole('textbox', { name: 'Sample preference' })
  await preference.fill('changed')
  await page.waitForFunction(
    async () =>
      (
        await window.hibi.queryAddon('obsidian-plugin-loader', 'data', {
          id: 'sample-plugin',
        })
      )?.value === 'changed',
  )
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(profile, 'obsidian-plugins', 'sample-plugin', 'data.json'),
        'utf8',
      ),
    ),
    { value: 'changed' },
  )
  await page.getByRole('dialog').getByRole('button', { name: /close/i }).click()
  await app.evaluate((_electron, selected) => {
    globalThis.obsidianSelectedFolder = selected
  }, otherWorkspace)
  await page.evaluate(() => window.hibi.openWorkspace())
  await page.waitForFunction(() => window.sampleLoads === 2)
  assert.equal(await page.evaluate(() => window.sampleHeading), 'other')
  assert.deepEqual(await page.evaluate(() => window.sampleWorkspaceFiles), [
    'Other.md',
  ])
  await enable.click()
  await page.waitForFunction(() => window.sampleUnloads === 2)
  assert.equal(await page.getByText('sample ready', { exact: true }).count(), 0)
})
