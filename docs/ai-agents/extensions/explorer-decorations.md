# Workspace decorations

Use `context.workspace.registerDecorations({ id, provide })` to add badges and colors to workspace rows. Addons supply status data; the shared sidebar retains selection, menus, and accessibility behavior.

```typescript
const remove = context.workspace.registerDecorations({
  id: 'status',
  async provide(workspace) {
    const result = await context.native.query<{
      workspaceId: string
      files: { path: string }[]
    } | null>('status')
    if (!result || result.workspaceId !== workspace.id) return []
    return result.files.map(file => ({
      path: file.path,
      badge: 'M',
      label: 'modified on disk',
      color: 'status-warning',
    }))
  },
})
```

`path` is workspace-relative and uses `/`; an empty path decorates the workspace heading. `label` is the tooltip and accessible description. Optional `badge` is a short visible marker; `color` names a semantic theme token. Colors apply to names and icons, including selected rows. Badges do not change accessible filenames or replace unsaved-edit dots.

Return a complete replacement set, including any parent-folder decorations. If providers decorate the same path, the last registered provider wins. Unregistering or stopping removes its decorations. Updates never expand folders or move keyboard focus.

The host debounces workspace changes and refreshes on window focus. Each provider runs one request at a time; outdated workspace results and disposed-provider results are discarded. Compare the opaque `WorkspaceState.id` to identify a folder, not its display name.

Equal results do not notify the explorer. It passes decorations and unsaved dots to the shared sidebar's `status` map, so status changes keep the tree model, and a closed explorer applies the latest results when it opens.

## Native reads

Trusted native addons can export `queries` alongside `methods`. `context.native.query(method, input?)` calls only explicitly exported queries in the same enabled addon. Queries wait for an active file operation, then read without taking the mutation lock. They must not write documents/repositories or show dialogs. Use `native.invoke` for changes. Installed renderer extensions cannot add native code.

Capture `context.workspace.id()` before a query and return it with the result. Callers must recheck it after asynchronous work, because reads can overlap saves or folder changes.

See the [workspace API](https://docs.hibi.garden/#page=development%2Faddon-api-reference%2FExplorerDecorationProvider.md), [addon API](https://docs.hibi.garden/#page=development%2Faddon-api-reference%2FREADME.md), and [sidebar API](https://docs.hibi.garden/#page=development%2Faddon-api-reference%2FSidebar.md).
