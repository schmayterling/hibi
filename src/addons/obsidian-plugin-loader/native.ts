import { join } from 'node:path'
import { app, dialog, shell } from 'electron'
import type { NativeAddon } from '../api'
import {
  installedObsidianPluginPath,
  installObsidianPlugin,
  listObsidianPlugins,
  readObsidianPackage,
  readObsidianPluginData,
  setObsidianPluginEnabled,
  writeObsidianPluginData,
} from './store'
import {
  vaultCreate,
  vaultList,
  vaultModify,
  vaultRead,
  vaultRename,
  vaultTrash,
} from './vault'

export const obsidianPluginRoot = () =>
  join(app.getPath('userData'), 'obsidian-plugins')

const idFrom = (input: unknown) => {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof (input as { id?: unknown }).id !== 'string'
  )
    throw new Error('Choose an installed Obsidian plugin.')
  return (input as { id: string }).id
}

export default {
  id: 'obsidian-plugin-loader',
  queries: {
    list: async () => listObsidianPlugins(obsidianPluginRoot()),
    data: async (input) =>
      readObsidianPluginData(obsidianPluginRoot(), idFrom(input)),
    vaultList,
    vaultRead,
  },
  methods: {
    async install() {
      const choice = await dialog.showOpenDialog({
        title: 'Install Obsidian plugin',
        properties: ['openDirectory'],
      })
      if (choice.canceled || !choice.filePaths[0]) return null
      const source = await readObsidianPackage(choice.filePaths[0])
      const installed = await listObsidianPlugins(obsidianPluginRoot())
      const existing = installed.find(
        (plugin) => plugin.manifest.id === source.manifest.id,
      )
      const verdict = await dialog.showMessageBox({
        type: 'warning',
        message: `${existing ? 'Replace' : 'Install'} ${source.manifest.name}?`,
        detail:
          `${source.manifest.description}\n\n` +
          'Obsidian plugins run code inside Hibi and can read or change your notes. Install only plugins you trust. This plugin starts disabled.',
        buttons: ['Cancel', existing ? 'Replace plugin' : 'Install'],
        defaultId: 0,
        cancelId: 0,
      })
      if (verdict.response !== 1) return null
      const result = await installObsidianPlugin(obsidianPluginRoot(), source)
      if (result.backup) await shell.trashItem(result.backup)
      return result.plugin
    },
    async enable(input) {
      const id = idFrom(input)
      const enabled = (input as { enabled?: unknown }).enabled
      if (typeof enabled !== 'boolean')
        throw new Error('Choose whether to enable this plugin.')
      return setObsidianPluginEnabled(obsidianPluginRoot(), id, enabled)
    },
    async saveData(input) {
      const id = idFrom(input)
      await writeObsidianPluginData(
        obsidianPluginRoot(),
        id,
        (input as { value?: unknown }).value,
      )
    },
    async remove(input) {
      const id = idFrom(input)
      const path = await installedObsidianPluginPath(obsidianPluginRoot(), id)
      await shell.trashItem(path)
    },
    vaultCreate,
    vaultModify,
    vaultRename,
    vaultTrash,
  },
} satisfies NativeAddon
