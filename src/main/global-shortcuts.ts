import { globalShortcut } from 'electron'

const registrations = new Map<string, string>()

export function registerGlobalShortcut(
  id: unknown,
  accelerator: unknown,
  invoke: (id: string) => void,
): void {
  const parts = typeof accelerator === 'string' ? accelerator.split('+') : []
  const modifier =
    /^(commandorcontrol|cmdorctrl|command|cmd|control|ctrl|alt|option|meta|super)$/i
  const key = parts.at(-1) ?? ''
  if (
    typeof id !== 'string' ||
    !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(id) ||
    typeof accelerator !== 'string' ||
    accelerator.length > 80 ||
    !parts.slice(0, -1).some((part) => modifier.test(part)) ||
    !key ||
    modifier.test(key)
  )
    throw new Error('Choose a shortcut with a modifier and key.')
  const previous = registrations.get(id)
  if (previous === accelerator) return
  if (!globalShortcut.register(accelerator, () => invoke(id)))
    throw new Error('This shortcut is already in use. Choose another.')
  if (previous) globalShortcut.unregister(previous)
  registrations.set(id, accelerator)
}

export function unregisterGlobalShortcut(id: unknown): void {
  if (typeof id !== 'string') return
  const accelerator = registrations.get(id)
  if (!accelerator) return
  globalShortcut.unregister(accelerator)
  registrations.delete(id)
}

export function clearGlobalShortcuts(): void {
  for (const id of registrations.keys()) unregisterGlobalShortcut(id)
}
