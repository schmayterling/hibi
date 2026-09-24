# Markdown flavors

Markdown dialects and extra syntax are extension contributions registered with `context.editor.registerFlavor`. A dialect configures parsing and can add rich-editor nodes. Additional syntax, such as math, can combine with it. Addon kinds remain `theme` or `extension`.

Automatic mode recognizes enabled syntax, but ordinary Markdown may not identify a dialect. Users can override a file through its status pill or **Markdown flavor** in the palette. Choices persist per file and follow Save As and renames within Hibi.

Base Markdown includes GitHub tables, task lists, strikethrough, automatic links, and alerts. It also accepts common Obsidian callout titles and fold markers, wikilinks, image embeds, and highlights. These built-in contributions use the same flavor API that remains available to addons.

Automatic mode keeps enabled parsers ready, so typing syntax does not rebuild the editor or reset undo. Explicit flavor changes and schema-addon enable/disable rebuild the rich editor, preserve source, and reset that pane's undo history. Detected unsupported syntax makes the rich pane read-only; source remains editable.

Declare lightweight `Addon.flavors` descriptors so bundled syntax can be detected while disabled. Register full contributions during `start`, including `richExtensions`, `markedOptions`, and `export` parsers/styles as needed. Async `start` is supported. Shutdown removes contributions and ignores late registrations.

`context.editor.renderMarkdown(source, documentId?)` applies projections and file preferences, returning `{ html, css }`. Sanitize HTML before insertion. The exported site does this while preserving safe MathML/SVG. Keep styles and fonts self-contained; the export's content policy blocks network assets.

`context.workspace.snapshot()` returns Markdown pages, opaque file IDs, and local images from the open folder. Workspace files cannot register flavors or execute code.

See the [addon API](../reference/addon-api.md), [Markdown](../../../src/addons/markdown/README.md), and [LaTeX](../../../src/addons/math/README.md).
