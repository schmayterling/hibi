import { defineAddon } from '../api'
import { CaptureDialog } from './CaptureDialog'
import manifest from './manifest'
import { readSettings, settingsChanged } from './settings'

let stopSettings: (() => void) | undefined

export default defineAddon({
  manifest,
  async start(context) {
    async function capture() {
      const settings = readSettings()
      const target = settings.workspaceId
        ? (
            await context.native.query<{ id: string; path: string }[]>(
              'targets',
            )
          ).find((item) => item.id === settings.workspaceId)?.path
        : (await context.workspace.get())?.name
      if (!target) {
        await context.dialogs.alert({
          title: 'Choose a workspace',
          description:
            'Open a workspace or choose a recent workspace in Quick note settings.',
        })
        return
      }
      await context.dialogs.open({
        title: 'Quick note',
        description: `Save to ${target}${settings.folder ? ` / ${settings.folder}` : ''}`,
        closeOnOutsideClick: false,
        content: ({ close }) => (
          <CaptureDialog
            settings={settings}
            close={() => close(null)}
            save={async (title, markdown) => {
              const result = await context.native.invoke<{ name: string }>(
                'save',
                {
                  workspaceId: settings.workspaceId,
                  folder: settings.folder,
                  title,
                  markdown,
                },
              )
              context.notify(`Saved ${result.name}.`)
            }}
          />
        ),
      }).result
    }
    context.commands.register({
      id: 'capture',
      label: 'Quick note: capture',
      keywords: 'note inbox global shortcut',
      run: capture,
    })
    let removeShortcut: (() => void) | undefined
    let generation = 0
    async function updateShortcut() {
      const current = ++generation
      removeShortcut?.()
      removeShortcut = undefined
      const shortcut = readSettings().shortcut.trim()
      if (!shortcut) return
      try {
        const remove = await context.globalShortcuts.register(
          'capture',
          shortcut,
          () => context.commands.execute('capture'),
        )
        if (current === generation) removeShortcut = remove
        else remove()
      } catch (error) {
        context.notify(
          error instanceof Error
            ? `Quick note shortcut unavailable: ${error.message}`
            : 'Quick note shortcut unavailable.',
        )
      }
    }
    const changed = () => void updateShortcut()
    window.addEventListener(settingsChanged, changed)
    stopSettings = () => {
      generation++
      window.removeEventListener(settingsChanged, changed)
      removeShortcut?.()
    }
    await updateShortcut()
  },
  stop() {
    stopSettings?.()
    stopSettings = undefined
  },
})
