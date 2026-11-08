# workspace service

The workspace adapter maps Hibi's mounted editor views to `WorkspaceLeaf` objects using exact document and view generations. `getActiveFile`, `getActiveLeaf`, `getLeaf`, `iterateAllLeaves`, `getLeavesOfType` and `rootSplit.children` describe those views. A detached view target becomes unavailable instead of resolving to a replacement editor.

The editor contribution installs `setMarkdownViewFactory` for the vault lifetime. Its `MarkdownView` instances then back `leaf.view`, `getActiveViewOfType` and `activeEditor`. The editor lane supplies `editor-change` and `updateOptions`; this service supplies `file-open`, `active-leaf-change`, `layout-change`, layout readiness and the browser unload `quit` signal. Reloading the renderer also emits the unload signal.

`openLinkText` resolves existing notes through the metadata cache and uses Hibi's normal file opening flow. Unresolved links reject. Opening a file in an inactive pane, creating plugin-controlled editor splits/windows and restoring arbitrary layouts are unsupported. `getLeaf(true)` supplies a new request leaf; opening a note still follows Hibi's tab preferences. The root split is a read-only view of mounted editor leaves, not a complete Obsidian layout serializer.

Plugins can register a unique view type with `registerView` and subclass `ItemView`. A custom view opens in Hibi's existing addon sidebar on the requested side. Its DOM, lifecycle, actions and sidebar handle are removed on plugin unload. `getLeftLeaf` and `getRightLeaf` create sidebar request leaves. Custom leaves appear in `iterateAllLeaves` and `getLeavesOfType`; active editor queries continue to follow Hibi's editor focus. Sidebar focus is not presented as an editor selection.

The handwritten `workspace-api` fixture tests a custom panel and exact teardown. Scoped tests also exercise document identity, leaf changes and byte-identical untouched vault files. The service module must register after the vault module and before plugin `onload`.
