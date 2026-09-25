import type { CommandExecutionContext } from '../../shared/foundation-contracts'
import type { RegisteredCommand } from './addons'

let providers = 0
const listeners = new Set<() => void>()
let commandMenu: {
  commands: readonly RegisteredCommand[]
  capture: () => CommandExecutionContext
} = { commands: [], capture: () => ({ source: 'menu' }) }

export const hasEditorInteractionProviders = () =>
  providers > 0 || commandMenu.commands.length > 0

export const editorCommandMenu = () => commandMenu

export function setEditorCommandMenu(
  commands: readonly RegisteredCommand[],
  capture: () => CommandExecutionContext,
) {
  commandMenu = {
    commands: commands
      .filter((command) => command.menu?.location === 'editor')
      .sort(
        (left, right) =>
          String(left.menu?.group ?? '').localeCompare(
            String(right.menu?.group ?? ''),
          ) ||
          (left.menu?.order ?? 0) - (right.menu?.order ?? 0) ||
          left.id.localeCompare(right.id),
      ),
    capture,
  }
  for (const listener of listeners) listener()
}

export function onEditorInteractionProvidersChanged(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function countEditorInteractionProvider() {
  const wasActive = providers > 0
  providers++
  if (!wasActive) for (const listener of listeners) listener()
  let removed = false
  return () => {
    if (removed) return
    removed = true
    providers--
    if (!providers) for (const listener of listeners) listener()
  }
}
