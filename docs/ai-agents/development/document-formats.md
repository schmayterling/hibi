# Document formats

Formats are optional addon contributions. Markdown is always available through its bundled plugin. Plain `.txt` is built into the app and never parses Markdown. Workspace files are data, never addon modules. See [creating addons](addons.md#compatibility) for API version requirements.

Bundled runtimes load from data-only manifests when needed. Their `start()` promise must finish registering required editing behavior before it resolves. See [startup performance](performance.md) for activation order and lazy loading.

## Registration

Declare `fileExtensions: ['typ']` in the manifest, then call `context.editor.registerDocumentFormat({ id, name, extensions, language, Preview, render?, insertMedia? })`. Extensions omit the dot and use lowercase letters/digits. `.txt` is reserved. Only one enabled format can own an extension.

`editing: 'markdown'` uses the existing rich Markdown editor. Other formats preserve their source and supply a read-only preview. `language` is a CodeMirror `Language`; `codeLanguage` connects highlighting to a registered language's setting. The host uses declarations in file pickers, rename/move checks, dropped files, workspace scanning, and source fallback.

Settings → Formats lists enabled format plugins. Rows open plugin settings or disable the plugin; disabled plugins can be enabled under Addons. Disabled addons contribute no format, syntax, highlighting, or plugin-settings entries. Markdown and plain text stay available. Disabling a format leaves its files and source unchanged.

`Preview` receives `{ value, document }` and renders normal/split previews. Rendering must never rewrite source. Source editing and common source addons remain available when a format is disabled. Markdown-specific formatting controls stay hidden for other formats.

`insertMedia(attachments)` can return source syntax for copied media; each attachment has `{ url, alt }`. `render(source, documentId?)` returns `{ html, css }` asynchronously for documentation export. The exported site sanitizes that HTML. Disposing a format removes its registration without deleting content.

## Syntax and highlighting

Use `registerDocumentSyntax` for format-specific syntax switches. It needs no Markdown token matcher and uses `isSyntaxEnabled` / `onSyntaxChange`. Markdown features still require token matchers.

`resolveCodeLanguage` and `renderCode` reuse enabled languages and escaped highlighting output. Use `onCodeHighlightingChange` to update previews when highlighting preferences change.

## Views and formatting

`views` declares supported modes: `normal` is editable rich content, `side-by-side` is source with preview, and `markdown` is the historical ID for source-only mode. Source must remain available. Markdown supports all three; plain text supports source only. Other bundled formats support source and split view. Unsupported buttons are disabled, palette actions are omitted, and shortcuts cannot select them. A disabled format falls back to source.

`formatting: 'markdown'` reuses Markdown's source toolbar and shortcuts. Other formats supply `DocumentFormatting`: supported action IDs, a pure `apply(action, selection)`, and optional `isActive`. The host applies the returned `DocumentEdit` as one validated undo step and preserves selections.

Common action IDs are `bold`, `italic`, `strike`, `heading-1` through `heading-6`, `paragraph`, `bullet-list`, `numbered-list`, `checklist`, `quote`, `inline-code`, `code-block`, `link`, `image`, `divider`, `hard-break`, and `table`. List only implemented actions. The host owns undo, redo, indent, and outdent.

`Preview` also receives a `toolbar` target. Render shared `PreviewActions` there for compile, run, and export buttons. The host supplies the sticky row and scrolling behavior; the component keeps its own state.

## Document state and export

`context.editor.getDocument()` reads the active snapshot. `onDocumentChange(listener)` reports the current document immediately when available, then reports edits and switches. The addon lifecycle owns listeners. `DocumentState.markdown` is the historical field name for the original source in every format.

`context.editor.renderDocument(source, filename, documentId?)` chooses a registered renderer or the Markdown pipeline. A Markdown flavor's `export.transform(rendered, source, documentId?)` runs after synchronous rendering and can compile embedded content. The older `renderMarkdown` API remains synchronous.

Set `MarkdownFlavor.readOnlyWhenDisabled: false` only when disabled syntax has a lossless built-in representation, such as a fenced code block. The default protects unknown syntax from destructive rich edits.

## Native modules

Trusted native addons can use `context.document.get()`, `context.document.path(id?)`, and `context.document.create(name, source)`. Paths resolve only to the active note or an opaque document ID in the selected workspace. Markdown content and renderer-only installed extensions never receive them. Creation uses the existing unsaved-change checks.

`context.exportFile(bytes, suggestedName, extension)` opens a save dialog and writes atomically, up to 64 MiB. It refuses to replace the open source document. Native addons must validate renderer input before compiling or exporting. Use `NativeAddon.stop()` to release workers and other resources when disabled.

Run heavy compilers in owned background processes with cancellation, bounded output, and scoped inputs. Typst provides an example in `src/addons/typst/`. Shared text-format services live in `src/addons/_shared/`: data-only metadata, disposable parser processes, and source toolbar mappings that use the host's selection and undo handling. Reuse these services instead of copying them into plugins.

See the [format guide](../../editing/formats.md) for dependencies and execution limits, and the [addon API](https://docs.hibi.garden/#page=development%2Faddon-api-reference%2FDocumentFormat.md) for signatures.
