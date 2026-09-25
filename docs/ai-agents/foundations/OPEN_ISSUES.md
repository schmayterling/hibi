# Foundations open issues

- Targeted edits of a mounted background editor view still return `unsupported-view`; a view-aware adapter must preserve selection and history before allowing them.
- Legacy active-only `context.editor.updateMarkdown` can follow focus after an addon command awaits. New commands should use captured document targets and `context.documents`; a host-enforced async guard remains open.
- Workspace API still needs version-checked closed-file updates, rename/move, trash, binary attachment IO, and paged listing. Its path checks cannot defeat a same-user symlink swap-back race without native directory-handle IO.
- Workspace watcher events identify generation and ordered invalidations, but cannot truthfully report every external mutation's origin or content version.
- Metadata query service is exposed to addons, but Graph/Tags/Backlinks still use their prior caches. Source extraction includes wiki links and hashtags regardless of renderer flavor. Text search is a bounded scan, not an indexed/ranked search; worker offload remains open.
- Completion broker is registered through the addon API, but source/rich editor adapters and acceptance UI are not yet integrated.
- Installed addons share the renderer and global preload bridge. Main-owned activation checks prevent cooperative stale requests; they do not isolate hostile addon code or prevent another addon from spoofing an ID.
- Host services beyond user-selected text, including network and credentials, remain open.
- Baseline and candidate performance evidence, including startup, input, targeted edits, indexing, activation, completion, and retained memory, remains to be measured on a quiet reference machine.
