# Foundations rollout and rollback

This work is assembled on `may/foundations-sep-25-integration`. It has not been merged or released, and no pull request will be created for this mission.

## Before adoption

Run the full local check on the final commit, dispatch the branch's cross-platform check workflow, and compare startup/input/metadata measurements with the recorded baseline. Install the independent proof addon from its folder in a fresh profile and repeat its focus-switch, permission, and disable/re-enable paths. Treat blocked platforms and skipped tests as open evidence, not passes.

Keep a copy of the test profile and a workspace backup before exercising mutation APIs. Existing API v1/v2 addons remain loadable. The documentation preference migration retains its old key until the new value is durably acknowledged; credential files live outside ordinary addon storage. Closed-file text replacement requires an explicit metadata-reset option. Exports create new files and reject existing destinations.

## Rollback

Before release, switch the application build back to the prior main commit; leave workspace files and user-data directories untouched. Do not delete `addon-storage` or `addon-credentials` to downgrade. Older builds may ignore newer values, so a downgrade must preserve them for a later retry. Session values and outstanding grants expire when their addon or renderer stops.

Application rollback does not undo a workspace file that was already created, moved, updated, or sent to the OS trash. Use the saved workspace copy, local history, or OS trash to restore those files after reviewing their versions. No automatic multi-file rollback is claimed.
