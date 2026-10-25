import { siteContributions } from '../../renderer/src/site-contributions'
import type { WorkspaceState } from '../../shared/workspace'
import { defineAddon, type ExportResult, type SiteExportArtifact } from '../api'
import manifest from './manifest'
import type { ExportOptions } from './options'
import { exportPaths, preparePages } from './prepare'

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
      signal?: AbortSignal,
    ) => {
      await requireWorkspace(workspace)
      const snapshot = await context.workspace.snapshot()
      const version = siteContributions.version()
      const contributions = siteContributions
        .snapshot()
        .filter((entry) => options.addons[entry.id] !== false)
      const colorschemes = [...context.colorschemes.list()]
      const pages: (typeof snapshot.pages)[number][] = []
      const css = await preparePages(
        snapshot.pages,
        async (page) =>
          siteContributions.render(
            await context.editor.renderDocument(
              page.markdown,
              page.path,
              page.id,
            ),
            page,
            contributions,
          ),
        async (page) => {
          pages.push(page)
        },
        signal,
      )
      await requireWorkspace(workspace)
      if (version !== siteContributions.version())
        throw new Error('Enabled addons changed during export. Export again.')
      return {
        pages,
        css,
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
        const { LoadingExportDialog } = await import('./ExportDialog')
        const setup = (async () => {
          const [{ loadExportOptions }, defaults] = await Promise.all([
            import('./saved-options'),
            context.native.query<{ graph: boolean }>('options'),
          ])
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
          await requireWorkspace(workspace)
          return {
            initial,
            graph: defaults.graph,
            pages: exportPaths(workspace.entries),
            colorschemes: context.colorschemes.list(),
            contributions: siteContributions.snapshot(),
            warning,
            save: async (
              options: ExportOptions,
              password: string,
              signal?: AbortSignal,
            ) => {
              const prepared = await prepare(
                workspace,
                options,
                password,
                signal,
              )
              signal?.throwIfAborted()
              const result = await context.native.invoke<ExportResult | null>(
                'export',
                prepared,
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
              context.notify(
                `Exported ${result.pages} ${result.pages === 1 ? 'page' : 'pages'} to ${result.path}${preferencesSaved ? '' : '. Export options were not saved.'}`,
              )
              return true
            },
          }
        })()
        const formId = `export-${crypto.randomUUID()}`
        const dialog = context.dialogs.open({
          title: 'Export workspace',
          size: 'wide',
          closeOnOutsideClick: false,
          content: ({ close, signal }) => (
            <LoadingExportDialog
              formId={formId}
              context={context}
              setup={setup}
              close={close}
              signal={signal}
            />
          ),
          footer: () => <div id={`${formId}-footer`} />,
        })
        await dialog.result
      },
    })
  },
})
