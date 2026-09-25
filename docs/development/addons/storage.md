# addon storage

Use `context.storage` for addon preferences and other JSON state. The host namespaces each key by the current addon and by scope. Settings pages register UI; storage owns the values.

```ts
const preferences = await context.storage.global<{ showCounts: boolean }>(
  'preferences',
  1,
)
const current = preferences.snapshot()
if (current.status === 'ready') console.log(current.value.showCounts)

const result = await preferences.set({ showCounts: true })
if (result.status === 'conflict') {
  // Another caller wrote first. Inspect preferences.snapshot() before retrying.
}
```

`global` values survive restarts and addon disablement. `session` values live only in memory and are cleared when the addon is disabled or removed, or the app exits. To use `workspace`, capture the workspace identity and generation before asynchronous work. A store opened for an old generation returns `stale-workspace` instead of writing to whichever folder is now selected.

```ts
const workspace = await context.workspace.get()
if (!workspace?.id || workspace.workspaceGeneration === undefined) return
const options = await context.storage.workspace(
  { id: workspace.id, workspaceGeneration: workspace.workspaceGeneration },
  'export-options',
  1,
)
```

`snapshot()` is a cached read. `subscribe(listener)` observes writes after they become durable and returns a function to remove the listener. The host also removes storage subscriptions when the addon stops. `set()` compares the last observed revision with the stored revision. A `saved` result means the complete value was atomically renamed into place; it does not require a separate flush. A `conflict` result includes the current value and never silently replaces another caller's write. Callers may inspect the new snapshot and retry with a deliberate merge.

Values must be JSON without cycles and fit within 10 MiB. Each addon and scope can hold up to 128 keys and 16 MiB in total. Keys use lowercase letters, digits, dots, underscores, or hyphens, starting with a letter. Versions are positive integers. A different stored schema returns `version-mismatch`, including its version and value. Validate older data before calling `set(value, { migrateFromVersion: oldVersion })`. Newer versions cannot be overwritten by an older addon.

Persistent files live under Hibi's user data directory in `addon-storage/global/<addon>.json` and `addon-storage/workspace/<workspace-id>/<addon>.json`. Disabling or uninstalling an addon retains those files so re-enabling or reinstalling it restores preferences. Hibi does not automatically delete them. To export or clean up an addon's state, quit Hibi, back up or delete that addon's files, then reopen Hibi. Moving a workspace can change its path-derived ID; its old data remains available for manual recovery. If a file is corrupt or uses a newer host format, reads return `unavailable` and writes leave it untouched. Back up the file before replacing it, then restart Hibi to reload the repaired file.

Storage does not protect secrets. Installed renderer addons share one renderer realm; owner names and main-process checks prevent mistakes but do not isolate mutually untrusted addon code. Use a separate host credential service for secrets.

The built-in Export addon moves valid earlier `localStorage` options into its workspace store when the Export dialog first opens. It waits for the durable write and keeps the earlier key as a recovery copy. Corrupt or newer stored options show a warning and are not overwritten.
