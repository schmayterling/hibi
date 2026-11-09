import { lazy } from 'react'
import { defineAddon } from '../api'
import { chosenThemes } from './chosen'
import type { ObsidianThemesState } from './client'
import manifest from './manifest'

type Active = { disabled: boolean; css: string | null; classes?: string[] }
type Preview = { css: string; classes?: string[] }
const Appearance = lazy(() =>
  import('./Appearance').then(({ Appearance }) => ({ default: Appearance })),
)
const scheme = /^obsidian-themes\.t-([a-z0-9-]+)-(light|dark)$/
let stop: (() => void) | undefined
export default defineAddon({
  manifest,
  start(context) {
    let disposed = false
    let runtime: ReturnType<typeof import('./runtime').createRuntime> | null =
      null
    let shown = false
    let previewing = false
    let themes: ObsidianThemesState['themes'] = []
    let registered = ''
    let schemes: (() => void)[] = []
    let suggested = new Set<string>()
    // The latest reload; applying waits for it so a just-installed theme is
    // a registered colorscheme before Hibi is asked to use it.
    let loading: Promise<void> = Promise.resolve()
    const load = () =>
      import('./runtime').then(({ createRuntime }) => {
        runtime ??= createRuntime(context)
        return runtime
      })
    const report = (error: unknown) =>
      console.error('Could not apply the Obsidian theme:', error)
    // The installed theme Hibi's current colorscheme stands for, if any.
    const chosen = () => scheme.exec(context.colorschemes.getActive().id)?.[1]
    const refresh = async () => {
      const preferences = context.colorschemes.getPreferences()
      chosenThemes.set([
        ...new Set(
          [preferences.light, preferences.dark].flatMap(
            (id) => scheme.exec(id)?.[1] ?? [],
          ),
        ),
      ])
      if (previewing) return
      const active = await context.native.query<Active>('active', {
        theme: chosen() ?? null,
      })
      if (disposed || previewing) return
      if (!active.css) {
        runtime?.clear()
        return
      }
      const theme = await load()
      if (disposed || previewing) return
      theme.show(active.css, {}, active.classes)
      if (!shown) {
        shown = true
        // Shown at first apply, in case a theme hides the settings.
        theme.safeButton(
          'Turn off Obsidian theme',
          () => void turnOff().catch(report),
          12_000,
        )
      }
    }
    // Installed themes join Hibi's own colorschemes, under their own heading.
    const register = () => {
      const fallback = (mode: 'light' | 'dark') =>
        context.colorschemes.list().find((item) => item.id === `hibi-${mode}`)
          ?.colors
      const key = JSON.stringify(themes.map((item) => [item.id, item.palettes]))
      if (key === registered) return
      registered = key
      for (const dispose of schemes) dispose()
      schemes = []
      for (const theme of themes)
        for (const mode of theme.palettes?.modes ?? ['light', 'dark']) {
          const base = fallback(mode)
          if (!base) continue
          try {
            schemes.push(
              context.colorschemes.register({
                id: `t-${theme.id}-${mode}`,
                name: theme.manifest.name.slice(0, 100),
                appearance: mode,
                group: 'Obsidian themes',
                author: theme.manifest.author || 'Unknown author',
                license: theme.manifest.license
                  ? {
                      name: 'Included license',
                      text: theme.manifest.license.slice(0, 32000),
                    }
                  : {
                      name: 'No license file',
                      text: 'This theme came without a license file. Check its terms before sharing it.',
                    },
                colors: {
                  background: base.background,
                  surface: base.surface,
                  ink: base.ink,
                  muted: base.muted,
                  accent: base.accent,
                  border: base.border,
                  ...theme.palettes?.[mode],
                },
              }),
            )
          } catch (error) {
            report(error)
          }
        }
    }
    const reload = async () => {
      const state = await context.native.query<ObsidianThemesState>('state')
      if (disposed || state.disabled) return
      themes = state.themes
      register()
      await refresh()
      // Offer, once per folder, what its own Obsidian settings use.
      const vault = state.vault
      const name = vault?.suggested.theme
      const workspace = (await context.workspace.get())?.id
      const copy = vault?.themes.find((item) => item.name === name)?.copy
      if (name && workspace && !suggested.has(workspace) && copy !== chosen()) {
        suggested = new Set([...suggested, workspace])
        context.notify(
          `This folder uses the Obsidian theme “${vault?.themes.find((item) => item.name === name)?.manifest.name ?? name}”. You can use it from Settings → Appearance.`,
        )
      }
    }
    const apply = (theme: string | null) => {
      const preferences = context.colorschemes.getPreferences()
      const next: { light?: string; dark?: string } = {}
      for (const mode of ['light', 'dark'] as const) {
        const current = scheme.exec(preferences[mode])
        if (theme === null) {
          if (current) next[mode] = `hibi-${mode}`
        } else if (
          themes
            .find((item) => item.id === theme)
            ?.palettes?.modes.includes(mode) ??
          true
        )
          next[mode] = `obsidian-themes.t-${theme}-${mode}`
      }
      context.colorschemes.setPreferences(next)
    }
    const turnOff = async () => {
      runtime?.clear()
      // Snippets first: going back to Hibi's colorschemes refreshes at once.
      await window.hibi.invokeAddonProfile('obsidian-themes', 'setSnippets', {
        snippets: [],
      })
      apply(null)
      await refresh()
    }
    const preview = (event: Event) => {
      const detail = (event as CustomEvent<Preview | null>).detail
      if (!detail?.css) {
        previewing = false
        void refresh().catch(report)
        return
      }
      previewing = true
      void load().then((theme) => {
        if (disposed || !previewing) return
        theme.show(detail.css, {}, detail.classes)
        theme.safeButton('End theme preview', () => {
          window.dispatchEvent(new CustomEvent('hibi:obsidian-themes-preview'))
        })
      })
    }
    const applied = (event: Event) => {
      previewing = false
      const theme = (event as CustomEvent<{ theme?: unknown } | null>).detail
        ?.theme
      void loading.then(() => apply(typeof theme === 'string' ? theme : null))
    }
    const saved = () => {
      loading = reload().catch(report)
    }
    window.addEventListener('hibi:obsidian-themes-preview', preview)
    window.addEventListener('hibi:obsidian-themes-apply', applied)
    window.addEventListener('hibi:obsidian-themes-saved', saved)
    context.colorschemes.subscribe(() => void refresh().catch(report))
    context.editorViews.onDidChangeActive(saved)
    context.settings.register({
      id: 'appearance',
      label: 'Obsidian themes',
      category: 'appearance',
      Content: Appearance,
    })
    context.commands.register({
      id: 'turn-off',
      label: 'Obsidian themes: turn off',
      keywords: 'obsidian theme snippet css reset disable',
      // The app menu and keyboard are out of a theme's reach.
      menu: { location: 'app', group: 'obsidian-themes' },
      defaultShortcut: 'mod+alt+shift+o',
      run: () => turnOff(),
    })
    saved()
    stop = () => {
      disposed = true
      runtime?.clear()
      window.removeEventListener('hibi:obsidian-themes-preview', preview)
      window.removeEventListener('hibi:obsidian-themes-apply', applied)
      window.removeEventListener('hibi:obsidian-themes-saved', saved)
    }
  },
  stop() {
    stop?.()
    stop = undefined
  },
})
