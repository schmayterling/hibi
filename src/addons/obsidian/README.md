# Obsidian plugins

Browse **Settings → Addon Manager → Obsidian community** for plugins and themes,
even while the compatibility addons are off. The row's **Turn on Obsidian
plugins** or **Turn on Obsidian themes** action enables the matching addon.
Installations work without an open folder and do not enable plugins or apply
themes.

Search by name, author, description, or repository. Filter All, Plugins, or
Themes, and sort by downloads, name, or update date. Open a package's name for
its README, latest release, minimum Obsidian version, and compatibility limits.
README images do not load automatically. Validated directory lists are cached
with ETags for offline visits; **Refresh** checks for newer lists.

Installed plugins and themes appear in **Addon Manager → Installed**. The
**Obsidian** filter shows them together. Plugin rows provide enable/disable,
settings when available, update, and removal. Each enabled plugin's settings
also appear in the **Addon settings** sidebar. Commands, ribbon actions, and
status items use Hibi's normal command palette, toolbar, and status area.

Theme rows offer **Preview**, **Apply**, update, and removal. A successful
community theme install also offers Preview immediately. Theme choices appear
in Appearance alongside Hibi's other colorschemes. Installed snippets have
their own toggles. Installing a theme never applies it.

Community plugins download release assets in the main process, then use the
same validation and trust confirmation as folder installs. The confirmation
names the author, repository, release, and package hash. Hibi records the
source and individual file hashes. Open Update to check the latest release;
an update keeps global plugin data and starts disabled. Downloads can be
cancelled before trust confirmation.

Use **Install Obsidian plugin from folder** in Installed to select a package.
Plugins found in an open vault are optional install suggestions. Review the
name, description, and hash before confirming trust. Enabling a plugin asks
for trust again.

Plugins run in Hibi's renderer and can read or change notes and the interface.
Broken code can freeze the app. Install only code you trust. Turning off the
Obsidian plugins addon stops all hosted plugins.

Plugin copies, enabled state, and data live globally in Hibi's app data. They
work in any open folder, including ordinary folders, and their interface and
settings can load without a folder. File operations require an open folder.
When a vault has different plugin data, **Use this vault's settings** offers a
read-only import. Replacing global settings requires explicit confirmation;
Hibi keeps the last three timestamped backups in its app data. Accepting or
dismissing an offer records that choice for this plugin and vault, so it does
not ask again. Accepted settings reload an enabled plugin. Hibi never writes
back to `.obsidian`. Existing per-vault Hibi installations are copied into the global
store once, disabled; existing global packages and data take precedence. The
original copies remain untouched. Removing a plugin retains its data for
reinstallation.

Portable CommonJS packages require `manifest.json` and `main.js`, with optional
`styles.css`. Files must be regular UTF-8 files. Symlinks and oversized assets
are refused: 64 KiB for manifests, 5 MiB for JavaScript, and 1 MiB each for styles
and data. CSS imports and resource URLs are refused. Other assets and relative
imports are unsupported.

The host provides lifecycle, commands, ribbon/status items, settings controls,
notices, modals, menus, keymaps, icons, YAML, and path/debounce helpers. Notices,
dialogs, and menus use Hibi's shared UI. Status items show text and support
clicks; custom status markup is not rendered. See [API integration](api/README.md)
for vault, metadata, workspace, and editor APIs.

Desktop plugins need a separate **full computer access** confirmation before enabling.
It names the plugin, author, and repository, and explains that the plugin can read
and write any file and run programs. Hibi switches to a less isolated workspace
while these plugins are enabled. Real Node.js and Electron modules, including
Electron remote, share the app's DOM. CodeMirror and Lezer stay shared with
Hibi's editor. Portable plugins keep the restricted module shim unless you grant
full access from their Installed row.

Without full-access plugins, Hibi keeps its normal sandboxed, isolated renderer.
Open tabs, unsaved text, pane layout, and scroll positions survive mode changes.
Disable the plugin or use **Revoke full access** to stop it and replace its
workspace realm. Revocation cannot undo file changes or programs it already
launched. Hibi's own plugin storage never writes back to the vault; full-access
plugin code can write anywhere you allow it to run.
`requestUrl` supports HTTPS GET without custom headers or a body, through
Hibi's main-process network policy. Protocol handlers are refused. Moment is
not a dependency and is not exported; date-format controls preview basic
numeric date/time tokens.

DOM helpers exist only while plugins are loaded; the last unload restores the
original prototype descriptors. Registered commands, settings, listeners,
intervals, pending debounces, UI nodes, and styles are removed on unload.
Plugins must register cleanup for resources they create outside these APIs.
