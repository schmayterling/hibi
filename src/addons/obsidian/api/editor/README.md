# editor service

`MarkdownView` and `Editor` describe one Hibi note pane. The Editor reads the note's canonical source and writes each call as one version-checked source edit, so undo, autosave, recovery and every pane of the note stay consistent. Positions count every line break as one character; edits keep the note's own line endings. An Editor whose pane has moved to another note or view throws instead of acting on the new one. Hibi draws one selection range: extra ranges a plugin sets are kept by the Editor for `listSelections`, `replaceSelection` and `transaction`, and are dropped once the note or the drawn range changes.

`registerEditorExtension` installs each extension as its own Hibi editor feature in every source and formatted view, split panes included. Hibi's fault isolation removes only an extension that fails and names its plugin. `editorInfoField` and `editorLivePreviewField` (true in the formatted view) are provided.

Code block processors render fenced blocks in the formatted view through Hibi's fenced widget hook; `getSectionInfo` reports the fence's lines and `sourcePath` the note of the pane the block is in. Post processors run on `MarkdownRenderer.render` output, not on the live editor. `MarkdownRenderer.render` sanitizes the Markdown it renders, including inline styles.

Plugins are not sandboxed. Code block and post processors receive real DOM elements, like Hibi's widget API, and their own output is not sanitized. `EditorSuggest` is refused: Hibi's completions are data-only, and a plugin's `selectSuggestion` cannot run.
