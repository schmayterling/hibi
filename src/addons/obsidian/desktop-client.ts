import type { DialogApi } from '../../ui/dialogs'
import { changed } from './manager'
import type { InstalledPlugin } from './package'

export async function revokeFullAccess() {
  if (
    (await window.hibi.getAddonStates()).some(
      (state) => state.id === 'obsidian' && state.enabled,
    )
  )
    await window.hibi.invokeAddon('obsidian', 'revokeFullAccess')
  changed()
  window.hibiObsidianSession?.switch()
}

/** Browser dialogs keep the existing Hibi focus/escape behavior; main binds consent to this exact hash. */
export async function setPluginEnabled(
  plugin: InstalledPlugin,
  enabled: boolean,
  dialogs: DialogApi,
  fullAccess = plugin.manifest.isDesktopOnly,
) {
  let token: string | undefined
  if (enabled && fullAccess) {
    const prompt = (await window.hibi.queryAddon(
      'obsidian',
      'prepareFullAccess',
      {
        id: plugin.manifest.id,
        hash: plugin.hash,
      },
    )) as { token: string; plugin: InstalledPlugin }
    const current = prompt.plugin
    if (
      !(await dialogs.confirm({
        title: 'Full computer access for ' + current.manifest.name + '?',
        description:
          current.manifest.name +
          ' by ' +
          current.manifest.author +
          (current.source ? ' (' + current.source.repo + ')' : '') +
          ' can read and write any file on your computer and run programs, like a desktop plugin in Obsidian. Hibi itself runs in a less isolated workspace while full-access plugins are enabled. Every plugin running there must have full computer access; other plugins are paused. Other installed Hibi addons are paused until full access is off; bundled addons keep working. Unsafe scripts in Hibi’s interface can also gain computer access. Only grant this to code you trust. Hibi will keep your open tabs and unsaved edits when switching modes. Disabling this plugin revokes its grant and replaces the workspace window.',
        confirmLabel: 'Grant full access and enable',
        destructive: true,
      }))
    )
      return false
    token = prompt.token
  }
  const result = await window.hibi.invokeAddon('obsidian', 'enable', {
    id: plugin.manifest.id,
    enabled,
    ...(token ? { fullAccess: true, token } : {}),
  })
  return result !== null
}
