import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { runFileDialog } from '../../main/file-operation-dialog'
import { manualFetch } from '../../main/manual-fetch'
import type { NativeAddon, NativeAddonContext } from '../api'
import { communityScreenshot, installCommunityTheme } from './community'
import type { DroppedRule } from './sanitize'
import {
  checkTheme,
  configPath,
  copiedSettings,
  type GlobalSelection,
  installedSnippets,
  installedThemes,
  installSnippet,
  installTheme,
  readGlobal,
  readVault,
  removeSnippet,
  removeTheme,
  snippetCss,
  styleValues,
  themeCss,
  withCopies,
  writeGlobal,
} from './store'
import { styleSettingsCss } from './style-settings'

// Installed themes and snippets live in Hibi's data and work in any
// workspace, or none. An open vault's own themes are only suggestions.
const root = () => join(app.getPath('userData'), 'obsidian-themes')
/** `--disable-obsidian-themes` starts Hibi without any theme or snippet. */
const disabled = () =>
  process.argv.includes('--disable-obsidian-themes') ||
  process.env.HIBI_DISABLE_OBSIDIAN_THEMES === '1'
const vaultName = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^[^/\\]{1,200}$/.test(value) ||
    value === '.' ||
    value === '..'
  )
    throw new Error('Choose a theme from this vault.')
  return value
}
async function vaultThemeFolder(vault: string, name: unknown) {
  const folder = await configPath(vault, 'themes', vaultName(name))
  if (!folder) throw new Error('This folder has no Obsidian settings folder.')
  return folder
}
const hashes = (value: unknown) =>
  Array.isArray(value)
    ? value.filter(
        (hash): hash is string =>
          typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash),
      )
    : []
const names = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((name): name is string => typeof name === 'string')
    : []
// Hibi's main-process fetch. In tests (`--hibi-test`, unpackaged) a local
// fixture server can stand in for GitHub: official URLs still pass every
// check, then go to `<server>/<hostname><pathname>`, as for community plugins.
const communityFetch: typeof fetch = (input, init) => {
  const override =
    !app.isPackaged && app.commandLine.hasSwitch('hibi-test')
      ? process.env.HIBI_TEST_OBSIDIAN_COMMUNITY_URL
      : undefined
  if (!override) return manualFetch(input, init)
  const base = new URL(override)
  if (
    base.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(base.hostname)
  )
    throw new Error('Invalid community fixture server.')
  const target = new URL(String(input))
  return manualFetch(
    new URL(`/${target.hostname}${target.pathname}${target.search}`, base),
    init,
  )
}
const themeOf = (input: unknown) =>
  (input as { theme?: unknown } | null)?.theme ?? null

// Community downloads in flight, by the caller's request id, for cancelInstall.
const requests = new Map<string, AbortController>()
async function tracked<T>(
  input: unknown,
  run: (signal: AbortSignal) => Promise<T>,
) {
  const id = (input as { requestId?: unknown } | null)?.requestId
  if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id))
    throw new Error('Each theme download needs its own request id.')
  if (requests.has(id))
    throw new Error('This theme download is already running.')
  const controller = new AbortController()
  requests.set(id, controller)
  try {
    return await run(controller.signal)
  } finally {
    requests.delete(id)
  }
}
// What the open folder's own Obsidian settings use, offered but never forced.
async function suggestion(context: NativeAddonContext) {
  const vault = context.workspace.directory()
  if (!vault) return null
  const found = await readVault(vault)
  if (!found.themes.length && !found.snippets.length) return null
  const themes = await installedThemes(root())
  const snippets = await installedSnippets(root())
  const wanted = found.appearance.cssTheme
  const theme =
    found.themes.find((item) => item.name === wanted) ??
    found.themes.find((item) => item.manifest.name === wanted)
  return {
    appearance: found.appearance,
    themes: found.themes.map((item) => ({
      ...item,
      copy: themes.find((copy) => copy.hash === item.hash)?.id ?? null,
    })),
    snippets: found.snippets.map((item) => ({
      ...item,
      copy: snippets.find((copy) => copy.hash === item.hash)?.hash ?? null,
    })),
    suggested: {
      theme: theme?.name ?? null,
      snippets: found.appearance.enabledCssSnippets.filter((name) =>
        found.snippets.some((snippet) => snippet.name === name),
      ),
    },
  }
}

async function state(context: NativeAddonContext) {
  return {
    disabled: disabled(),
    themes: await installedThemes(root()),
    snippets: await installedSnippets(root()),
    selection: await readGlobal(root()),
    vault: await suggestion(context).catch(() => null),
  }
}

// Checked CSS for a theme: an installed ID, or `vault:<name>` to preview one
// from the open folder's Obsidian settings without copying it.
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
  if (!vault) throw new Error('Open the folder with this theme first.')
  const { result } = await checkTheme(
    await vaultThemeFolder(vault, theme.slice(6)),
  )
  return { css: result.css, dropped: result.dropped }
}

