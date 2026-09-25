# Foundations source map

Baseline: `751354f` on 25 September 2026. This map describes code before workstream integration.

| Concern | Current owner and crossing | Public surface or gap |
| --- | --- | --- |
| Source and saves | `src/main/document.ts` holds active source and tab snapshots. `src/renderer/src/document-runtime.ts` tracks per-tab sessions. Preload flushes journal work before document IPC; main serializes file operations. | `src/shared/desktop.ts` exposes `tabId`, `revision`, and `contentVersion`; active-document APIs still dominate. |
| View state | `src/renderer/src/source-view.ts`, `SourceEditor.tsx`, and `Editor.tsx` own source/rich editor instances and selection. | Addon UI views are separate; no public editor `ViewId` yet. |
| Targeted editing | `src/shared/document-edits.ts` defines guarded source edit requests and renderer dispatch applies them. | `src/renderer/src/document-edits.ts` rejects a request when its target is not the active document. |
| Workspace mutation | `src/main/workspace-actions.ts` validates paths and performs explorer actions, then `src/main/index.ts` broadcasts changes. | Addon workspace API reads/indexes but has no scoped file mutation or change subscription. Explorer actions can change focus and drafts. |
| Metadata | `src/main/workspace.ts` and `workspace-index-cache.ts` cache disk/draft versions. `src/addons/workspace-snapshot.ts` shares index requests while consumers are mounted. | Public `workspace.index()` sends page Markdown; graph, tags, and backlinks derive separate relationship views. |
| Commands | `src/renderer/src/addons.ts` owns addon command registrations and lazy activation descriptors; core hotkeys live in `src/shared/hotkeys.ts` and main. | Addon commands lack captured document/view context, configurable shortcut transport, and menu contributions. |
| Storage | Bundled addons use `localStorage`; `src/main/addons.ts` persists enabled state. | No namespaced public storage or migration contract. |
| Privileged work | Main accepts trusted window IPC and enabled bundled native handlers; installed addon JavaScript runs in shared renderer. | Per-addon privileged grants are not enforceable in that shared realm. |

Startup package reachability and performance remain unmeasured for this baseline. Existing test bases include `tests/document-tabs.test.mjs`, `tests/document-edits.test.mjs`, `tests/workspace-index.test.mjs`, `tests/addon-activation.test.mjs`, and `tests/registration-batch.test.mjs`.
