# Creating addons

Source addons are compiled with Hibi and enabled in settings. They are trusted application code. Opening a document workspace never discovers or runs addon code from that folder.

## Files and metadata

Put bundled addons in `src/addons/<id>/` and private addons in the Git-ignored `src/useraddons/<id>/`:

```text
manifest.ts   metadata and api version
index.ts     renderer entry point
native.ts    optional native methods
README.md    addon documentation
```

Vite discovers these folders. Rebuild after adding files, or use `npm start`. Renderer addons use browser APIs; filesystem work belongs in the native entry point. Private addons import the SDK from `../../addons/api`.

Use a unique lowercase ID containing letters, numbers, or hyphens. The manifest requires a nonempty `version` of at most 40 characters. `authors` lists people who wrote or contributed to the Hibi plugin, including its port, using `{ displayName, discordId?, github?, role? }`. Bundled plugins share entries from `src/addons/authors.ts`. Do not invent missing identifiers. Credit upstream library, engine, and asset creators in the README and preserve their license notices.

Optional `licenses` entries contain `id`, `name`, `license`, and full `text`. They appear in Hibi → Open source licenses even when the addon is disabled. The host prefixes license IDs with the addon ID. Settings show author names and roles, with Discord IDs or GitHub usernames in tooltips.

## Renderer entry point

```typescript
import { defineAddon } from '../api'
import manifest from './manifest'

export default defineAddon({
  manifest,
  start(context) {
    context.commands.register({
      id: 'hello',
      label: 'hello from my addon',
      run: () => context.notify('hello'),
    })
  },
  stop() {
    // Clean up any subscriptions or resources created by start.
  },
})
```

Commands receive an `<addon-id>.` prefix and are removed when the addon stops. Clean up your own listeners, timers, and other resources in `stop`.

An addon can export a `Settings` React component alongside `manifest` and `start`. Enabled addons get a page under **Plugins**; the section disappears when no pages are available. The host supplies the heading and metadata. Use shared controls such as `SettingRow`, `Toggle`, `Button`, and `Select`.

Settings load when needed for their page or command-palette discovery. Discovery can keep them mounted while hidden, so mount effects must not assume the page is visible. Settings errors are isolated from the editor. See [command discovery](../extensions/command-discovery.md).

## Editor behavior

`context.editor.onKeyEvent(listener)` observes keydown and keyup in active editable rich/source panes. Events include phase (`down`/`up`), view (`normal`/`source`), key/code, repeat, and modifiers. Observers run synchronously and cannot consume input. IME composition, hidden/read-only panes, dialogs, and non-editor fields are excluded. Disposing the listener or stopping the addon removes it; listener errors are contained. A release may be absent when focus leaves, so reset held-key state on blur or focus changes. No operating-system hooks are exposed.

`context.editor.registerSource({ id, create })` installs a CodeMirror extension in each source editor. `create` can return a promise for a lazy import. Keep resources scoped to the editor lifecycle. Reconfiguration preserves content and history; stopping the addon removes registrations. `context.editor.runCommand(command)` uses Hibi's file handling and returns `false` on cancellation or failure. Vim demonstrates both APIs.

`context.editor.registerRich({ id, attach })` adds behavior to each visual editor without rebuilding its schema or history. `attach(editor)` receives the Tiptap editor and must return cleanup. Register/unregister ProseMirror plugins through that editor and remove other listeners during cleanup. The host detaches while only source view is shown and reattaches after the formatted editor catches up. It also detaches on unregister, addon shutdown, editor replacement, or unmount, and reports errors as addon notifications. Use `getDocument()` and `onDocumentChange()` for current source content instead of retaining a hidden visual editor. This hook cannot add schema nodes or marks. Slash commands demonstrate paired rich/source behavior with one popup.

`context.toolbar` adds actions below the titlebar. `context.tooltips` shows plain-text help that is removed with its owner. Both use shared controls; see [toolbar and tooltips](toolbar-and-tooltips.md).

## Dialogs and status

`context.dialogs` provides `open`, `alert`, `confirm`, and `prompt`. Addons share the built-in dialog queue and modal shell. Stopping an addon cancels its active and queued dialogs. See [dialogs](dialogs.md) for validation, return values, and cleanup.

`context.statusBar.register({ id, label, tooltip?, when?, onClick? })` adds a pill below the editor and returns `update(changes)` and `dispose()`. Use a unique local ID. `when: 'source'` limits it to source and split views; `when: 'normal'` limits it to normal view. Empty labels hide pills, and an empty bar takes no space. Settings hide the bar. Labels are plain text; `onClick` makes a pill a button.

