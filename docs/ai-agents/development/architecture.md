# Architecture and security

## Source layout

- `src/main`: windows, validated IPC, document and workspace access, and native addons.
- `src/preload`: the typed bridge. It exposes no general IPC, filesystem, or Node APIs.
- `src/renderer`: editors, settings, the command palette, and renderer addons.
- `src/ui`: controls, theme tokens, shortcut labels, and the shared sidebar.
- `src/addons`: the versioned SDK and bundled addons. Private addons live in `src/useraddons`.
- `src/site`: the read-only documentation viewer, which runs without the Electron bridge.
- `scripts`: build, export, and documentation tools.

## Formatted view migration

Markdown notes open in the ProseMirror formatted view by default. The CodeMirror formatted view (`FormattedEditor.tsx`, `live-preview.ts`, `chunked-markdown.ts`) renders Markdown in place over the same source session as the source view. Tests and development profiles select it with a temporary switch: set `hibi:formatted-engine` to `codemirror` in the renderer's local storage and reload. It has no setting or saved preference and is removed when the CodeMirror view becomes the default.

### Formatted view contributions

Features render in the CodeMirror formatted view through contributions (`formatted-contributions.ts`), the internal shape of addon API 3. A contribution declares:

- `id`; `feature`, the syntax setting (`owner.feature`) that controls it; and `flavor`, the Markdown flavor a note must use. While the setting is off, or the note's pane does not use the flavor, the contribution is not installed: its syntax is not parsed and its text shows as written.
- `syntax`: Lezer Markdown extensions composed into the chunked language. Changing the installed syntax parses the document again. A block parser whose decision reads past the line it is on, such as display math that looks for its closing line, calls `readAhead(input, to)` from `chunked-markdown.ts` with the input its `wrap` received: an edit before `to` then parses that chunk, and the chunk before it, again. The language skips runs of text without inline syntax only while every contributed inline parser starts at ``\`&*_![]<>~^$:``, a URL or an email address; contributions whose parsers do declare `inlineStops`.
- `opaque`: nodes whose renderers read their source text instead of inner nodes. A block of these longer than two chunks (8 KiB) gets inner nodes only for its opening and last lines, wherever the viewport is, so an edit inside it parses a few lines.
- `views`: renderers for syntax nodes by name.
  - `decorate` runs for nodes in the visible ranges (`context.visible`) and adds marks, line attributes, inline widgets and one-line replacements; `out.syntax` hides Markdown syntax and shows it as an editable marker while the node is revealed.
  - `layout` runs for nodes in parsed chunks and adds block widgets and replacements across lines. Its decorations are cached per chunk, so they may depend only on the node's text and `context.revealed`.
  - Either returns `false` to skip a node's children. Hidden and replaced ranges are atomic. Backspace and Delete skip hidden syntax but delete a replaced range with a widget whole.
  - `space` gives a block's margins in px, which collapse with its neighbors' like the document styles.
  - `container` lays out the lines of a quote, a list item or any other block that holds blocks: the indent `width`, a line `class`, `paint` behind the lines from the container's left edge and below the space above it, `padding` inside it and, for list items, `marker: false`. A block with this hook gets spacing between its blocks like a quote.
  - A whole-line block replacement drops its line's container indent, paint and the space above it. Blocks inside containers replace their range with an inline widget instead.
- `keys`, which run before the structure keys, and `extension` for anything else per formatted view.

Facets and effects carry the rest. A `formattedRefresh` effect renders the visible ranges again, for renderers that read state an idle slice changed; `formattedSyntaxTree(state)` gives commands the view's syntax tree, parsed near the viewport. `formattedPrefix` gives the length of a prefix that is not Markdown, such as frontmatter; it becomes one `Frontmatter` node, and the longest prefix applies. `formattedDocument` gives the tab the view shows and a revision that changes when the note's files may have. `showMarkdownMarkers` tells widgets whether markers show, so a click can reveal source or open an editor. Core syntax settings name the nodes they control (`nodes` in `markdown-syntax.ts`); while one is off, those nodes and their children show as written.

A node is revealed while the selection touches it in a focused editor that shows Markdown markers. Renderers see one node at a time and must not walk the document or keep state across calls.

Widgets are CodeMirror `WidgetType`s. `eq` compares the source text and options they render, so views reuse their DOM; expensive work belongs in `toDOM`, which runs only for widgets in view. Block widgets give an `estimatedHeight`. Interactive widgets are labelled controls that edit the source with `view.dispatch` at `view.posAtDOM(dom)` and return `false` from `ignoreEvent`; widgets that restate text are `aria-hidden`.

Core features live in `src/renderer/src/formatted/<feature>.ts` and export `contribution` or `contributions`; they are found automatically. Bundled addons register a lazy entry with `formattedRegistry.register({ id, load })` from `formatted-registry.ts` in `start` and remove it in `stop`, so no editor code loads at startup.

## Privileged operations

The main process checks the sender, main frame, and exact app URL before every privileged operation. File dialogs grant access to paths. Workspace calls accept only relative document paths within the selected canonical folder. Native addon calls require an enabled addon and an explicitly registered method.

Document replacement, export, and addon preference writes share an operation guard. Closing the app waits for an active operation and checks for unsaved edits. Workspace watchers debounce changes and read asynchronously. New save destinations resolve their parent directory first, so later saves through a symlink compare the same canonical path and still detect external edits.

Local media display URLs are opaque and bound to the current document revision. The main process validates paths and sniffs a small header; Chromium streams and decodes the file without a compressed-byte display limit. Shared resolution cancels obsolete work and refreshes only dependencies affected by workspace changes. SVG responses remain inert under a sandboxed content security policy. The compatibility image-byte bridge retains its 8 MiB limit, and documentation snapshots still validate and embed media through the bounded export path.

## Appearance and licenses

Colorschemes contain validated hex colors and attribution. The app and exported site share the same color roles. Appearance IPC accepts a valid preference pair and opaque hex window colors; its cache is written atomically and read before window creation. Exports receive preferences through the workspace snapshot, so the documentation addon does not import core code.

The Hibi settings page reads the bundled license catalog through validated IPC. Lists contain metadata; license text loads when a catalog ID is selected. IDs are looked up in the catalog, never used as paths. The sponsor action opens one fixed HTTPS address and accepts no destination from the renderer.

## Runtime boundaries

The renderer is sandboxed and isolated, with Node integration disabled. App assets use a local protocol that rejects path traversal. External navigation, child windows, downloads, and permissions are denied. Development connects only to its local Vite server.

Static exports escape embedded JSON, sanitize rendered Markdown with DOMPurify, and allow only the application script identified by its hash. Fonts and CSS are bundled. Addon code is trusted at build time; opening a workspace never loads its JavaScript as addon code.
