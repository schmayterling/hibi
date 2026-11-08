import { lazy } from 'react'
import { defineAddon } from '../api'
import manifest from './manifest'

type Active = {
  disabled: boolean
  css: string | null
  appearance?: { accentColor?: string; baseFontSize?: number }
}
let stop: (() => void) | undefined
export default defineAddon({
  manifest,
  Settings: lazy(() =>
    import('./Settings').then(({ Settings }) => ({ default: Settings })),
  ),
  start(context) {
    let disposed = false
    let runtime: ReturnType<typeof import('./runtime').createRuntime> | null =
      null
    let shown = false
    let previewing = false
    let workspace: string | null | undefined
    const load = () =>
      import('./runtime').then(({ createRuntime }) => {
        runtime ??= createRuntime(context)
        return runtime
      })
    const turnOff = async () => {
      runtime?.clear()
      await context.native.invoke('select', { theme: null, snippets: [] })
      window.dispatchEvent(new Event('hibi:obsidian-themes-saved'))
    }
    const refresh = async () => {
      if (previewing) return
      const active = await context.native.query<Active>('active')
      if (disposed || previewing) return
      if (!active.css) {
        runtime?.clear()
        return
      }
      const theme = await load()
      if (disposed || previewing) return
      theme.show(active.css, active.appearance)
      if (!shown) {
        shown = true
        // Shown at first apply, in case a theme hides the settings.
        theme.safeButton(
          'Turn off Obsidian theme',
          () => void turnOff(),
          12_000,
        )
      }
    }
    const report = (error: unknown) =>
      console.error('Could not apply the Obsidian theme:', error)
    const preview = (event: Event) => {
      const detail = (event as CustomEvent<Active | null>).detail
      if (!detail?.css) {
        previewing = false
        void refresh().catch(report)
        return
      }
      previewing = true
      void load().then((theme) => {
        if (disposed || !previewing) return
        theme.show(detail.css as string, detail.appearance)
        theme.safeButton('End theme preview', () => {
          window.dispatchEvent(new CustomEvent('hibi:obsidian-themes-preview'))
        })
      })
    }
    const saved = () => {
      previewing = false
      void refresh().catch(report)
    }
    const workspaceChanged = async () => {
      const current = (await context.workspace.get())?.id ?? null
      if (disposed || current === workspace) return
      workspace = current
      await refresh()
    }
    window.addEventListener('hibi:obsidian-themes-preview', preview)
    window.addEventListener('hibi:obsidian-themes-saved', saved)
    context.editorViews.onDidChangeActive(() => {
      void workspaceChanged().catch(report)
    })
    context.commands.register({
      id: 'turn-off',
      label: 'Obsidian themes: turn off for this vault',
      keywords: 'obsidian theme snippet css reset disable',
      run: () => turnOff(),
    })
    void workspaceChanged().catch(report)
    stop = () => {
      disposed = true
      runtime?.clear()
      window.removeEventListener('hibi:obsidian-themes-preview', preview)
      window.removeEventListener('hibi:obsidian-themes-saved', saved)
    }
  },
  stop() {
    stop?.()
    stop = undefined
  },
})