```typescript
const mode = context.statusBar.register({
  id: 'mode',
  label: 'vim · normal',
  tooltip: 'vim mode in the markdown pane',
  when: 'source',
})
mode.update({ label: 'vim · insert' })
// Dispose when the owning editor view closes; addon shutdown also removes it.
mode.dispose()
```

Updates after disposal are ignored. Click failures produce an error notification. Vim owns one status pill per source editor and updates it when modes change.

## Slash actions

An existing command can join the slash menu with `slash: { label, description, keywords?, when?, transform }`. `when(source)` checks the complete note. `transform(source)` synchronously receives the whole note with its slash query removed, then returns replacement text or `null` to cancel. Keep transforms pure. Frontmatter shares one `addFrontmatter` transform between its palette and slash actions.

```typescript
context.commands.register({
  id: 'properties',
  label: 'add properties',
  run: () => context.editor.updateMarkdown(addProperties),
  slash: {
    label: 'properties',
    description: 'add page metadata',
    keywords: 'frontmatter yaml',
    when: source => !hasProperties(source),
    transform: addProperties,
  },
})
```

`context.commands.getSlashCommands()` returns available actions from enabled addons, with owner-prefixed IDs. Unregistering or stopping removes them; stale transforms cancel safely. Predicate/transform errors are reported without committing the edit. Cancellation leaves the slash query unchanged.

`context.editor.updateMarkdown(transform, { body })` can replace the projected rich body before a whole-note transform. The host reconstructs metadata through the current Markdown projections, then commits query removal and transformation together. This rebuilds rich editor state and resets its undo history. Source slash actions use one CodeMirror transaction and retain undo. Built-in block slash actions retain undo in both editors.

## Markdown projections

An addon can supply a React `Editor` above the rich document. It receives the complete Markdown as `value`, `onChange(source)`, and `disabled`. Return `null` where the UI does not apply. Use `onChange` for ongoing edits to keep both panes synchronized, and honor `disabled` during file operations. Disabling the addon unmounts it.

Use `context.editor.updateMarkdown(transform)` for explicit whole-note commands. It transforms the latest source synchronously, marks it unsaved, and rebuilds editor state. It throws while a file operation is active.

`context.editor.registerMarkdown` registers a pure `parse(source)` projection under a local ID. Return `null` for unrecognized documents, or `{ content, serialize }` to expose the visual body and reconstruct full source after an edit. `readOnly: true` protects unsupported variants. Projections run in registration order; serialization runs in reverse.

The host removes registrations on shutdown, preserves source during capability changes, and uses a read-only fallback after parser errors. Changing editor extensions rebuilds the visual editor and resets its undo history. Preserve metadata in `serialize` and avoid parser side effects. See `src/addons/frontmatter/`.

## Colorschemes

`context.colorschemes.register(scheme)` adds a palette and returns a disposer. The host prefixes its local ID (`my-addon.midnight`) and removes it on shutdown, failed startup, or hot reload. Disabling a selected palette falls back to Hibi while retaining the preference; re-enabling restores it.

```ts
context.colorschemes.register({
  id: 'midnight',
  name: 'midnight',
  appearance: 'dark',
  author: 'your name',
  license: { name: 'your license', text: 'full license notice' },
  colors: {
    background: '#181818', surface: '#222222', ink: '#eeeeee',
    muted: '#aaaaaa', accent: '#81cdd1', border: '#353535',
  },
})
```

The six base colors must be opaque six-digit hex values. Other roles default from them; overrides accept six- or eight-digit hex. CSS expressions, URLs, unknown roles, and duplicate IDs are rejected. Author, license name, and full license text are required. An optional source URL must use HTTPS. Registered data is copied and frozen. Preserve upstream notices for adapted palettes.

`list()` returns palettes with fully qualified IDs. `getPreferences()` returns `{ mode, light, dark }`; `setPreferences(partial)` updates them. Selected IDs must match the requested appearance. The [colorscheme API](../reference/colorscheme-api.md) lists all roles.

Base colors use CSS layer `hibi-base`, palettes use `hibi-theme`, and unlayered `context.styles` rules retain precedence. Palette changes do not rebuild editors. Workspace snapshots include appearance preferences, but exports bundle only audited built-in palettes and fall back to Hibi for addon palette IDs.

## Styles and method patches

`context.styles.register(id, css)` adds a stylesheet and returns `update(css)` and `dispose()`. IDs are local and unique while registered. Use shared tokens and targeted selectors. Import CSS with `?inline` to pass it here. Unlike a plain CSS import, an owned stylesheet is removed on shutdown, failed startup, and reload. Vim uses this for editor styles.

Pass `{ priority: 'override' }` as the third argument to place a stylesheet after ordinary `context.styles` sheets, including those registered later by another addon. This source order wins for equal-specificity rules in the same cascade layer. It does not beat more specific selectors, `!important`, inline styles, cascade layers, or unrelated stylesheets added outside `context.styles`.

