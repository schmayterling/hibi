# Foundations status

Integration branch: `may/foundations-sep-25-integration`, based on `751354f` and merged with `origin/main` at `35ef3fd`. No pull requests will be created or updated for this mission.

| Workstream | Implemented in branch | Wired end-to-end | Tested | Benchmarked | Integrated |
| --- | --- | --- | --- | --- | --- |
| Shared contracts | Identity, target, owner, result, and stream contracts | Yes | Typecheck and focused tests | No | Yes |
| A: documents and views | Live session/view targets, save guards, inactive target source edits, lifecycle metadata, targeted save, public `editorViews` selection/reveal/subscriptions, legacy async command guard | Yes for current one-view slice | Focused model/service and installed-addon rich/source/plain desktop tests | No | Yes |
| B: commands and shortcuts | Command-owned app shortcuts, global shortcuts with atomic replacement, Addons menu, palette/context/toolbar target capture, composed quick-note addon | Yes for current slice | Focused unit and desktop tests | No | Yes |
| C: workspace | Sequenced snapshot/changes, paged listing, scoped text/binary IO, exclusive create, versioned closed-file update/move/trash | Yes for current slice | Focused service and desktop bridge tests | No | Yes |
| D: addon storage | Global/workspace/session stores, lifecycle, export-option migration | Yes for current slice | Focused service, migration, and desktop tests | No | Yes |
| E: metadata and queries | Incremental references/tags/properties/headings, bounded cursor search, shared Graph/Tags/Backlinks consumers | Yes for current slice | Focused service and desktop consumer tests | No | Yes |
| F: editor providers | Bounded completion, hover, and action brokers; source/rich adapters; writing suggestions | Yes for supported slices | Focused broker and installed-addon desktop tests | No | Yes |
| G: privileged integrations | One-use selected text, prompted HTTPS GET text, credential vault, selected import/export handles | Yes for current slices | Focused service and installed-addon desktop tests | No | Yes |
| H: proof consumer | Independently installed public-API addon and deterministic document model | Yes for supported slices | Proof desktop consumer and model tests | No | Yes |

Current slices remain partial. Full local `npm run check` at `37bce43` passed 879 tests, failed none, and skipped two. Its clean hosted matrix is not green: mac packaging and windows proof diagnostics hit the previous 20-minute job cap, while ubuntu exposed a reload-readiness failure. The final integration head, clean cross-platform matrix, and baseline/candidate performance comparison remain pending. Draft #90's two-pane composition is being tested on a separate branch; it is absent here.
