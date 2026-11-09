# Obsidian plugins

This built-in addon is off by default. Enable **Obsidian plugins** in Settings →
Addons, then open its settings page with a vault folder open.

Choose **Install from folder** to select a plugin package. You can also install
a separate copy of a plugin found in the vault's `.obsidian/plugins` folder.
Review the package name, description, and hash before confirming trust. Each
copy starts disabled. Enabling it requires another trust confirmation.

Plugins execute in Hibi's renderer. They can read or change notes and the
interface, and broken code can freeze the app. This is not a sandbox. Install
only code you trust. You can disable this addon to stop all hosted plugins.

Hibi stores content-addressed plugin copies and state in its own app data,
separately for each canonical vault. Plugin data is seeded once from the
vault's original `data.json` when available. Later settings changes stay in
Hibi's overlay. Hibi never writes back to `.obsidian`. Removing a disabled
plugin keeps its overlay data and package copies for reinstall.

Portable CommonJS packages must have a valid `manifest.json` and `main.js`.
An optional `styles.css` is supported. Files must be regular UTF-8 files;
symlinks and oversized assets are refused. Limits are 64 KiB for the manifest,
5 MiB for JavaScript, and 1 MiB each for styles and data. CSS imports and
resource URLs are refused. Other package assets and relative imports are not
supported.

The host provides lifecycle, commands, ribbon/status items, settings controls,
notices, modals, menus, basic keymaps, icons, YAML, and path/debounce helpers.
Status items show text and support clicks; custom status markup is not rendered.
Service lanes provide vault, metadata, workspace, and editor APIs through the
registry described in [API integration](api/README.md).

Desktop-only packages, Node.js, Electron, and undeclared module imports are
refused. The editor lane shares Hibi's actual CodeMirror and Lezer modules.
`requestUrl` supports HTTPS GET without custom headers or a body, through
Hibi's main-process network consent and address/size policy. Protocol handlers
are refused. Moment is not a dependency and is not exported; the date-format
control previews basic numeric date/time tokens.

DOM helpers are available while at least one plugin is loaded. The last plugin
unload restores the original prototype descriptors. Registered commands,
settings, listeners, intervals, pending debounces, UI nodes, and styles are
removed on unload. Plugins must register cleanup for resources they create
outside these APIs.
