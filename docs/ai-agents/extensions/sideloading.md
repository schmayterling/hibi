# Installing addon packages

Use Settings → Addons → **Install from URL** for a public HTTPS Git repository or ZIP package. **Install addon…** in the palette also accepts a local folder. Packages need `hibi-addon.json`, `README.md`, and their declared compiled entry. Review metadata and the trust notice before installation. New packages start disabled; settings can enable or remove them without a restart.

Installed extensions run trusted renderer code with access to document/workspace APIs. They have no Node integration or arbitrary network access, but this is not a security boundary against a hostile extension. Native addons must be built with Hibi. Opening a workspace never installs or runs its code.

## Downloads and limits

Git sources accept `.git` URLs and standard GitHub, GitLab, and Codeberg repository links. Other URLs are tried as archives, then as Git repositories if the response is not a ZIP. Hibi uses a shallow bare clone of the default branch and reads its ZIP archive. Git must be installed. Private/SSH repositories and repositories requiring a build are unsupported.

Installation runs no checkout filters, hooks, submodules, dependency installs, or build scripts. System/global Git configuration and credential helpers are disabled. Cloning has a 30-second timeout and a 64 MiB repository limit. Archive generation has a 20-second timeout and the usual package limit.

ZIP downloads must remain under 25 MiB and use HTTPS through every redirect. Packages may be at the archive root or inside one wrapping folder. Only single-volume, non-ZIP64 archives are supported. Encrypted files, duplicate paths, traversal, symlinks, and special files are rejected. Hibi checks actual decompressed sizes and checksums, then removes temporary downloads on success, cancellation, or failure.

Packages are limited to 1,000 entries, 25 MiB total, 5 MiB per file, and 64 KiB per manifest. Hidden files, invalid paths, and executable binaries are excluded or rejected. Allowed files include compiled JavaScript, JSON, CSS, fonts, images, audio, Markdown, and text.

## Storage and identity

Packages live in private application data. **Open plugins folder** reveals that directory; **Hibi Garden** opens `https://hibi.garden/addons`. Hibi assigns source labels: bundled addons are built-in, folder/developer installs are local, and URL/Git installs are third-party. Packages cannot label themselves built-in.

Disabled extensions are not imported. Replacement packages use a fresh module URL and start disabled; a successful replacement sends the old package to trash. Removal stops contributions before sending the package to trash.

## Extension package

```json
{
  "id": "example", "name": "example extension", "kind": "extension",
  "version": "1.0.0", "apiVersion": 1,
  "description": "an example command.",
  "authors": [{ "displayName": "your name" }],
  "entry": "index.js"
}
```

This versioned API v1 package remains compatible. New source addons use API v2; see [compatibility](../development/addons.md#compatibility).

The compiled browser ES module exports a factory receiving the host SDK. Use its React and editor instances instead of bundling copies. Relative imports can refer to package files.

```js
export default ({ React, ui }) => ({
  start(context) {
    context.commands.register({
      id: 'hello', label: 'example: hello',
      run: () => context.notify('hello'),
    })
  },
  Settings() {
    return React.createElement(ui.SettingRow, {
      id: 'example-setting', label: 'example setting',
      description: 'shared rows appear in the palette automatically.',
    }, React.createElement(ui.Button, null, 'example'))
  },
})
```

The SDK supplies `React`, `ui`, `tiptap`, `codeMirror`, and `markdown.Marked`. Return the usual lifecycle, settings, and flavor contributions without a second manifest. See the [sideload SDK](../reference/sideload-sdk.md) and [addon API](../reference/addon-api.md).

## Theme package

Set `kind: "theme"`, omit `entry`, and add a `themes` array of [colorscheme definitions](../reference/colorscheme-api.md). Each has `id`, `name`, `appearance`, `author`, full `license`, and `colors`. Required hex colors are `background`, `surface`, `ink`, `muted`, `accent`, and `border`; other roles are optional. Themes contain data only.

Enabled palettes appear in settings and the command palette. Removing an active theme restores Hibi's fallback. Preserve upstream authors and license notices. Manifest `licenses` and theme licenses appear in Hibi's license dialogs. Author records support `displayName` and optional `discordId`, `github`, and `role`.
