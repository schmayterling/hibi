# Foundations open issues

- Targeted edits of a mounted background editor view still return `unsupported-view`; a view-aware adapter must preserve selection and history before allowing them.
- Legacy active-only `context.editor.updateMarkdown` can follow focus after an addon command awaits. New commands should use captured document targets and `context.documents`; a host-enforced async guard remains open.
- Workspace API has version-checked closed-file text updates, but rename/move, trash, binary attachment IO, and paged listing remain. Opt-in updates reset file metadata, and its path checks cannot defeat a same-user symlink swap-back race without native directory-handle IO.
- Workspace watcher events identify generation and ordered invalidations, but cannot truthfully report every external mutation's origin or content version.
- Metadata query service is exposed to addons, but Graph/Tags/Backlinks still use their prior caches. Source extraction includes wiki links and hashtags regardless of renderer flavor. Text search is a bounded scan, not an indexed/ranked search; worker offload remains open.
- Source and rich completion adapters are integrated; hover/contextual actions and the first public-API link, tag, and snippet providers remain.
- Installed addons share the renderer and global preload bridge. Main-owned activation checks prevent cooperative stale requests; they do not isolate hostile addon code or prevent another addon from spoofing an ID.
- Host network supports prompted, bounded HTTPS GET text. Credential storage and user-selected import/export grants remain open. Addons can still spoof another ID inside the shared renderer, so prompts do not provide adversarial per-addon isolation.
- Downstream quick-note addon in PR #84 uses a global shortcut callback, which loses `global-shortcut` command context; its dialog also resolves the current workspace at save time, so a focus/workspace switch can retarget a write. This is a compatibility finding, not a change to that PR.
- Full integration check at `e48290d` had 15 desktop failures and one cancellation. The preload API-key snapshot was updated; a later focused desktop group passed 17 of 18 tests. Addon shortcut re-enable failed while Settings was open; remaining full-suite failures need a new integrated run before attribution.
- Baseline and candidate performance evidence, including startup, input, targeted edits, indexing, activation, completion, and retained memory, remains to be measured on a quiet reference machine.
