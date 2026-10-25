import { useSyncExternalStore } from 'react'
import { stored } from '../../ui/stored-preference'
import { type CursorSettings, loadCursor } from './EditorCursor'

/** Editor preferences shared by the main window and addon editor windows. */
export const editorPreferences = {
  cursor: stored<CursorSettings>('cursor-settings', loadCursor, (value) =>
    JSON.stringify(value),
  ),
  lineNumbers: stored(
    'line-numbers',
    () => localStorage.getItem('line-numbers') === 'true',
    String,
  ),
  spellCheck: stored(
    'spell-check',
    () => localStorage.getItem('spell-check') !== 'false',
    String,
  ),
  markers: stored(
    'markdown-markers',
    () => localStorage.getItem('markdown-markers') !== 'false',
    String,
  ),
}

export function useEditorPreference<T>(
  preference: ReturnType<typeof stored<T>>,
) {
  return [
    useSyncExternalStore(preference.subscribe, preference.get),
    preference.set,
  ] as const
}
