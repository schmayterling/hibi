# Compatibility API integration

The host owns `core/`, `types.ts`, and `registry.ts`. Other service lanes own
`vault/`, `metadata/`, `workspace/`, and `editor/`. Themes live separately in
`src/addons/obsidian-themes/`.

Import `registerObsidianApi` from `registry.ts` and register a factory before the
host starts. Each factory receives `{ app, hibi, register }` for one open folder, or an empty workspace.
Return `{ app, exports, extendPlugin, dispose }` as needed:

- `app` supplies vault, metadataCache, workspace, or fileManager services.
- `exports` adds public classes and helpers to `require('obsidian')`.
- `extendPlugin(plugin)` adds lane-owned methods before plugin onload. Use
  `plugin.register(dispose)` to remove every registration on unload.
- `dispose` cleans up the contribution when this folder's host stops.
- `register(dispose)` also owns asynchronous initialization cleanup.

The service interfaces in `types.ts` support TypeScript module augmentation.
Declare additional methods there from your own lane's module. Native paths
must stay in native handlers, never in App services.

The editor lane calls `registerObsidianHostModule(name, module)` with its actual
CodeMirror/Lezer modules. Only exact registered `@codemirror/*` and `@lezer/*`
module names resolve. Node, Electron, relative imports, and arbitrary packages
are refused.

Native network authority is held in each plugin load's private closure. The
renderer obtains a sender- and package-bound load ticket through
`preparePluginLoad`; main consumes it once when serving the script, within
60 seconds. Bare, replayed, expired, and mismatched script URLs mint no
capability. A pending script cannot replace a running plugin's grant.
A served grant stays pending, unusable for requests, until the script's private
bridge acknowledges it through `activateRequestUrl`; only an activated grant
reserves the plugin, so a ticket redeemed by a script that never reached the
bridge cannot block the real load, and pending grants expire after 60 seconds.
The script bridge stays frozen and non-configurable for the renderer realm's
lifetime, including addon disable and re-enable. The wrapper reads it through
`window`, which page code cannot redefine, never through `globalThis`, which it
can. Its lookup uses captured Map methods. These checks prevent direct bridge replacement and script replay;
plugins still share the renderer realm. Prototype poisoning and interference
with other shared JavaScript or DOM objects remain possible, so this is not
a sandbox against hostile code already executing in that realm.

Tests use handwritten fixture plugins in
`tests/obsidian/fixtures/plugins/<id>/{manifest.json,main.js}`. Import
`fixtureVault(t, id)` from `tests/obsidian/harness.mjs` to get a temporary vault,
separate profile, and `assertUnchanged()` byte check. Never execute the research
corpus or launch Obsidian.
