import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { runFileDialog } from '../../main/file-operation-dialog'
import type { NativeAddon, NativeAddonContext } from '../api'
import type { DroppedRule } from './sanitize'
import {
  checkSnippet,
  checkTheme,
  configPath,
  installedThemes,
  installSnippet,
  installTheme,
  readAppearance,
  readSelection,
  readVault,
  removeTheme,
  type Selection,
  snippetCss,
  themeCss,
  writeSelection,
} from './store'

const data = () => app.getPath('userData')
const root = () => join(data(), 'obsidian-themes')
/** `--disable-obsidian-themes` starts Hibi without any theme or snippet. */
const disabled = () =>
  process.argv.includes('--disable-obsidian-themes') ||
  process.env.HIBI_DISABLE_OBSIDIAN_THEMES === '1'
const vaultName = (value: string) => {
  if (!/^[^/\\]{1,200}$/.test(value) || value === '.' || value === '..')
    throw new Error('Choose a theme from this vault.')
  return value
}
async function vaultThemeFolder(vault: string, name: string) {
  const folder = await configPath(vault, 'themes', vaultName(name))
  if (!folder) throw new Error('This vault has no Obsidian settings folder.')
  return folder
}
const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []

async function state(context: NativeAddonContext) {
  const vault = context.workspace.directory()
  const installed = await installedThemes(root())
  if (!vault)
    return { disabled: disabled(), vault: null, installed, selection: null }
  const found = await readVault(vault)
  const stored = await readSelection(data(), vault)
  let selection: Selection & { preselected: boolean }
  if (stored) selection = { ...stored, preselected: false }
  else {
    // Start from what the vault uses in Obsidian.
    // Obsidian names the theme's folder; themes added by hand may differ.
    const wanted = found.appearance.cssTheme
    const theme =
      found.themes.find((item) => item.name === wanted) ??
      found.themes.find((item) => item.manifest.name === wanted)
    const copy = theme && installed.find((item) => item.hash === theme.hash)?.id
    selection = {
      theme: copy ?? (theme ? `vault:${theme.name}` : null),
      snippets: found.appearance.enabledCssSnippets.filter((name) =>
        found.snippets.some((snippet) => snippet.name === name),
      ),
      preselected: true,
    }
  }
  return { disabled: disabled(), vault: found, installed, selection }
}

// Checked CSS for a theme reference: an installed ID or `vault:<name>`.
async function cssFor(
  context: NativeAddonContext,
  theme: unknown,
): Promise<{ css: string; dropped: DroppedRule[] }> {
  if (theme === null || theme === undefined) return { css: '', dropped: [] }
  if (typeof theme !== 'string') throw new Error('Choose a theme.')
  if (!theme.startsWith('vault:'))
    return {
      css: await themeCss(root(), theme),
      dropped:
        (await installedThemes(root())).find((item) => item.id === theme)
          ?.dropped ?? [],
    }
  const vault = context.workspace.directory()
  if (!vault) throw new Error('Open an Obsidian vault first.')
  const { result } = await checkTheme(
    await vaultThemeFolder(vault, theme.slice(6)),
  )
  return { css: result.css, dropped: result.dropped }
}

export default {
  id: 'obsidian-themes',
  queries: {
    state: async (_input, context) => state(context),
    /** The CSS to apply for this vault's saved choices. */
    async active(_input, context) {
      const vault = context.workspace.directory()
      if (disabled() || !vault) return { disabled: disabled(), css: null }
      const stored = await readSelection(data(), vault)
      if (!stored) return { disabled: false, css: null }
      const parts = [
        stored.theme
          ? await themeCss(root(), stored.theme).catch(() => '')
          : '',
      ]
      for (const name of stored.snippets) {
        const hash = stored.snippetHashes[name]
        if (hash) parts.push(await snippetCss(root(), hash).catch(() => ''))
      }
      return {
        disabled: false,
        css: parts.join('\n'),
        appearance: await readAppearance(vault),
      }
    },
    /** CSS for trying a theme and snippets before keeping them. Copies nothing. */
    async preview(input, context) {
      const vault = context.workspace.directory()
      const request = (input ?? {}) as { theme?: unknown; snippets?: unknown }
      const theme = await cssFor(context, request.theme)
      const parts = [theme.css]
      const dropped = [...theme.dropped]
      if (vault)
        for (const name of strings(request.snippets)) {
          const { result } = await checkSnippet(vault, name)
          parts.push(result.css)
          dropped.push(...result.dropped)
        }
      return {
        css: parts.join('\n'),
        dropped,
        appearance: vault ? await readAppearance(vault) : {},
      }
    },
  },
  methods: {
    /** Keep a theme and snippets for this vault, copying them into Hibi's data. */
    async select(input, context) {
      const vault = context.workspace.directory()
      if (!vault) throw new Error('Open an Obsidian vault first.')
      const request = (input ?? {}) as { theme?: unknown; snippets?: unknown }
      let theme: string | null = null
      if (typeof request.theme === 'string') {
        theme = request.theme.startsWith('vault:')
          ? (
              await installTheme(
                root(),
                await vaultThemeFolder(vault, request.theme.slice(6)),
                'vault',
              )
            ).id
          : request.theme
        await themeCss(root(), theme)
      }
      const snippets = strings(request.snippets)
      const snippetHashes: Record<string, string> = {}
      for (const name of snippets)
        snippetHashes[name] = (await installSnippet(vault, root(), name)).hash
      if (!context.isCurrent()) return null
      await writeSelection(data(), vault, { theme, snippets, snippetHashes })
      return state(context)
    },
    /** Add a theme from a folder outside the vault. */
    async addFolder(_input, context) {
      const options = {
        title: 'Choose an Obsidian theme folder',
        properties: ['openDirectory'] as 'openDirectory'[],
      }
      const window = BrowserWindow.getFocusedWindow()
      const selection = await (window
        ? runFileDialog(() => dialog.showOpenDialog(window, options))
        : runFileDialog(() => dialog.showOpenDialog(options)))
      const folder = selection.filePaths[0]
      if (selection.canceled || !folder) return null
      await installTheme(root(), folder, 'folder')
      return state(context)
    },
    async remove(input, context) {
      await removeTheme(root(), (input as { id?: unknown } | null)?.id)
      return state(context)
    },
  },
} satisfies NativeAddon
