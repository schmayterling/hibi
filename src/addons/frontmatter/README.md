# Frontmatter

Frontmatter lets you edit note properties, such as a title or date, above the document body. The properties are stored as YAML at the start of the Markdown file. This addon is on by default.

Choose **Add frontmatter** from the command palette or type `/frontmatter` in the slash menu. In normal view, expand the properties section to edit values. Choose **Add property** to add a name and type, or use a row's action to remove it.

Very large metadata sections stay visible as Markdown in the CodeMirror formatted view. Word and character totals include that visible metadata. Hibi hides **Add frontmatter** from the slash menu and withholds source-view slash commands when the opening section is too large to check while typing. You can still edit and save the complete note.

Complex properties open in the YAML editor. If the note's properties change while that editor is open, cancel and reopen it before applying your draft.
