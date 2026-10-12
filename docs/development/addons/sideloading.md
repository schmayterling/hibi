# Sideloading and sharing

Sideloading installs an addon without rebuilding Hibi. An extension package needs `hibi-addon.json`, `README.md`, and a compiled browser module.

## Make a package

Create a folder with this `hibi-addon.json`:

```json
{
  "id": "hello",
  "name": "Hello",
  "description": "A greeting from your first addon.",
  "version": "1.0.0",
  "apiVersion": 2,
  "kind": "extension",
  "authors": [{ "displayName": "Your name" }],
  "entry": "index.js"
}
```

Add an `index.js` that exports a factory. Hibi passes its [shared SDK](../addon-api-reference/SideloadFactory.md) to this factory.

```javascript
export default () => ({
  start(context) {
    context.commands.register({
      id: 'greet',
      label: 'Say hello',
      run: () => context.notify('Hello from your addon.'),
    })
  },
})
```

Add a readme that explains how to use the command. This example is already JavaScript and needs no build step. For TypeScript or JSX, compile your package before sharing it. Hibi does not run package installation or build scripts.

For TypeScript checking, Hibi's local `@hibi/addon-sdk` tarball supplies addon contracts without runtime code. Run `npm run sdk:pack` in a Hibi source checkout, install the resulting `.tgz` in your addon development project, and use `import type` from `@hibi/addon-sdk/api`, `@hibi/addon-sdk/sdk-loader`, or `@hibi/addon-sdk/sdk`. Use `CapabilityFactory` for a package declaring `capabilities`, or `SideloadFactory` for a legacy package. Set `apiVersion` to `2` for new packages. Strict type checking requires the package's React, CodeMirror, Tiptap, and Marked peers; use Hibi's shared SDK values in installed code.

Use the factory's `React`, `ui`, `tiptap`, `codeMirror`, and `markdown` values instead of bundling second copies of those libraries. Relative imports may load other compiled files in your package. Do not import from Hibi's source tree in an installed package.

## Load only the SDK you need

New packages can declare `capabilities` in the manifest. Use `ui` for React and shared controls, `rich` for Tiptap, `source` for CodeMirror, and `markdown` for Marked. An empty array supplies only the lightweight `documents` helpers. Packages that omit this field retain the legacy SDK with all engines.

```json
{
  "capabilities": [],
  "activation": "command",
  "commands": [{ "id": "greet", "label": "Say hello" }]
}
```

Add these fields to the greeting package above to keep its runtime unloaded until the command is invoked. The command descriptor is plain metadata; its ID must match the runtime registration. A source-only integration can use `activation: 'source'`, while `rich` activation runs in visual or split view. Omit activation for document formats and syntax that must exist before editing.

Declaring capabilities also stages editor configuration, commands, toolbar items, and sidebar views until `start()` finishes. Registrations are published in stable ID order and removed if startup fails. Document syntax cannot use command or view activation, and background packages cannot install required editor integrations. These SDK choices control loading; renderer packages still run trusted code.

## Install it locally

Run **Install addon…** from the command palette and choose the package folder. Review it, install it, then enable it in **Settings → Addons**. If you already have a source addon with the same ID, use a different ID for this package.

Installed extensions run trusted code with access to documents through the addon APIs. Install packages only from sources you trust. Native handlers, importers, and addon windows must ship with Hibi; installed manifests cannot declare these privileges or replace a built-in addon ID.

Keep `hibi-addon.json` within 64 KiB, including full license notices. Each top-level `licenses[].text` notice can use up to 64 KiB of UTF-8 text, subject to that total manifest limit. Inline color scheme notices retain their 32,000-character limit. API versions 1 and 2 use the same package format and validation.

Packages installed before Hibi accepted stylesheets and theme files keep ignoring those fields and native/importer/window declarations without granting privileges. Reinstall such a package to use its stylesheets and themes.

## Add stylesheets and themes

An extension can list up to 16 CSS files in `styles` and up to 20 color schemes in `themes`. A theme entry is either an inline color scheme or the path of a JSON file that contains one. Paths are relative to the package folder.

```json
{
  "styles": ["styles/base.css", "styles/panels.css"],
  "themes": ["themes/evening.json"]
}
```

Hibi checks these files when you install the package. Each one must be a regular file inside the package, and each theme file must be valid JSON no larger than 64 KiB that describes one color scheme. Stylesheets follow the usual package file limits.

Stylesheets and themes load when the extension starts and are removed when it stops, is disabled, or fails to start. A disabled extension loads none of its files. Their themes are available in **Settings → Appearance** while the extension runs. If the selected theme's extension is disabled, Hibi uses the default theme until the extension is enabled again, and your selection is kept.

Package stylesheets apply after Hibi's own styles and selected theme, in addon ID order and then in the order listed. Styles registered with `context.styles` come after them, and override-priority styles, such as custom CSS from **UI preview**, still come last. Specificity, cascade layers, and `!important` continue to decide the final result.

Relative `url()` and `@import` references resolve from the stylesheet's own location, so fonts and images can live in the package. Remote stylesheets, fonts, and images are blocked. Prefix your selectors with a class unique to your addon unless you intend to restyle Hibi itself; stylesheets are not isolated from the rest of the app.

## Share it

Publish the prepared files in a public HTTPS Git repository or ZIP archive. The manifest can sit at the archive root or inside one wrapping folder. Users can install that URL through **Settings → Addons → Install from URL**.

Git packages need their compiled entry committed on the default branch, and Git installed on the user's machine. Private repositories and SSH URLs are not supported. Keep packages under 25 MiB, with no more than 1,000 files and no individual file over 5 MiB. Do not include `node_modules`, secrets, or native executables.

To update a package, increase its version and install the replacement. Replacements start disabled so the user can review them before enabling them.
