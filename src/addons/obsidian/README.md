# Obsidian plugins

This built-in addon is off by default. Enable **Obsidian plugins** in Settings →
Addons, then open its settings page with a vault folder open.

You can browse the official Obsidian community directory in Settings → Addon
Manager → **Browse community plugins and themes**, even when both compatibility
addons are off. Search by name, author, description, or repository, and sort by
downloads, name, or update date. The Themes tab uses the Obsidian themes addon;
turn it on before installing a theme. Theme installs do not apply themselves.

Open **Details** to read a repository's README and check its latest release,
minimum Obsidian version, or desktop-only restriction. README images do not
load automatically. The directory caches validated lists with ETags for later
offline visits; **Refresh community directory** checks for newer lists.

Community plugin installs download release assets in the main process, then use
the same validation and trust confirmation as folder installs. The confirmation
names the author, repository, release, and package hash. Hibi records the source
and individual file hashes. A changed latest release is shown when you open
Details for an installed plugin. Updating keeps its overlay settings and starts
the replacement disabled. You can cancel a download before confirming trust.

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
