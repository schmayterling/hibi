# Foundations decisions

## 2026-09-25: branch delivery

The current user instruction overrides the attached plan's pull request workflow. Preserve #83 and #99 as source material, with their commit provenance, on new workstream branches. Assemble and test on `may/foundations-sep-25-integration`. Do not update existing pull requests or merge to main.

## 2026-09-25: identity and lifetime seed

Use distinct public types for workspace, file, live document, editor view, addon, and transport request identities. These branded strings prevent accidental mixing at compile time; host validation and generation checks establish authority at runtime. A document ID survives focus and rename within a live session, then expires on close. Its generation changes when the session is replaced, not when focus changes. A view ID names one editor instance. Rename, move, and deletion invalidate a file ID; external changes and restart have no preservation guarantee. Workspace and addon activation generations invalidate pending work after replacement or restart.

Current `DocumentState.tabId` is a window-local tab identity, `DocumentState.id` follows a path or draft, `revision` advances on activation/replacement, and `contentVersion` advances on text edits. None is silently redefined as the new live document ID. New targeted edits will compare the captured document generation and content version. Existing API v1/v2 behavior remains available.

New services use operation-specific failures within `OperationResult` and function disposers. Existing handle objects with `dispose()` remain compatible. Addon-scoped registrations die on disable; workspace-scoped registrations also die on workspace change; document-scoped work dies on close; view-scoped work dies on view close. `CommandExecutionContext` captures targets when invoked, including the specifically selected file for an explorer menu. Workspace change sequence numbers are ordered within one workspace generation; a `resync` event or null paths require a fresh snapshot. Cancellation across IPC uses a request ID and owned cancel message; local `AbortSignal` values never cross IPC. Ordinary metadata listing must avoid source copies; source reads remain explicit.

The document journal remains the content authority. Workspace file writes involving open documents must coordinate with it. The main process validates disk paths and privileged requests. Renderer bindings own editor views and addon registrations. No generic IPC escape hatch is added.

## 2026-09-26: scoped host services

Installed addons still share a renderer and its preload bridge. Main-owned activation generations, window leases, and operation grants prevent stale cooperative requests; they do not isolate hostile same-realm addons or prevent owner-ID spoofing. Renderer session leases rotate on every main-frame navigation after the initial start, including reloads before the first finished load.

Network access starts with one bounded HTTPS GET text operation. Each URL and redirect needs a fresh user grant; local/private addresses need a separate grant. DNS answers are pinned to the approved request, and response, decompression, concurrency, and time are capped. No note text, cookies, or ambient credentials are attached automatically. A general HTTP client would expand authority before the trust boundary can support it.

Credential values are host-owned. The public bridge can store, remove, and inspect status, but cannot read a stored secret. Persistent storage uses Electron safeStorage only when a protected backend is available; Linux `basic_text` is rejected, with explicit session-only storage available. The main-only credential application hook is reserved for an approved operation; it is not a renderer escape hatch. Files are namespaced by addon, encrypted, bounded, and written through a private atomic replacement. Application-level queues do not imply protection against other software running as the same OS user.

User-selected imports and exports issue short-lived, one-use handles after a native chooser. Imports return bounded bytes. Exports create a new file exclusively and report conflict for an existing target. Overwrite and general path access stay unavailable until a safe replacement contract exists. Workspace closed-file updates similarly require a disk version and explicit acceptance that replacement resets metadata; folder rename and path-based operations retain documented external same-user race limits.

## 2026-09-26: derived data and editor providers

One incremental workspace metadata service serves addon queries and Graph, Tags, and Backlinks. Bounded cursor pages carry freshness and cap information; a changed source invalidates its derived references. Search remains a bounded scan. The first editor provider layer shares document/view capture, cancellation, ranking, and ownership while CodeMirror and ProseMirror retain their own position and undo rules. Rich completion rejects source syntax that cannot be mapped exactly. Hover and contextual actions return validated data and edit proposals; editor UI remains host-owned. Interaction code loads when a provider first registers, preserving the command-only path.

These slices reuse the document journal, workspace watcher, and installed editor runtimes. They do not add a second vault index, a universal editor abstraction, a synchronous database, or an unrestricted native addon loader.
