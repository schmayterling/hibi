import { siteContributions } from '../../renderer/src/site-contributions'
import type { WorkspaceState } from '../../shared/workspace'
import { defineAddon, type ExportResult, type SiteExportArtifact } from '../api'
import manifest from './manifest'
import type { ExportOptions } from './options'

export default defineAddon({
  manifest,
  start(context) {
    const requireWorkspace = async (workspace: WorkspaceState) => {
      const current = await context.workspace.get()
      if (
        !workspace.id ||
        workspace.workspaceGeneration === undefined ||
        current?.id !== workspace.id ||
        current?.workspaceGeneration !== workspace.workspaceGeneration
      )
        throw new Error('Workspace changed. Open export again.')
      return {
        id: workspace.id,
        workspaceGeneration: workspace.workspaceGeneration,
      }
    }
    const prepare = async (
      workspace: WorkspaceState,
      options: ExportOptions,
      password = '',
    ) => {
      await requireWorkspace(workspace)
      const snapshot = await context.workspace.snapshot()
      const version = siteContributions.version()
      const contributions = siteContributions
        .snapshot()
        .filter((entry) => options.addons[entry.id] !== false)
      const colorschemes = [...context.colorschemes.list()]
      const styles = new Set<string>()
      const pages = []
      for (const page of snapshot.pages) {
        const rendered = await siteContributions.render(
          await context.editor.renderDocument(
            page.markdown,
            page.path,
            page.id,
          ),
          page,
          contributions,
        )
        if (rendered.css) styles.add(rendered.css)
        pages.push({
          path: page.path,
          markdown: page.markdown,
          html: rendered.html,
        })
      }
      await requireWorkspace(workspace)
      if (version !== siteContributions.version())
        throw new Error('Enabled addons changed during export. Export again.')
      return {
        pages,
        css: [...styles].join('\n'),
        colorschemes,
        addons: contributions.map(({ id, name, css }) => ({ id, name, css })),
        options,
        password,
      }
    }
    context.exports.provide({
      version: 1,
      async buildSite(
        input: Partial<ExportOptions> = {},
      ): Promise<SiteExportArtifact> {
        const workspace = await context.workspace.get()
        if (!workspace) throw new Error('Open a workspace to publish it.')
        const target = await requireWorkspace(workspace)
        const store = await context.storage.workspace<ExportOptions>(
          target,
          'export-options',
          1,
        )
        const { publishingOptions } = await import('./saved-options')
        const options = await publishingOptions(
          store,
          localStorage.getItem(`hibi:export:${workspace.id}`),
          workspace.name,
          context.colorschemes.getPreferences(),
          input,
        )
        return context.native.query<SiteExportArtifact>(
          'build',
          await prepare(workspace, options),
        )
      },
    })
    context.commands.register({
      id: 'export',
      label: 'Export workspace to HTML',
      async run() {
        const workspace =
          (await context.workspace.get()) ?? (await context.workspace.open())
        if (!workspace) return
        const target = await requireWorkspace(workspace)
        const [{ ExportDialog }, { loadExportOptions }, defaults, index] =
          await Promise.all([
            import('./ExportDialog'),
            import('./saved-options'),
            context.native.query<{ graph: boolean }>('options'),
            context.workspace.index(),
          ])
        if (
          !index ||
          index.workspace.id !== target.id ||
          index.workspace.workspaceGeneration !== target.workspaceGeneration
        )
          throw new Error('Workspace changed. Open export again.')
        const legacyKey = `hibi:export:${workspace.id}`
        let legacyText: string | null = null
        try {
          legacyText = localStorage.getItem(legacyKey)
        } catch {
          /* Host-owned storage remains usable when legacy storage is unavailable. */
        }
        const store = await context.storage.workspace<ExportOptions>(
          target,
          'export-options',
          1,
        )
        const { initial, warning, canSave } = await loadExportOptions(
          store,
          legacyText,
          workspace.name,
          context.colorschemes.getPreferences(),
        )
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
              pages={index.pages}
              colorschemes={context.colorschemes.list()}
              contributions={siteContributions.snapshot()}
              warning={warning}
              save={async (options, password) => {
                const result = await context.native.invoke<ExportResult | null>(
                  'export',
                  await prepare(workspace, options, password),
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
