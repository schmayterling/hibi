# Foundations decisions

## 2026-09-25: branch delivery

The current user instruction overrides the attached plan's pull request workflow. Preserve #83 and #99 as source material, with their commit provenance, on new workstream branches. Assemble and test on `may/foundations-sep-25-integration`. Do not update existing pull requests or merge to main.

## 2026-09-25: identity and lifetime seed

Use distinct public types for workspace, file, live document, editor view, addon, and transport request identities. These branded strings prevent accidental mixing at compile time; host validation and generation checks establish authority at runtime. A document ID survives focus and rename within a live session, then expires on close. Its generation changes when the session is replaced, not when focus changes. A view ID names one editor instance. Rename, move, and deletion invalidate a file ID; external changes and restart have no preservation guarantee. Workspace and addon activation generations invalidate pending work after replacement or restart.

Current `DocumentState.tabId` is a window-local tab identity, `DocumentState.id` follows a path or draft, `revision` advances on activation/replacement, and `contentVersion` advances on text edits. None is silently redefined as the new live document ID. New targeted edits will compare the captured document generation and content version. Existing API v1/v2 behavior remains available.

New services use operation-specific failures within `OperationResult` and function disposers. Existing handle objects with `dispose()` remain compatible. Addon-scoped registrations die on disable; workspace-scoped registrations also die on workspace change; document-scoped work dies on close; view-scoped work dies on view close. `CommandExecutionContext` captures targets when invoked. Workspace change sequence numbers are ordered within one workspace generation; a `resync` event or null paths require a fresh snapshot. Cancellation across IPC uses a request ID and owned cancel message; local `AbortSignal` values never cross IPC. Ordinary metadata listing must avoid source copies; source reads remain explicit.

The document journal remains the content authority. Workspace file writes involving open documents must coordinate with it. The main process validates disk paths and privileged requests. Renderer bindings own editor views and addon registrations. No generic IPC escape hatch is added.
