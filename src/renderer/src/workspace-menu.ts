import type {
  WorkspaceId,
  WorkspaceTarget,
} from '../../shared/foundation-contracts'
import type {
  WorkspaceAction,
  WorkspaceActionResult,
  WorkspaceEntry,
  WorkspaceState,
} from '../../shared/workspace'
import type { DialogApi } from '../../ui/dialogs'
import type { MenuItem } from '../../ui/menus'

export type WorkspaceRename = {
  id: string
  value: string
  selectExtension?: boolean
} | null

export function workspaceMenuItems(
  entry: WorkspaceEntry,
  {
    dialogs,
    onAction,
    create,
    rename,
  }: {
    dialogs: DialogApi
    onAction: (action: WorkspaceAction) => Promise<WorkspaceActionResult | null>
    create: (kind: 'new-file' | 'new-folder', parent: string) => Promise<void>
    rename: (target: WorkspaceRename) => void
  },
): MenuItem[] {
  const path = entry.path
  return [
    ...(entry.kind === 'folder'
      ? [
          {
            id: 'new-file',
            label: 'New file',
            onSelect: () => create('new-file', path),
          },
          {
            id: 'new-folder',
            label: 'New folder',
            onSelect: () => create('new-folder', path),
          },
        ]
      : []),
    {
      id: 'rename',
      label: 'Rename',
      onSelect: () => rename({ id: path, value: entry.name }),
    },
    {
      id: 'duplicate',
      label: 'Duplicate',
      onSelect: async () => {
        await onAction({ action: 'duplicate', path })
      },
    },
    ...(['copy', 'move'] as const).map((action) => ({
      id: action,
      label: `${action} to…`,
      async onSelect() {
        const destination = await dialogs.prompt({
          title: `${action} ${entry.name}`,
          label: 'Destination path',
          description:
            'Enter a path within this workspace, including the file or folder name.',
          defaultValue: path,
        })
        if (destination !== null) await onAction({ action, path, destination })
      },
    })),
    {
      id: 'copy-path',
      label: 'Copy relative path',
      onSelect: () =>
        window.hibi.copyWorkspacePaths([path], { absolute: false }),
    },
    {
      id: 'copy-absolute-path',
      label: 'Copy absolute path',
      onSelect: () =>
        window.hibi.copyWorkspacePaths([path], { absolute: true }),
    },
    {
      id: 'delete',
      label: 'Move to trash',
      separatorBefore: true,
      async onSelect() {
        if (
          await dialogs.confirm({
            title: `Move ${entry.name} to trash?`,
            description:
              entry.kind === 'folder'
                ? 'This includes every file and folder inside it.'
                : 'You can recover it from the system trash.',
            confirmLabel: 'Move to trash',
          })
        )
          await onAction({ action: 'delete', path })
      },
    },
  ]
}

/** Drops paths inside another selected folder, which already carries them. */
export function selectedRoots(paths: readonly string[]) {
  const selected = new Set(paths)
  return paths.filter((path) => {
    for (
      let slash = path.lastIndexOf('/');
      slash > 0;
      slash = path.lastIndexOf('/', slash - 1)
    )
      if (selected.has(path.slice(0, slash))) return false
    return true
  })
}

/** Runs one step at a time and stops at the first cancellation or error. */
export async function runEach(
  paths: readonly string[],
  verb: string,
  step: (path: string) => Promise<boolean>,
) {
  let done = 0
  try {
    for (const path of paths) {
      if (!(await step(path))) return
      done++
    }
  } catch (error) {
    if (!done) throw error
    throw new Error(
      `Hibi ${verb} ${done} of ${paths.length} items, then stopped. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

export function workspaceTarget(
  workspace: WorkspaceState | null,
): WorkspaceTarget | null {
  return workspace?.id && workspace.workspaceGeneration !== undefined
    ? {
        workspaceId: workspace.id as WorkspaceId,
        workspaceGeneration: workspace.workspaceGeneration,
      }
    : null
}

/** The main process rejects each step once another workspace replaces `target`. */
export function workspaceStep(
  target: WorkspaceTarget,
  onAction: (action: WorkspaceAction) => Promise<WorkspaceActionResult | null>,
) {
  return async (action: WorkspaceAction) =>
    !!(await onAction({ ...action, target }))
}

export function workspaceGroupMenuItems(
  target: WorkspaceTarget,
  entries: readonly WorkspaceEntry[],
  {
    dialogs,
    onAction,
    open,
  }: {
    dialogs: DialogApi
    onAction: (action: WorkspaceAction) => Promise<WorkspaceActionResult | null>
    /** Present when each file can open in its own tab. */
    open?: (path: string, target: WorkspaceTarget) => Promise<boolean>
  },
): MenuItem[] {
  const paths = selectedRoots(entries.map((entry) => entry.path))
  const run = workspaceStep(target, onAction)
  const count = `${paths.length} items`
  return [
    ...(open && entries.every((entry) => entry.kind === 'file')
      ? [
          {
            id: 'open',
            label: 'Open',
            onSelect: () =>
              runEach(paths, 'opened', (path) => open(path, target)),
          },
        ]
      : []),
    {
      id: 'duplicate',
      label: 'Duplicate',
      onSelect: () =>
        runEach(paths, 'duplicated', (path) =>
          run({ action: 'duplicate', path }),
        ),
    },
    ...(['copy', 'move'] as const).map((action) => ({
      id: action,
      label: `${action} to…`,
      async onSelect() {
        const folder = await dialogs.prompt({
          title: `${action} ${count}`,
          label: 'Destination folder',
          description:
            'Enter a folder within this workspace. Leave it empty to use the workspace root.',
          defaultValue: (paths[0] ?? '').split('/').slice(0, -1).join('/'),
        })
        if (folder === null) return
        const parent = folder.replace(/\/+$/, '')
        await runEach(paths, action === 'copy' ? 'copied' : 'moved', (path) =>
          run({
            action,
            path,
            destination: [parent, path.split('/').at(-1)]
              .filter(Boolean)
              .join('/'),
          }),
        )
      },
    })),
    {
      id: 'copy-path',
      label: 'Copy relative paths',
      onSelect: () =>
        window.hibi.copyWorkspacePaths(
          entries.map((entry) => entry.path),
          { absolute: false, target },
        ),
    },
    {
      id: 'copy-absolute-path',
      label: 'Copy absolute paths',
      onSelect: () =>
        window.hibi.copyWorkspacePaths(
          entries.map((entry) => entry.path),
          { absolute: true, target },
        ),
    },
    {
      id: 'delete',
      label: 'Move to trash',
      separatorBefore: true,
      async onSelect() {
        if (
          await dialogs.confirm({
            title: `Move ${count} to trash?`,
            description: entries.some((entry) => entry.kind === 'folder')
              ? 'This includes every file and folder inside the selected folders.'
              : 'You can recover them from the system trash.',
            confirmLabel: 'Move to trash',
          })
        )
          await runEach(paths, 'moved to trash', (path) =>
            run({ action: 'delete', path }),
          )
      },
    },
  ]
}
