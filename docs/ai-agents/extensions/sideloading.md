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

Disabled extensions are not imported. Replacement packages use a fresh module URL. One with unchanged kind, capabilities, network origins, and external tools keeps its enabled setting: main retires the old activation generation without writing preferences, and the renderer stops the running closure, hydrates the new descriptor, and restarts it through the reload operation. Changed access starts disabled. A successful replacement sends the old package to trash. Removal stops contributions before sending the package to trash.

## Reloading in place

Main sends `ADDON_CHANNELS.reload` with `{ id, scope }` to the main window; `useAddons` handles it and never writes enabled preferences. `code` (`src/renderer/src/addon-reload.ts`) stops the addon and its running required consumers, consumers first, clears committed start failures in that closure and its required providers, then waits for the start effect to restart them provider-first, along with consumers those failures blocked. It waits only for addons that were running or a reload already restarts; unstarted command addons still start on demand. When the closure includes an addon the document needs, editors stay read-only (`reloading` from `useAddons`) until the restarts settle; the active editor's selection captured at the start is then restored unless the user moved it, focus returns, and editing resumes. It refuses, without queueing, while any addon in the closure owns an open, loading, or kept-alive window (`ADDON_WINDOW_CHANNELS.owners`) or has its settings page on screen. A newer reload of an affected addon supersedes an older one; stale starts are discarded by the existing `disposed` and descriptor generation guards. `styles` swaps declared stylesheets (cache-busted per owner revision, loaded inactive, then published in place) and declared themes in one colorscheme publication, without restarting code. For an installed package, main reads and validates the declared themes and stylesheets from its files again first. An in-place replacement is refused in main, before anything is retired, while an affected addon's settings are on screen or it owns a window. During an installation the renderer keeps the settings of installed addons and their consumers closed (`updating`), so the visibility it sent with the request stays accurate until the replacement and its reload finish. Refusals appear as error notices; start failures report their own cause. Only the main window reloads: editor windows and native modules keep their current code, and native or main changes still need an app restart.

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

The SDK supplies `React`, `ui`, `tiptap`, `codeMirror`, and `markdown.Marked`. Return the usual lifecycle, settings, and flavor contributions without a second manifest. See the [sideload SDK](https://docs.hibi.garden/#page=development%2Faddon-api-reference%2Fsdk.md) and [addon API](https://docs.hibi.garden/#page=development%2Faddon-api-reference%2FREADME.md).

## Theme package

Set `kind: "theme"`, omit `entry`, and add a `themes` array of [colorscheme definitions](https://docs.hibi.garden/#page=development%2Faddon-api-reference%2FColorschemeInput.md). Each has `id`, `name`, `appearance`, `author`, full `license`, and `colors`. Required hex colors are `background`, `surface`, `ink`, `muted`, `accent`, and `border`; other roles are optional. Themes contain data only.

Enabled palettes appear in settings and the command palette. Removing an active theme restores Hibi's fallback. Preserve upstream authors and license notices. Manifest `licenses` and theme licenses appear in Hibi's license dialogs. Author records support `displayName` and optional `discordId`, `github`, and `role`.
