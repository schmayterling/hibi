import {
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
} from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type {
  CommandExecutionContext,
  WorkspaceTarget,
} from '../../shared/foundation-contracts'
import type {
  WorkspaceAction,
  WorkspaceActionResult,
  WorkspaceEntry,
  WorkspaceState,
} from '../../shared/workspace'
import { IconButton } from '../../ui/Controls'
import { useDialogs } from '../../ui/DialogProvider'
import { useMenus } from '../../ui/MenuHost'
import { Sidebar, type SidebarItem, type SidebarProps } from '../../ui/Sidebar'
import type { RegisteredCommand } from './addons'
import { explorerDecorations } from './explorer-decorations'
import {
  runEach,
  selectedRoots,
  type WorkspaceRename,
  workspaceGroupMenuItems,
  workspaceMenuItems,
  workspaceStep,
  workspaceTarget,
} from './workspace-menu'

export function WorkspaceSidebar({
  workspace,
  onOpen,
  onFile,
  tabs,
  onRefresh,
  commands,
  captureCommandContext,
  open,
  overlay,
  onDismiss,
  resize,
  dirty,
  busy,
  onAction,
  onError,
  editing,
  onEditing: setEditing,
}: {
  workspace: WorkspaceState | null
  onOpen: () => void
  onFile: (path: string, target?: WorkspaceTarget) => Promise<boolean>
  /** Each opened file gets its own tab, so a group can open together. */
  tabs: boolean
  onRefresh: () => void
  commands: RegisteredCommand[]
  captureCommandContext: (
    entry: WorkspaceEntry,
  ) => CommandExecutionContext | null
  open: boolean
  overlay: boolean
  onDismiss: () => void
  resize: NonNullable<SidebarProps['resize']>
  dirty: boolean
  busy: boolean
  onAction: (action: WorkspaceAction) => Promise<WorkspaceActionResult | null>
  onError: (error: unknown) => void
  editing: WorkspaceRename
  onEditing: (target: WorkspaceRename) => void
}) {
  const menu = useMenus(onError)
  const dialogs = useDialogs()
  const [renaming, setRenaming] = useState(false)
  const committing = useRef(false)
  const decorations = useSyncExternalStore(
    explorerDecorations.subscribe,
    explorerDecorations.snapshot,
  )
  const rootDecoration = decorations.get('')
  const workspaceCommands = commands.filter((command) => command.workspace)
  // Opening a file or another workspace replaces the selection with the active file.
  const scope = `${workspace?.id}:${workspace?.workspaceGeneration}:${workspace?.activePath}`
  const [picked, setPicked] = useState({ scope: '', ids: [] as string[] })
  const activePath = workspace?.activePath
  const selection = useMemo(
    () =>
      picked.scope === scope ? picked.ids : activePath ? [activePath] : [],
    [picked, scope, activePath],
  )
  useLayoutEffect(() => {
    explorerDecorations.setWorkspace(workspace)
  }, [workspace])
  useEffect(() => {
    const refresh = () => explorerDecorations.setWorkspace(workspace)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [workspace])
  async function create(kind: 'new-file' | 'new-folder', parent = '') {
    try {
      await onAction({ action: kind, path: parent })
    } catch (error) {
      onError(error)
    }
  }
  async function commitRename() {
    if (!editing || committing.current || busy) return
    committing.current = true
    setRenaming(true)
    try {
      if (
        await onAction({
          action: 'rename',
          path: editing.id,
          destination: editing.value,
        })
      )
        setEditing(null)
    } catch (error) {
      onError(error)
    } finally {
      committing.current = false
      setRenaming(false)
    }
  }
  function openMenu(path: string, anchor: HTMLElement, paths = [path]) {
    if (busy || !workspace) return
    const target = workspaceTarget(workspace)
    const find = (entries: WorkspaceEntry[]): WorkspaceEntry | undefined => {
      for (const entry of entries) {
        if (entry.path === path) return entry
        const nested = entry.children && find(entry.children)
        if (nested) return nested
      }
    }
    if (target && paths.length > 1) {
      const wanted = new Set(paths)
      const group: WorkspaceEntry[] = []
      const collect = (entries: WorkspaceEntry[]) => {
        for (const entry of entries) {
          if (wanted.has(entry.path)) group.push(entry)
          if (entry.children) collect(entry.children)
        }
      }
      collect(workspace.entries)
      menu.open({
        label: `Actions for ${group.length} items`,
        anchor,
        items: workspaceGroupMenuItems(target, group, {
          dialogs,
          onAction,
          ...(tabs ? { open: onFile } : {}),
        }),
      })
      return
    }
    const entry = find(workspace.entries)
    if (!entry) return
    const contributions = commands
      .filter((command) => command.menu?.location === 'explorer')
      .sort(
        (left, right) =>
          String(left.menu?.group ?? '').localeCompare(
            String(right.menu?.group ?? ''),
          ) ||
          (left.menu?.order ?? 0) - (right.menu?.order ?? 0) ||
          left.id.localeCompare(right.id),
      )
    const context = contributions.length ? captureCommandContext(entry) : null
    menu.open({
      label: `Actions for ${entry.name}`,
      anchor,
      items: [
        ...workspaceMenuItems(entry, {
          dialogs,
          onAction,
          create,
          rename: setEditing,
        }),
        ...(context
          ? contributions.map((command, index) => ({
              id: command.id,
              label: command.label,
              disabled: !command.canRun(context),
              separatorBefore:
                index === 0 ||
                command.menu?.group !== contributions[index - 1]?.menu?.group,
              onSelect: () => command.run(context),
            }))
          : []),
      ],
    })
  }
  const items = useMemo(() => {
    const convert = (entries: WorkspaceEntry[]): SidebarItem[] =>
      entries.map((entry) => ({
        id: entry.path,
        label: entry.name,
        icon: entry.kind === 'folder' ? Folder : FileText,
        dirty: workspace?.activePath === entry.path ? dirty : !!entry.dirty,
        ...(decorations.has(entry.path)
          ? { decoration: decorations.get(entry.path)! }
          : {}),
        ...(entry.children ? { children: convert(entry.children) } : {}),
      }))
    return convert(workspace?.entries ?? [])
  }, [workspace?.entries, workspace?.activePath, dirty, decorations])
  return (
    <Sidebar
      // Another workspace starts with fresh expansion, focus, and range state.
      key={`${workspace?.id}:${workspace?.workspaceGeneration}`}
      resize={resize}
      disabled={busy}
      open={open}
      overlay={overlay}
      onDismiss={onDismiss}
      className={`document-sidebar workspace-sidebar ${workspace ? '' : 'workspace-empty'}`}
      items={items}
      selected={workspace?.activePath ?? null}
      selection={{
        ids: selection,
        onChange: (ids) => setPicked({ scope, ids }),
      }}
      onSelect={onFile}
      onMenu={openMenu}
      onMove={(path, parent, paths = [path]) => {
        const target = workspaceTarget(workspace)
        if (!target) return
        const destination = (path: string) =>
          [parent, path.split('/').at(-1)].filter(Boolean).join('/')
        const moving = selectedRoots(paths).filter(
          (path) => path !== destination(path),
        )
        const run = workspaceStep(target, onAction)
        void runEach(moving, 'moved', (path) =>
          run({ action: 'move', path, destination: destination(path) }),
        ).catch(onError)
      }}
      editing={
        editing && {
          ...editing,
          disabled: renaming || busy,
          onChange: (value) => setEditing({ ...editing, value }),
          onCommit: () => void commitRename(),
          onCancel: () => setEditing(null),
        }
      }
      label="Workspace files"
      header={
        workspace && (
          <>
            <span
              data-tooltip={rootDecoration?.label}
              style={{
                color: rootDecoration?.color
                  ? `var(--${rootDecoration.color})`
                  : undefined,
              }}
            >
              {workspace?.name ?? 'Workspace'}
            </span>
            <IconButton
              aria-label="New workspace file"
              title="New file"
              disabled={busy}
              onClick={() => void create('new-file')}
            >
              <FilePlus2 size={14} />
            </IconButton>
            <IconButton
              aria-label="New workspace folder"
              title="New folder"
              disabled={busy}
              onClick={() => void create('new-folder')}
            >
              <FolderPlus size={14} />
            </IconButton>
            <IconButton
              type="button"
              aria-label="Open workspace"
              title="Open folder"
              disabled={busy}
              onClick={onOpen}
            >
              <FolderOpen size={15} />
            </IconButton>
            {workspace && (
              <IconButton
                type="button"
                aria-label="Refresh workspace"
                title="Refresh files"
                disabled={busy}
                onClick={onRefresh}
              >
                <RefreshCw size={14} />
              </IconButton>
            )}
          </>
        )
      }
      empty={
        workspace ? (
          'No files to show in this folder.'
        ) : (
          <button
            className="open-workspace"
            type="button"
            aria-label="Open workspace"
            disabled={busy}
            onClick={onOpen}
          >
            <FolderOpen size={28} strokeWidth={1.25} aria-hidden="true" />
            <span>Open a folder</span>
          </button>
        )
      }
      footer={
        workspace && workspaceCommands.length > 0
          ? workspaceCommands.map((command) => (
              <button
                key={command.id}
                type="button"
                disabled={busy}
                onClick={() => void command.run()}
              >
                {command.label}
              </button>
            ))
          : null
      }
    />
  )
}
