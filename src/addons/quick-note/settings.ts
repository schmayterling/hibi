export type QuickNoteSettings = {
  workspaceId: string
  folder: string
  defaultTitle: string
  promptForTitle: boolean
  shortcut: string
}

export const settingsKey = 'hibi:quick-note'
export const settingsChanged = 'hibi:quick-note-settings'

export function readSettings(): QuickNoteSettings {
  let saved: Partial<QuickNoteSettings> = {}
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(settingsKey) ?? '{}',
    )
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      saved = parsed
  } catch {
    // Invalid local preferences use defaults.
  }
  return {
    workspaceId: typeof saved.workspaceId === 'string' ? saved.workspaceId : '',
    folder: typeof saved.folder === 'string' ? saved.folder : '',
    defaultTitle:
      typeof saved.defaultTitle === 'string'
        ? saved.defaultTitle
        : 'Quick note',
    promptForTitle: saved.promptForTitle === true,
    shortcut:
      typeof saved.shortcut === 'string'
        ? saved.shortcut
        : 'CommandOrControl+Alt+N',
  }
}

export function writeSettings(settings: QuickNoteSettings) {
  localStorage.setItem(settingsKey, JSON.stringify(settings))
  window.dispatchEvent(new Event(settingsChanged))
}