// A theme with the turned-on snippets and the Style Settings values.
async function compose(theme: unknown, selection: GlobalSelection) {
  const sections = [
    ...(typeof theme === 'string' && !theme.startsWith('vault:')
      ? await copiedSettings(root(), 'theme', theme)
      : []),
    ...(
      await Promise.all(
        selection.snippets.map((hash) =>
          copiedSettings(root(), 'snippet', hash),
        ),
      )
    ).flat(),
  ]
  const parts: string[] = []
  for (const hash of selection.snippets)
    parts.push(await snippetCss(root(), hash).catch(() => ''))
  const style = styleSettingsCss(sections, selection.styleValues)
  parts.push(style.css)
  return {
    css: parts.join('\n'),
    classes: sections.length ? ['css-settings-manager', ...style.classes] : [],
  }
}

export default {
  id: 'obsidian-themes',
  queries: {
    state: async (_input, context) => state(context),
    /** The CSS for a chosen theme (from Hibi's colorscheme choice) plus the turned-on snippets. */
    async active(input) {
      if (disabled()) return { disabled: true, css: null, classes: [] }
      const theme = themeOf(input)
      const extras = await compose(theme, await readGlobal(root()))
      const css =
        (typeof theme === 'string'
          ? await themeCss(root(), theme).catch(() => '')
          : '') +
        '\n' +
        extras.css
      return {
        disabled: false,
        css: css.trim() ? css : null,
        classes: extras.classes,
      }
    },
    /** CSS for trying a theme and snippets before keeping them. Copies nothing. */
    async preview(input, context) {
      const request = (input ?? {}) as { theme?: unknown; snippets?: unknown }
      const selection = await readGlobal(root())
      const snippets =
        request.snippets === undefined
          ? selection.snippets
          : hashes(request.snippets)
      const theme = await cssFor(context, request.theme)
      const extras = await compose(request.theme, { ...selection, snippets })
      return {
        css: `${theme.css}\n${extras.css}`,
        classes: extras.classes,
        dropped: theme.dropped,
      }
    },
  },
  // Everything here touches only Hibi's data (reading the open folder at
  // most), so it runs beside file operations instead of waiting for them.
  profileMethods: {
    /** Download a theme from Obsidian's community directory into Hibi's data. Never applies it. */
    async installRepo(input) {
      const request = (input ?? {}) as Record<string, unknown>
      return tracked(input, (signal) =>
        installCommunityTheme(
          root(),
          { repo: request.repo, name: request.name, branch: request.branch },
          { fetch: communityFetch, signal },
        ),
      )
    },
    /** Load a community theme's screenshot on demand, as a data URL. */
    async screenshot(input) {
      const request = (input ?? {}) as Record<string, unknown>
      return tracked(input, (signal) =>
        communityScreenshot(
          { repo: request.repo, path: request.path, branch: request.branch },
          { fetch: communityFetch, signal },
        ),
      )
    },
    async cancelInstall(input) {
      const id = (input as { requestId?: unknown } | null)?.requestId
      const controller = typeof id === 'string' ? requests.get(id) : undefined
      controller?.abort()
      return { cancelled: !!controller }
    },
    /** Turn snippets on or off for all of Hibi. */
    async setSnippets(input, context) {
      const installed = new Set(
        (await installedSnippets(root())).map((item) => item.hash),
      )
      await withCopies(async () => {
        const selection = await readGlobal(root())
        await writeGlobal(root(), {
          ...selection,
          snippets: hashes(
            (input as { snippets?: unknown } | null)?.snippets,
          ).filter((hash) => installed.has(hash)),
        })
      })
      return state(context)
    },
    /** Save Style Settings values for the themes and snippets. */
    async setStyleValues(input, context) {
      await withCopies(async () => {
        const selection = await readGlobal(root())
        await writeGlobal(root(), {
          ...selection,
          styleValues: styleValues(
            (input as { values?: unknown } | null)?.values,
          ),
        })
      })
      return state(context)
    },
    /** Copy the open folder's Obsidian theme and snippets into Hibi's data, turning the snippets on. */
    async adoptVault(input, context) {
      const vault = context.workspace.directory()
      if (!vault) throw new Error('Open the folder with this theme first.')
      const request = (input ?? {}) as { theme?: unknown; snippets?: unknown }
      const copied = await withCopies(async () => {
        const theme =
          request.theme === null || request.theme === undefined
            ? null
            : (
                await installTheme(
                  root(),
                  await vaultThemeFolder(vault, request.theme),
                  'vault',
                )
              ).id
        const added: string[] = []
        for (const name of names(request.snippets))
          added.push((await installSnippet(vault, root(), name)).hash)
        const selection = await readGlobal(root())
        await writeGlobal(root(), {
          ...selection,
          snippets: [...new Set([...selection.snippets, ...added])],
        })
        return theme
      })
      return { theme: copied, state: await state(context) }
    },
    async remove(input, context) {
      await withCopies(() =>
        removeTheme(root(), (input as { id?: unknown } | null)?.id),
      )
      return state(context)
    },
    async removeSnippet(input, context) {
      const hash = (input as { hash?: unknown } | null)?.hash
      await withCopies(async () => {
        await removeSnippet(root(), hash)
        const selection = await readGlobal(root())
        await writeGlobal(root(), {
          ...selection,
          snippets: selection.snippets.filter((item) => item !== hash),
        })
      })
      return state(context)
    },
  },
  methods: {
    /** Add a theme from any folder. The dialog makes this a file operation. */
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
      const theme = await withCopies(() =>
        installTheme(root(), folder, 'folder'),
      )
      return { theme: theme.id, state: await state(context) }
    },
  },
} satisfies NativeAddon
