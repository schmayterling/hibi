import type { AddonContext } from '../../addons/api'
import type { DesktopApi } from '../../shared/desktop'

type Command = Parameters<AddonContext['globalShortcuts']['register']>[2]
type Transport = Pick<
  DesktopApi,
  'registerGlobalShortcut' | 'unregisterGlobalShortcut' | 'onGlobalShortcut'
>

export function createAddonGlobalShortcuts(
  owner: string,
  transport: Transport,
  invoke: (command: Command) => void | Promise<void>,
  onError: (error: unknown) => void,
) {
  const registrations = new Map<string, () => void>()
  let disposed = false

  return {
    async register(localId: string, accelerator: string, command: Command) {
      if (disposed) throw new Error('This addon has stopped.')
      if (!/^[a-z][a-z0-9-]*$/.test(localId))
        throw new Error('This addon supplied an invalid shortcut name.')
      if (registrations.has(localId))
        throw new Error(`This addon already registered shortcut ${localId}.`)
      if (typeof command !== 'function' && !/^[a-z][a-z0-9-]*$/.test(command))
        throw new Error('This addon supplied an invalid command name.')

      const id = `${owner}.${localId}`
      const token = crypto.randomUUID()
      let active = true
      const off = transport.onGlobalShortcut((invoked) => {
        if (!active || invoked.id !== id || invoked.token !== token) return
        try {
          void Promise.resolve(invoke(command)).catch(onError)
        } catch (error) {
          onError(error)
        }
      })
      const remove = () => {
        if (!active) return
        active = false
        off()
        if (registrations.get(localId) === remove) registrations.delete(localId)
        void transport.unregisterGlobalShortcut(id, token).catch(onError)
      }
      registrations.set(localId, remove)
      try {
        await transport.registerGlobalShortcut(id, accelerator, token)
      } catch (error) {
        remove()
        throw error
      }
      if (!active) await transport.unregisterGlobalShortcut(id, token)
      return remove
    },
    dispose() {
      disposed = true
      for (const remove of registrations.values()) remove()
    },
  }
}
