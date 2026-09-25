import type { ThemePreferences } from '../../shared/colorschemes'
import { defineAddon, type ExportResult } from '../api'
import manifest from './manifest'
import type { ExportOptions } from './options'

export default defineAddon({
  manifest,
  start(context) {
    context.commands.register({
      id: 'export',
      label: 'Export workspace to HTML',
      async run() {
        const workspace =
          (await context.workspace.get()) ?? (await context.workspace.open())
        if (!workspace) return
        if (!workspace.id || workspace.workspaceGeneration === undefined)
          throw new Error('Open a workspace to export it.')
        const [{ ExportDialog }, { loadExportOptions }, defaults] =
          await Promise.all([
            import('./ExportDialog'),
            import('./saved-options'),
            context.native.query<{ theme: ThemePreferences; graph: boolean }>(
              'options',
            ),
          ])
        const legacyKey = `hibi:export:${workspace.id}`
        let legacyText: string | null = null
        try {
          legacyText = localStorage.getItem(legacyKey)
        } catch {
          /* Host-owned storage remains usable when legacy storage is unavailable. */
        }
        const store = await context.storage.workspace<ExportOptions>(
          {
            id: workspace.id,
            workspaceGeneration: workspace.workspaceGeneration,
          },
          'export-options',
          1,
        )
        const { initial, warning, canSave } = await loadExportOptions(
          store,
          legacyText,
          workspace.name,
          defaults.theme,
        )
        const requireWorkspace = async () => {
          const current = await context.workspace.get()
          if (
            current?.id !== workspace.id ||
            current?.workspaceGeneration !== workspace.workspaceGeneration
          )
            throw new Error('Workspace changed. Open export again.')
        }
        const formId = `export-${crypto.randomUUID()}`
        const dialog = context.dialogs.open({
          title: 'Export workspace',
          size: 'wide',
          closeOnOutsideClick: false,
          content: ({ close }) => (
            <ExportDialog
              formId={formId}
              context={context}
              initial={initial}
              graph={defaults.graph}
              warning={warning}
              save={async (options, password) => {
                await requireWorkspace()
                const snapshot = await context.workspace.snapshot()
                const styles = new Set<string>()
                const pages = []
                for (const page of snapshot.pages) {
                  const rendered = await context.editor.renderDocument(
                    page.markdown,
                    page.path,
                    page.id,
                  )
                  if (rendered.css) styles.add(rendered.css)
                  pages.push({
                    path: page.path,
                    markdown: page.markdown,
                    html: rendered.html,
                  })
                }
                await requireWorkspace()
                const result = await context.native.invoke<ExportResult | null>(
                  'export',
                  { pages, css: [...styles].join('\n'), options, password },
                )
                if (!result) return false
                let preferencesSaved = false
                if (canSave)
                  try {
                    preferencesSaved =
                      (await store.set(options)).status === 'saved'
                  } catch {
                    /* Export succeeds even if preference storage fails. */
                  }
                close()
                context.notify(
                  `Exported ${result.pages} ${result.pages === 1 ? 'page' : 'pages'} to ${result.path}${preferencesSaved ? '' : '. Export options were not saved.'}`,
                )
                return true
              }}
            />
          ),
          footer: () => <div id={`${formId}-footer`} />,
        })
        await dialog.result
      },
    })
  },
})
