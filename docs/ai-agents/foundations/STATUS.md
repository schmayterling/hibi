# Foundations status

Integration branch: `may/foundations-sep-25-integration`, based on `751354f` (25 September 2026). No pull requests will be created or updated for this mission.

| Workstream | Implemented in branch | Wired end-to-end | Tested | Benchmarked | Integrated |
| --- | --- | --- | --- | --- | --- |
| Shared contracts | Identity, target, owner, result, and stream contracts | Yes | Typecheck and focused tests | No | Yes |
| A: documents and views | Live session/view targets, save guards, inactive target source edits | Yes for current slice | 24 focused tests and installed-addon desktop test | No | Yes |
| B: commands and shortcuts | Command-owned app shortcuts, global shortcuts, Addons menu, palette target capture | Yes for current slice | Focused unit and desktop tests | No | Yes |
| C: workspace | Sequenced snapshot/changes, scoped disk read, exclusive text create, versioned closed-file update, activation guard | Yes for current slice | Focused service and desktop bridge tests | No | Yes |
| D: addon storage | Global/workspace/session stores, lifecycle, export-option migration | Yes for current slice | Focused service, migration, and desktop tests | No | Yes |
| E: metadata and queries | Incremental reference/tag/property/heading/path queries and bounded cursor text scan | Yes for current slice | 20 service tests and installed-addon desktop test | No | Yes |
| F: editor providers | Bounded broker, addon registration, source and rich completion adapters | Yes for completion slice | 17 broker tests and both focused desktop adapter tests | No | Yes, completion slice |
| G: privileged integrations | One-use selected-text read and prompted, bounded HTTPS GET text | Yes for current slices | Focused service and installed-addon desktop tests | No | Yes, selected text and network |

Next: finish remaining workspace operations, metadata consumers, editor interactions, and privileged services, then compare performance. Current slices are partial; no workstream is declared complete. Full integration check at `e48290d` finished with 747 passed, 15 failed, 1 cancelled, and 2 skipped tests. A later focused integration run passed 17 of 18 desktop tests; addon shortcut re-enable still needs diagnosis. Baseline check result remains unknown.
