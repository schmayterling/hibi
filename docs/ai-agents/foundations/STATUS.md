# Foundations status

Integration branch: `may/foundations-sep-25-integration`, based on `751354f` (25 September 2026). No pull requests will be created or updated for this mission.

| Workstream | Implemented in branch | Wired end-to-end | Tested | Benchmarked | Integrated |
| --- | --- | --- | --- | --- | --- |
| Shared contracts | Identity, target, owner, result, and stream contracts | Yes | Typecheck and focused tests | No | Yes |
| A: documents and views | Live session/view targets, save guards, inactive target source edits | Yes for current slice | 24 focused tests and installed-addon desktop test | No | Yes |
| B: commands and shortcuts | Command-owned app shortcuts, global shortcuts, Addons menu, palette target capture | Yes for current slice | Focused unit and desktop tests | No | Yes |
| C: workspace | Sequenced snapshot/changes, scoped disk read, exclusive text create, activation guard | Yes for current slice | Focused service and desktop bridge tests | No | Yes |
| D: addon storage | Global/workspace/session stores, lifecycle, export-option migration | Yes for current slice | Focused service, migration, and desktop tests | No | Yes |
| E: metadata and queries | Incremental reference/tag/property/heading/path queries and bounded cursor text scan | Yes for current slice | 20 service tests and installed-addon desktop test | No | Yes |
| F: editor providers | Bounded broker and addon registration | No editor adapter yet | 17 broker tests | No | Yes, broker only |
| G: privileged integrations | One-use, user-selected text read | Yes for current slice | Focused service and installed-addon desktop test | No | Yes |

Next: connect source and rich completion adapters, finish remaining workspace operations and privileged services, then compare performance. Current slices are partial; no workstream is declared complete. Full integration check is running; baseline check result remains unknown.
