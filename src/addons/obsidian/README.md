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

Desktop-only packages, Node.js, Electron, and undeclared module imports are
refused. CodeMirror and Lezer modules are shared with Hibi's editor.
`requestUrl` and `request` use Electron networking in the main process, without
CORS restrictions. HTTP and HTTPS, custom methods and headers, string and
ArrayBuffer bodies, and `contentType` are supported. Responses expose status,
headers, exact bytes, text, and lazily parsed JSON. Promise shortcuts
(`requestUrl(url).text`, `.json`, `.arrayBuffer`) share the same request.
Following Obsidian's public declaration, HTTP statuses of 400 or greater throw
unless `throw: false` is supplied. Redirect responses below 400 do not throw.

Requests allow 64 MiB bodies, 128 MiB responses, twenty redirects, five minutes,
and thirty-two concurrent requests. Unloading a plugin cancels its requests.
Only enabled, trusted plugins can use this native transport. `window.fetch`
remains the renderer's fetch, subject to CORS and Hibi's
`connect-src 'self' app://hibi` policy. Use `requestUrl` for arbitrary origins.

The exported `moment` is the same real Moment function as `window.moment`.
Moment and its locales load with the first enabled plugin, outside startup.
The browser's user locale is selected before plugin execution; plugins can
switch any shipped locale synchronously with `moment.locale()`. The last
plugin unload restores the previous global property.

`registerObsidianProtocolHandler(action, handler)` handles decoded
`obsidian://action?key=value` links inside Hibi, including rendered Markdown
and plugin UI. Empty query flags become the string `true`; `params.action`
always contains the actual action. Registrations disappear on plugin unload.
Hibi's existing OS scheme also accepts
`hibi://obsidian/action?key=value`, including links received at launch.
Hibi does not register as the OS handler for `obsidian://`.

The built-in `open` action opens `file` in the current vault. The `new` action
creates and opens a Markdown note from `file` or `name` and optional `content`.
A `vault` parameter must name the currently open vault. Hibi has no vault-wide
search interface equivalent to Obsidian's `search` action, so that action
reports the limitation instead of opening a different application.

DOM helpers exist only while plugins are loaded; the last unload restores the
original prototype descriptors. Registered commands, settings, listeners,
intervals, pending debounces, UI nodes, and styles are removed on unload.
Plugins must register cleanup for resources they create outside these APIs.
