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

Tests use handwritten fixture plugins in
`tests/obsidian/fixtures/plugins/<id>/{manifest.json,main.js}`. Import
`fixtureVault(t, id)` from `tests/obsidian/harness.mjs` to get a temporary vault,
separate profile, and `assertUnchanged()` byte check. Never execute the research
corpus or launch Obsidian.
