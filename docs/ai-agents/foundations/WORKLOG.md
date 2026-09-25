# Foundations worklog

## 2026-09-25

- Read mission and implementation plan; fetched current `origin/main` at `751354f` and created integration branch from it.
- Inspected existing addon, document, workspace, index, editor, and native-addon paths. #99 is one stale commit with an `Editor.tsx` conflict; #83 is four stale commits and #84/#90 are downstream compatibility inputs.
- Installed locked dependencies under Node 24.11.0. Baseline `npm run check` started before source edits; tool capture timed out after five minutes while tests continued, so its final result is unknown.
- Seeded shared identity, targeting, result, and ownership contracts for workstream use. No service is marked complete by this seed.
- Committed the contract seed at `589fc58`, fast-forwarded the integration branch, and pushed it without creating a pull request. Started four isolated workstream branches from that commit.
- Integrated document session/view targeting, save-race guards, and inactive source edits; installed-addon target edit desktop test passed.
- Integrated command-backed shortcuts, native Addons menu, palette context capture, and recorder cleanup. Focused command and core hotkey desktop tests passed after synchronizing native input delivery in the test helper.
- Integrated workspace change stream, scoped text read/create, owner-checked create, and incremental metadata query services. Workspace bridge and 29 combined service tests passed; metadata IPC remains unwired.
- Integrated addon storage and documentation export preference migration, plus one-use user-selected text reads. Installed-addon desktop tests for storage and selected text passed.
- Pushed integration branch through `8c63cd8`. No pull request was created. Generated API docs, full `npm run check`, hosted checks, and candidate performance runs remain pending.
- Exposed bounded metadata queries through main IPC and addon context. Installed-addon query test passed; 20 focused metadata/workspace tests passed. Added completion broker registration, with editor adapters in isolated branches.
- Regenerated addon API reference and English copy catalog. `docs:check` and `copy:check` passed before the full integration check started. Pushed branch through `e48290d`; no pull request or hosted branch run exists.
- Full `npm run check` at source `e48290d` completed: 765 tests, 747 passed, 15 failed, 1 cancelled, 2 skipped. The run was not green. It included an expected stale preload-key snapshot and multiple focus/cleanup desktop failures; focused diagnosis is in progress. The runner duration was 1,925,385 ms.

## 2026-09-26

- Integrated lazy completion loading, source and rich completion adapters, versioned closed-file text updates, and a prompted bounded HTTPS GET host service. Focused source, rich, workspace, network, preload, and focus desktop tests passed in one serial group; addon shortcut re-enable remained the sole failure (17 passed, 1 failed).
- Reverted a global Electron test-helper focus change that correlated with full-suite UI failures. Kept settings exit synchronous from the app's perspective while clearing shortcut recording before returning. Pushed the integration branch through `0579d75` without a pull request.
- `npm run typecheck` passed at the current bridge state. `docs:check` and `copy:check` reported generated docs/catalogs outdated after the new public APIs; regeneration follows the remaining API integrations.
- Integrated binary workspace IO, versioned closed-file move/trash, paged entry reads, and safer existing copy/move destinations. Graph, Tags, and Backlinks now consume bounded shared metadata queries; a concurrent cursor race was fixed. Restored the older Obsidian backup dialog layout; its focused desktop test passed 2/2.
- Integrated host credentials, one-use selected import/export, hover/context actions, lazy provider loading, and the Writing suggestions addon. An independent proof addon exercises the public package surface; its installed desktop consumer passed. Credential backend waits now have bounded cancellation and late-result handling.
- Added targeted document save/lifecycle reads, seeded model sequences, and a guard for stale legacy command edits. Scoped shortcut replacement preserves the old OS binding if the new one fails. Rotated addon session leases on pre-finish main-frame reloads after a security review; held-grant desktop test passed.
- Combined integration build, typecheck, and lint passed. Serial desktop groups passed 24/24, 16/16, and 14/14 at successive heads. Pushed integration through `ee07668` without a pull request. Final-head full check, generated docs/catalogs, cross-platform results, and paired performance runs remain open.
- Added explorer and editor command menu slots with captured targets and stale-context rejection. Regenerated API docs and English copy catalog; `docs:check`, `copy:check`, lint, and typecheck passed on that branch state. An export boundary audit found extra snapshot fields and raw renderer HTML entering static site JSON; narrowed published fields and sanitized HTML before serialization. Focused site/flavor tests passed 6/6 and addon catalog test 1/1.
