import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { runFileDialog } from '../../main/file-operation-dialog'
import { readMarkdown, writeText } from '../../main/files'
import type { NativeAddon } from '../api'
import { parseVimConfig, type VimConfig } from './config'

const preference = () => join(app.getPath('userData'), 'vim-config.json')
async function readConfig(path: string): Promise<VimConfig> {
  const text = await readMarkdown(path, 256_000)
  return { path, ...parseVimConfig(text, path.toLowerCase().endsWith('.lua')) }
}
async function config(): Promise<VimConfig> {
  let selected: unknown
  try {
    selected = JSON.parse(await readFile(preference(), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (typeof selected === 'string' && isAbsolute(selected))
    return readConfig(selected)
  const home = homedir()
  const base =
    process.env.XDG_CONFIG_HOME ||
    (process.platform === 'win32'
      ? process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
      : join(home, '.config'))
  for (const path of [
    join(base, 'nvim', 'init.lua'),
    join(base, 'nvim', 'init.vim'),
    join(home, '.vimrc'),
    join(home, '_vimrc'),
  ]) {
    try {
      return await readConfig(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return { path: null, mappings: [], skipped: [] }
}
export default {
  id: 'vim',
  queries: { config },
  methods: {
    async chooseConfig() {
      const options = {
        title: 'Choose Vim or Neovim config',
        properties: ['openFile', 'showHiddenFiles'] as (
          | 'openFile'
          | 'showHiddenFiles'
        )[],
      }
      const window = BrowserWindow.getFocusedWindow()
      const selection = await (window
        ? runFileDialog(() => dialog.showOpenDialog(window, options))
        : runFileDialog(() => dialog.showOpenDialog(options)))
      const path = selection.filePaths[0]
      if (selection.canceled || !path) return null
      const result = await readConfig(path)
      await writeText(preference(), JSON.stringify(path))
      return result
    },
  },
} satisfies NativeAddon