```typescript
const style = context.styles.register('appearance', `
  :root { --accent: #a6d3e8; }
  .app-statusbar { font-size: 11px; }
`)
style.update('.app-statusbar { font-size: 12px; }')
style.dispose()
```

`context.patches.before`, `after`, and `instead` wrap mutable renderer methods and return undo functions. The target must own a function-valued data property. Pass a class prototype to patch its methods. Getters, frozen objects, and immutable module exports cannot be patched.

- `before(target, key, (args, receiver) => newArgs | void)` can replace arguments.
- `after(target, key, (args, result, receiver) => result)` must return the result to keep or replace. Promise-returning methods pass the promise unchanged; return a chained promise to change its resolved value.
- `instead(target, key, (args, next, receiver) => result)` replaces behavior. `next(...args)` continues the chain with the original `this`; omitting it suppresses that behavior.

`context.app.runAction(AppCommand)` and `runCommand(DocumentCommand)` are the shared targets for toolbar, palette, and keyboard actions. Addon file commands also use `runCommand`. Patching them avoids private React closures. Normal `runCommand` preserves native dialogs, unsaved-edit checks, and path validation; skipping it grants no filesystem access or native permission.

```typescript
const undo = context.patches.instead(
  context.app,
  'runAction',
  ([command], next) => next(command === 'normal' ? 'markdown' : command),
)
context.patches.after(context.app, 'runCommand', ([command], result) =>
  result.then(saved => {
    if (saved && command === 'save') context.notify('saved by my addon')
    return saved
  }),
)
undo()
```

Patches compose in registration order, with the first outermost. `before` runs first-to-last; `after` unwinds last-to-first. Each call uses a snapshot of the chain. Stopping an addon removes only its patches. After the last patch is removed, the original property descriptor is restored unless another caller replaced the method outside this API. Running calls may finish, so cancel your own asynchronous work where needed. Callback errors propagate; the host never retries a potentially destructive operation after a failed hook.

These APIs run trusted renderer code. They grant no native permissions, never load note contents as code or CSS, and are not copied to exported sites. Document overrides and clean up resources not owned by the APIs.

## Native entry point

Export a `NativeAddon` with an ID and asynchronous methods. Renderer calls through `context.native.invoke` can reach only that enabled addon's exported methods. Inputs arrive as `unknown`; validate them. Never expose a generic filesystem or IPC dispatcher.

`context.workspace` opens or reads the selected workspace. Native `context.workspace.snapshot()` returns Markdown pages with relative paths. `context.exportHtml()` opens a save dialog and writes the HTML. See `src/addons/documentation/`, the [export guide](../../guides/exporting.md), and the [addon API](../reference/addon-api.md).

## Shared navigation

`context.workspace.index()` returns workspace note text, including new drafts. It reuses the workspace tree, omits embedded media, accepts empty folders, and limits results to 2,000 notes / 20 MiB. Use it for tags and connections; use `snapshot()` for exports. Background reads wait for active writes without taking the write lock, so refreshes do not block saves or addon actions.

`context.sidebar.register({ id, label, icon, Content })` adds a desktop view. The handle's `open(input?)` reveals the sidebar and passes selection data to `Content`. Views appear in the titlebar picker and palette, support pinning and resizing, and disappear on shutdown. Unavailable pins do not use the three visible slots. Startup retains pins while addons load; pinning a new view clears unavailable entries.

Content mounts only while visible. Release subscriptions and simulations in effect cleanup; store drafts that must survive navigation in addon-owned state. View errors offer retry without breaking the app.

Import `Sidebar` from `src/addons/ui.ts` for nested or flat navigation, headers/footers, keyboard focus, selection motion, or a custom `content` body. Settings, workspaces, and exported documentation share it. Its `resize` prop takes the width, maximum width, change callback, and reset callback; apply the width to `--sidebar-width`. Core layouts share `useSidebarResize` for limits and local persistence.

Desktop and exported sidebars default to 256 px while respecting saved widths. Dragging 48 px beyond the 152 px minimum collapses navigation sidebars and retains their previous width. Settings stays open at the minimum. Custom sidebars opt in with `resize.onCollapse`.

## Compatibility

The public API is version 2. Source plugins must include `version` and `apiVersion: 2`; bundled plugins use this contract. Versioned API v1 packages remain runtime-compatible and are normalized on installation. Both processes reject empty/missing versions and unsupported API versions.

Preserve signatures when adding capabilities. Breaking changes require an API version bump, addon migrations, and documentation updates. `npm start` regenerates references when declarations change. Otherwise run `npm run docs`; `npm run docs:check`, included in `npm run check`, rejects stale references. Update the addon README with behavior changes.
