import { siteContributions } from '../../renderer/src/site-contributions'
import type { WorkspaceState } from '../../shared/workspace'
import { defineAddon, type ExportResult, type SiteExportArtifact } from '../api'
import manifest from './manifest'
import type { ExportOptions } from './options'
import { preparePages } from './prepare'

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
      {
        password = '',
        signal,
        inMemory = false,
      }: {
        password?: string
        signal?: AbortSignal | undefined
        inMemory?: boolean
      } = {},
    ) => {
      const target = await requireWorkspace(workspace)
      signal?.throwIfAborted()
      const version = siteContributions.version()
      const contributions = siteContributions
        .snapshot()
        .filter((entry) => options.addons[entry.id] !== false)
      const colorschemes = [...context.colorschemes.list()]
      const session = await context.native.query<{
        token: string
        paths: string[]
      }>('begin', {
        target: {
          workspaceId: target.id,
          workspaceGeneration: target.workspaceGeneration,
        },
        options,
      })
      const cancel = () =>
        context.native.query('cancel', { token: session.token })
      const abort = () => {
        void cancel().catch(console.error)
      }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        async function* sources() {
          for (const _path of session.paths) {
            signal?.throwIfAborted()
            yield await context.native.query<
              import('../../shared/workspace').WorkspacePage
            >('page', { token: session.token })
          }
        }
        const css = await preparePages(
          sources(),
          async (page) => {
            const rendered = await context.editor.renderDocument(
              page.markdown,
              page.path,
              page.id,
            )
            signal?.throwIfAborted()
            return siteContributions.render(
              rendered,
              page,
              contributions,
              signal,
            )
          },
          async (page) => {
            await context.native.query('stage', { token: session.token, page })
          },
          signal,
        )
        await requireWorkspace(workspace)
        signal?.throwIfAborted()
        if (version !== siteContributions.version())
          throw new Error('Enabled addons changed during export. Export again.')
        const prepared = {
          token: session.token,
          css,
          colorschemes,
          addons: contributions.map(({ id, name, css }) => ({ id, name, css })),
          password,
          inMemory,
        }
        await context.native.query('seal', prepared)
        signal?.throwIfAborted()
        await requireWorkspace(workspace)
        if (version !== siteContributions.version())
          throw new Error('Enabled addons changed during export. Export again.')
        return prepared
      } catch (error) {
        await cancel()
        throw error
      } finally {
        signal?.removeEventListener('abort', abort)
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
        const prepared = await prepare(workspace, options, { inMemory: true })
        try {
          return await context.native.query<SiteExportArtifact>(
            'build',
            prepared,
          )
        } finally {
          await context.native.query('cancel', { token: prepared.token })
        }
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
            context.native.query<{ graph: boolean; pages: { path: string }[] }>(
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
            pages: defaults.pages,
            colorschemes: context.colorschemes.list(),
            contributions: siteContributions.snapshot(),
            warning,
            save: async (
              options: ExportOptions,
              password: string,
              signal?: AbortSignal,
            ) => {
              const prepared = await prepare(workspace, options, {
                password,
                signal,
              })
              let result: ExportResult | null
              try {
                signal?.throwIfAborted()
                result = await context.native.invoke<ExportResult | null>(
                  'export',
                  prepared,
                )
              } finally {
                await context.native.query('cancel', { token: prepared.token })
              }
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
        void setup.catch(() => {})
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
