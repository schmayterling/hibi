# Startup and shutdown investigations

Tracks [#251](https://github.com/schmayterling/hibi/issues/251), [#252](https://github.com/schmayterling/hibi/issues/252), and the unresolved cursor case in [#64](https://github.com/schmayterling/hibi/issues/64).

The Windows startup reports in #251 predate this change. They do not establish that asset delivery, static imports, renderer scheduling, and background activation share a cause. Keep the original #234, #235, and #239 evidence linked from that issue. Injected failures exercise diagnostic coverage; they do not reproduce those Windows incidents.

Renderer diagnostics start in the desktop bridge, before document-transfer hydration and the application import. The local log distinguishes pre-entry errors from background activation failures. Navigation and stalled/failed core asset records identify only build-owned artifact numbers, status codes, and bounded elapsed times. Artifact 8 identifies the app entry document; match JavaScript artifact numbers against the same build's diagnostic-artifacts.json; local logs never contain requested URLs, addon names, error messages, or document paths. Native exits retain Electron's reason and exit code with an explicit unavailable-native stack status.

The custom-word database has its own worker and is separate from Chromium's BtmStorage/BtmDatabase. Graceful dictionary shutdown drains admitted requests, asks the worker to close SQLite, and waits for worker exit. The tests also exercise profiles using WAL mode; the dictionary does not change an existing profile's journal mode. A 1.5 second close deadline records SQLITE_CLOSE_WAITING but does not terminate the worker or treat the close as completed. A close error records SQLITE_CLOSE_FAILED, preserves the worker for retry, and prevents graceful quit from advancing. Never delete WAL/SHM files or force a checkpoint to work around this wait.

SQLite documents that the last connection normally checkpoints and removes its WAL on close, and that the WAL is persistent database state:
https://sqlite.org/wal.html
https://sqlite.org/c3ref/close.html

The Electron 44.7 native sample in #252 concerns Chromium storage during TaskTracker::CompleteShutdown. This repository change cannot certify that upstream wait as fixed. Electron's supported session.flushStorageData() flushes DOMStorage; it is not a BtmDatabase close API:
https://www.electronjs.org/docs/latest/api/session

Outstanding acceptance evidence: reproduce the original Windows readiness failures and the original Electron/platform native shutdown stack; identify their causes; verify original failures at ordinary deadlines. Do not associate #64's cursor cancellation without its own body/cleanup phase and native stack. Forced harness cleanup after electron-main-quit remains distinct from graceful application completion.
