// Renderer helpers for Obsidian themes, shared with the Addon Manager. They
// work while the addon is on; calls reject with Hibi's usual "enable this
// addon" error otherwise.
import type { DroppedRule } from './sanitize'
import type {
  GlobalSelection,
  InstalledSnippet,
  InstalledTheme,
  VaultAppearance,
  VaultSnippet,
  VaultTheme,
} from './store'

const id = 'obsidian-themes'

export type ObsidianThemesState = {
  /** Started with --disable-obsidian-themes: nothing applies this session. */
  disabled: boolean
  /** Every installed theme, usable in any workspace or none. */
  themes: InstalledTheme[]
  snippets: InstalledSnippet[]
  /** Snippets turned on and Style Settings values, for all of Hibi. */
  selection: GlobalSelection
  /** What the open folder's own Obsidian settings use, as a suggestion. */
  vault: {
    appearance: VaultAppearance
    themes: (VaultTheme & { copy: string | null })[]
    snippets: (VaultSnippet & { copy: string | null })[]
    suggested: { theme: string | null; snippets: string[] }
  } | null
}
export type { InstalledSnippet, InstalledTheme }

/** Hibi colorscheme IDs for an installed theme. Choosing them in Appearance applies the theme. */
export const schemeIds = (theme: string) => ({
  light: `${id}.t-${theme}-light`,
  dark: `${id}.t-${theme}-dark`,
})
export const themeOfScheme = (scheme: string) =>
  /^obsidian-themes\.t-([a-z0-9-]+)-(?:light|dark)$/.exec(scheme)?.[1] ?? null

const saved = () =>
  window.dispatchEvent(new Event('hibi:obsidian-themes-saved'))
const profile = async <T>(method: string, input?: unknown) => {
  const result = (await window.hibi.invokeAddonProfile(id, method, input)) as T
  saved()
  return result
}

export const obsidianThemes = {
  state: () =>
    window.hibi.queryAddon(id, 'state') as Promise<ObsidianThemesState>,
  /** Show a theme (installed ID, or `vault:<name>` from the open folder) until the preview ends. */
  async preview(theme: string | null, snippets?: string[]) {
    const result = (await window.hibi.queryAddon(id, 'preview', {
      theme,
      ...(snippets ? { snippets } : {}),
    })) as { css: string; classes: string[]; dropped: DroppedRule[] }
    window.dispatchEvent(
      new CustomEvent('hibi:obsidian-themes-preview', { detail: result }),
    )
    return result
  },
  endPreview: () =>
    window.dispatchEvent(new CustomEvent('hibi:obsidian-themes-preview')),
  /** Use an installed theme for light and dark, as far as it styles them; `null` goes back to Hibi's colorschemes. */
  apply: (theme: string | null) =>
    window.dispatchEvent(
      new CustomEvent('hibi:obsidian-themes-apply', { detail: { theme } }),
    ),
  setSnippets: (snippets: string[]) =>
    profile<ObsidianThemesState>('setSnippets', { snippets }),
  setStyleValues: (values: GlobalSelection['styleValues']) =>
    profile<ObsidianThemesState>('setStyleValues', { values }),
  /** Copy the open folder's Obsidian theme and snippets into Hibi; snippets turn on. */
  adoptVault: (input: { theme?: string | null; snippets?: string[] }) =>
    profile<{ theme: string | null; state: ObsidianThemesState }>(
      'adoptVault',
      input,
    ),
  remove: (theme: string) =>
    profile<ObsidianThemesState>('remove', { id: theme }),
  removeSnippet: (hash: string) =>
    profile<ObsidianThemesState>('removeSnippet', { hash }),
  async addFolder() {
    const result = (await window.hibi.invokeAddon(id, 'addFolder')) as {
      theme: string
      state: ObsidianThemesState
    } | null
    if (result) saved()
    return result
  },
}
