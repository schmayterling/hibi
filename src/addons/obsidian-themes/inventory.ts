// Read-only view of installed Obsidian themes for Hibi's Addon Manager, which
// lists them even while this addon is off. Main process; reads only Hibi's data.
import { join } from 'node:path'
import {
  type GlobalSelection,
  type InstalledSnippet,
  type InstalledTheme,
  installedSnippets,
  installedThemes,
  readGlobal,
} from './store.ts'

export type ThemeInventory = {
  themes: InstalledTheme[]
  snippets: InstalledSnippet[]
  selection: GlobalSelection
}

/** `userData` is `app.getPath('userData')`. */
export async function themeInventory(
  userData: string,
): Promise<ThemeInventory> {
  const root = join(userData, 'obsidian-themes')
  return {
    themes: await installedThemes(root),
    snippets: await installedSnippets(root),
    selection: await readGlobal(root),
  }
}
