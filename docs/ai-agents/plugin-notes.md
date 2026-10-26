# Plugin implementation notes

Keep user instructions in each plugin's `README.md`. This page records implementation constraints that matter when changing the plugins. The [plugin development guide](development/addons.md) covers the shared APIs.

## Editor plugins

### Frontmatter

Frontmatter registers a Markdown projection and optional properties editor with `context.editor.registerMarkdown`. Both the palette command and slash action use `addFrontmatter`; the palette applies it through `context.editor.updateMarkdown`.

Recognition requires a closed YAML mapping. A leading `---`, ordinary dividers, empty divider pairs, and unfinished blocks must remain Markdown. Adding properties inserts an explicit empty mapping (`{}`), removes the slash query, and keeps the body. Hide the action when metadata already exists or the plugin is disabled.

Body edits preserve metadata verbatim. Field edits use the [YAML document API](https://eemeli.org/yaml/#documents) to preserve comments, types, nested structures, and anchors. Metadata formatting may normalize; delimiters, line endings, surrounding spacing, and body content must stay intact. Reject duplicate keys. Invalid YAML remains unchanged until the user repairs it. Refuse to apply a stale YAML draft after external metadata changes.

### Slash commands

`commands.ts` owns the block commands. `rich.ts` attaches a ProseMirror plugin through `registerRich`; `source.ts` uses `registerSource`. Both use `menu.ts` and the shared command-list styles.

Read other plugins' slash actions through `context.commands.getSlashCommands()` and hide unavailable actions. Apply whole-note transforms and slash-query removal together. Source transforms retain Undo; rich whole-note actions rebuild the editor as `context.editor.updateMarkdown` does. Keep the menu out of code, frontmatter, URLs, and paths. Vim normal-mode `/` must remain search. Never execute workspace content as plugin code.

### Vim

Load the CodeMirror Vim engine on demand through `registerSource`. File commands go through `context.editor.runCommand` and `context.workspace.openFile` so they retain dialogs, unsaved-edit checks, external-change checks, and source focus after saving. Force-quit flags must not bypass those checks.

Keep command state local to the source editor. Collect normal/visual command keys and search/ex prompts, never insert-mode document text. Status items use `verbatim: true` so lowercase interface settings cannot change meaningful uppercase keys. Dispose of command contexts, status handles, preference listeners, and scoped styles when their editor or plugin stops.

The status display retains the last completed command. For example, `22k` progresses through `2`, `22`, and `22k`. Escape cancels a pending command and restores the last one; Enter alone leaves it visible. Search and ex prompts retain their input after Enter.

### Block dragging

Use the existing `registerRich`, shared menu, and scoped style APIs. Moves must preserve formatting, use the editor's Undo history, and obey the document schema. Disable moves for read-only editors. Removing the plugin must remove its handle, menu, listeners, and editor plugin without rebuilding document history.

### Word count and typing speed

Word count uses the rich editor's document text for Markdown and source text for other formats. Count in a local worker and retain only the latest pending edit. Stop the worker and remove status items and listeners when disabled. Do not persist or upload document text.

Use language-aware word segmentation and Unicode grapheme segmentation. Combining accents and joined emoji count as one character. Character totals include spaces and line breaks; Markdown totals exclude frontmatter and formatting markers.

Typing speed uses `context.editor.onInput` and `context.statusBar.register`. Count committed input, including IME text, but not paste, deletions, Vim commands, or input outside the editor. Remove the idle timer and listeners when disabled; retain counts, not note text.

The estimate divides typed characters by elapsed time from the first to the latest input and extrapolates to one minute. Apply a one-second minimum, count five characters as a word, hold the rate between inputs, and reset after five idle seconds. Spaces and line breaks count.

## Workspace plugins

### Graph and tags

Both use the shared sidebar and workspace snapshots. Debounce filesystem reads, reuse parsed results for unchanged notes, and update the active draft in memory. Stop subscriptions while the view is hidden. Graph also stops its simulation; opening the expanded graph pauses the sidebar simulation until the dialog closes.

Graph must retain its layout when text changes without changing links. Center a selected node while the layout settles, until the user pans, drags, zooms, or fits the graph. Connection lists stay independent of the graph filter. Keep workspace snapshots within 2,000 documents and 20 MiB, and graph rendering within 500 visible nodes. Do not write indexes or layouts to disk.

Resolve relative paths, workspace-root paths, encoded filenames, and reference links to existing local notes. Exclude external links, images, code examples, missing files, self-links, and wikilinks. Keep drafts without workspace paths out of graph nodes and workspace tag results. Such drafts can still contribute to the tag status count. Respect reduced motion when opening the graph.

Tag names accept Unicode letters, numbers, underscores, hyphens, and nested paths. Ignore case when matching and reject purely numeric tags. Do not index headings, escaped hashes, code, HTML, URLs, link labels, or frontmatter.

### Git

The renderer uses a read-only native query for status so refreshes do not lock editing or saves. Debounce reads and disable optional index writes to avoid refresh loops. Ignore stale requests and clear markers after workspace changes or plugin shutdown. Preserve collapsed folders during refresh. Renames decorate both parents; deleted files still decorate remaining parents. Counts include files hidden by the Markdown explorer.

Use the shared [explorer decoration API](extensions/explorer-decorations.md). Git uses the `status-success`, `status-warning`, `status-danger`, and `status-info` tokens; older themes receive defaults.

Native Git calls use argument arrays, never interpolated shell commands. Branch and file operations must target names returned by fresh repository state. Require saved editor changes and a clean working tree before pulling or switching branches. Reload the active file and explorer after success.

Authentication is noninteractive. Keep credentials out of arguments and logs; redact passwords in HTTP URLs from errors. Disable repository hooks, fsmonitor commands, custom credential helpers, external diff/textconv, filters, automatic maintenance, signing, and submodule recursion. Stop operations after 90 seconds and cap output at 4 MiB. Filtered files must be staged in another client to preserve encoding.

## Rendering and export

### Document formats

Reuse the [document format APIs](development/document-formats.md) for views, formatting tools, previews, pinned actions, and tool checks. Previewing must not rewrite source. Running MDX, MDsveX, R Markdown, or Quarto requires the explicit per-document action; their embedded code must remain inert during editing.

### LaTeX

Keep the internal `math` ID stable for existing preferences and integrations. Markdown equations use KaTeX with `trust: false`, bounded macro expansion, and no shared user macros. Invalid equations show their source. Equation views show their source until KaTeX output arrives: equations on screen render before the next paint, newly visible ones next, and the rest in idle slices. Output is cached by expression and display mode, up to about 8 million characters (larger outputs render on every mount), so remounts, undo, and exports reuse it. Pending display equations reserve the height they last rendered at, and equations are not scroll anchors, so surrounding text keeps its place while they render. Preserve complete `@font-face` rules and KaTeX math-family declarations in the editor and offline exports.

Full `.tex` documents preview and export the PDF produced by an explicit Tectonic compilation. Use the current unsaved buffer and saved local inputs from the document's folder. Documentation-site export can use Pandoc 3.11 or newer when no matching compiled PDF is cached.

The package settings use Tectonic's default bundle. Downloading a package compiles a fixed document containing its validated `\usepackage` name, with `--untrusted` and `TECTONIC_UNTRUSTED_MODE=1`. Compilation and package jobs share the application's `latex-packages` cache through `TECTONIC_CACHE_DIR`. They are serialized so clearing downloads cannot interrupt a compilation. Disabling the addon cancels running workers and rejects queued jobs.

Package operations use the existing native query API, which permits private compilation caches without locking document editing. Search lists `.sty` entries from `tectonic -X bundle search`; downloaded status checks Tectonic's cache manifests and their content blobs. Clearing downloads removes only Hibi's cache. The settings request the catalog only when the user searches and render at most 40 matching rows.

### Typst

The bundled `@myriaddreamin/typst-ts-node-compiler` 0.7.0 runs in an owned utility process. Wait 250 ms after typing before compiling. The virtual project loads supported documents, fonts, data, and media only as the compiler requests them. Unrelated files must not count toward input limits.

Constrain inputs to the workspace or current file's folder. Exclude hidden files, symlinks, dependency/build folders, and paths outside that root. Local imports resolve relative to the note. Enforce limits of 1,000 requested files, 64 MiB of input assets, 64 discovery rounds, 10 seconds, 200 pages, 20 MiB of SVG, and 64 MiB of PDF. Terminate timed-out workers and recreate them on the next request.

The pinned compiler honors the local denying proxy that blocks automatic package downloads, including computed package names. Local cached packages use the application-data `typst/packages` namespace/name/version layout. Keep compiler work off the renderer thread. Markdown shortcuts and slash block commands must not modify Typst source; image drops use `#image(...)`. Saving or renaming without a new extension preserves `.typ`.

### Documentation export

`index.ts` registers the renderer command. `native.ts` snapshots the workspace, embeds escaped data in the site template, and uses the native save operation. Use the active syntax pipeline and per-file overrides, sanitize generated HTML with DOMPurify, and embed required styles and fonts.

Resolve local Markdown images from each note's folder, including absolute paths and `file:` URLs. Embed PNG, JPEG, GIF, WebP, AVIF, and SVG images up to 8 MiB each, within a 20 MiB combined Markdown-and-image limit. Do not copy remote images or other attachments. Include the active document's in-memory edits without saving them to disk. Detect changes during rendering and ask the user to export again.

Reuse the shared sidebar and command palette, MiniSearch, and bundled Geist. Export the nine bundled color schemes and their full notices. Host snapshot preferences set the initial appearance; readers can override it. Plugin palettes fall back to Hibi, and plugin code or CSS overrides must not enter exported sites.

## keyBeats

The port uses keyBeats revision `570f9c84866be4aad100d3acac29990fba5c657a` and kbsim revision `ba103f3b0afa9dab80447aa2e7e2ed80b6bd80e4`. Preserve the upstream profile mappings for the 13 profiles and 150 shipped recordings. Unused recordings are omitted; missing MX Blue special-key samples use the original generic fallback.

Use `context.editor.onKeyEvent` for editor-only press/release events and `context.toolbar` for mute. Ignore command modifiers, composition events, and automatic repeats. Never monitor the system keyboard, store keystrokes, or transmit them.

Load audio after editing is ready. Prepare Chromium's audio service with asynchronous device discovery before starting the engine; do not request microphone access, record sound, or retain device details. Cancel startup if disabled during preparation. Typing must never wait for audio.

Fetch and decode only the selected profile from local files; cache buffers while enabled. Clear held keys on profile changes and skip missing or unready samples. Stop sounds on mute, blur, profile change, or disable. Dispose of listeners, toolbar actions, and the audio context. Background test windows stay muted.
