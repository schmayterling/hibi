# Foundations open issues

- #99's inactive-tab reload can replace a journal edit accepted while disk reading is pending. Workstream A must guard the target snapshot after the await and test that race before integration.
- #83's global shortcut registration uses addon/local ID as ownership. Duplicate IDs and a stale asynchronous disposer can remove a newer registration. Workstream B must use a registration token or serialized replacement and test both races.
- Current `workspaceAction` couples disk operations to explorer focus and draft tabs. Workstream C needs a targeted headless file path while reusing main-process path validation and document coordination.
- Installed addons share the renderer and global preload bridge. Workstream G cannot claim enforceable per-addon privileged grants without isolation; choose an honest trust boundary before exposing such services.
- Baseline and candidate performance evidence, including startup, input, targeted edits, indexing, activation, completion, and retained memory, remains to be measured on a quiet reference machine.
