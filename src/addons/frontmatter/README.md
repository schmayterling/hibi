# Frontmatter

Frontmatter lets you edit note properties, such as a title or date, above the document body. The properties are stored as YAML at the start of the Markdown file. This addon is on by default.

Choose **Add frontmatter** from the command palette or type `/frontmatter` in the slash menu. In normal view, expand the properties section to edit values. Choose **Add property** to add a name and type, or use a row's action to remove it.

in the codemirror formatted and source views, frontmatter checks recognize metadata only when the closing marker starts within the first 262,144 utf-16 code units. larger spans remain editable markdown so a distant divider cannot trigger a large yaml parse while typing. the note itself is never truncated.

Complex properties open in the YAML editor. If the note's properties change while that editor is open, cancel and reopen it before applying your draft.
