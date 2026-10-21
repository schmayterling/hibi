# Editing

Hibi opens on the welcome screen with no document tabs. Start typing to create an unsaved `untitled.md` tab, choose **Open a file…**, use **File → Open**, or select a recent workspace. Choose **Open workspace…** to pick a folder and open it as a workspace.

## Choose a view

**Normal** lets you format text without seeing Markdown markers. **Source view** shows the original text with syntax highlighting. **Side-by-side** places editable source next to a read-only formatted preview. You can select and copy preview text; switch to **Normal** to edit formatted text.

While you type in the source pane, the formatted pane may catch up shortly after you pause. Your changes are available to saving and undo immediately. Entering the formatted pane brings it up to date for reading and selection.

Choose your starting view under **Settings → Editor → Layout → Default view**. Only views supported by the current [format](../editing/formats.md) are available. You can switch from the toolbar or use a [keyboard shortcut](../editing/typing-and-shortcuts.md).

Switching views preserves your source. Normal view stays editable regardless of character count or word count. Hibi keeps untouched Markdown when you edit formatted text, including when addons such as LaTeX are enabled, and rejects an edit if it cannot prove the resulting source is safe. Use Source view for syntax the formatted editor cannot preserve, including reference definitions.

Raw HTML appears as a monospace source chip or box in Normal view. Hibi preserves the markup without running it or turning it into live HTML. Click a chip or box to select it, then press Delete or Backspace to remove it as a unit. Use Source view to edit the HTML itself. A chip can include surrounding Markdown formatting to keep the whole fragment intact. When HTML surrounds several Markdown blocks, its opening and closing fragments appear in separate boxes, and you can edit the Markdown between them. Plain `<br>` tags remain line breaks and keep their original spelling when saved. Copying or dragging a chip within the same window preserves it while its copied content is still recognized, including with native copy and paste on Windows. Pasting a chip into another window or after reloading inserts inline code or a fenced code block instead.

When you use an input method, choosing and revising candidates remains one undo step even if you pause between candidates. Each new composition starts a separate undo step in both source and formatted views.

## Work with tabs

Opening or creating a note adds a tab. Select one to return to its document, drag it to change its position, or press `Cmd/Ctrl+W` to close it. Closing the last document tab returns to the welcome screen. A dot marks unsaved changes. Hibi asks before discarding unsaved work.

Press `Cmd/Ctrl+Alt+Left/Right` while editing to switch to the previous or next tab, including addon tabs. Navigation wraps at either end and keeps unsaved edits. Change these shortcuts under **Settings → Hotkeys**.

Press `Cmd/Ctrl+K`, choose **Split right**, then choose an open document to show two editor panes side by side. You can show the same document twice with separate selections and scroll positions, or edit two documents at once. Click a pane to direct toolbar and keyboard commands to it. Each pane keeps its own view mode. Use **Close split** to return to one pane without closing either tab. On a narrow window, only the active pane is visible.

With a tab focused, arrow keys and Home/End move between tabs. Use `Alt+Shift+Left/Right` to reorder them with the keyboard.

Addons can also open their own tabs. Select an addon tab to show its view, or close it with its close button or `Cmd/Ctrl+W`. Returning to a document tab keeps the addon tab available until you close it or turn off the addon.

Opening or creating a document through Hibi's file controls or the explorer, opening a file from another app, or dropping a file onto Hibi shows the document and keeps the addon tab's session available. An addon can open a note while keeping its own tab selected, including from its sidebar or commands. Opening a note from another addon shows the document. Cancelling an open, an unsuccessful open, or closing or reordering a document tab in the background keeps the addon tab selected.

To keep one file open at a time, turn off **Settings → Editor → Documents → Use tabs**. Hibi keeps the active note and asks what to do with other unsaved tabs. Turning tabs back on does not reopen closed notes. Open tabs are not restored after quitting Hibi.

## Format text

Select text, then choose a toolbar action. In side-by-side view, formatting actions are available while the source pane is focused. The toolbar offers tools for the current format, with extra buttons in the **More** menu. Within an editable formatted table, additional actions let you add or remove rows and columns.

New profiles start with undo and redo, bold and italic, two heading levels, lists, links, and images. Other formatting actions stay in **More**. Tags, workspace graph, and keyboard sound buttons start hidden; their commands remain available. Existing toolbar layouts are preserved.

To resize a table column or row in Normal view, drag the right or bottom border of a cell. Columns and rows never shrink below their content. Double-click a border to return that column or row to its automatic size. Sizes are not part of the Markdown, so resizing never changes the file or adds an undo step. For files in a workspace, Hibi remembers sizes in `.hibi/layout.json`. Files outside a workspace keep their sizes only until you close them. Moving a table with Block dragging in Normal view keeps its sizes. Saved layouts still use table order and header text, so reordering tables or editing their headers in Source view or another app can reset sizes. Exports use automatic sizes.

In Normal view and its side-by-side preview, soft line breaks and surrounding spaces or tabs display as a single space, including inside task items. Repeated spaces and tabs elsewhere keep their width.

Escaped block prefixes such as `\# heading` and `1\. item` remain literal text when you edit and save in normal view. Leading spaces and tabs at the start of a paragraph outside tables are preserved when saving.

In formatted view, the active text block shows subtle Markdown hints for heading levels, bold, italic, strikethrough, and inline code. They follow the cursor and disappear when focus leaves the formatted editor or you select several blocks. Code blocks keep their literal text without extra hints.

These markers are visual hints, not editable characters or a verbatim view of the original delimiters. They are excluded from copied text, saved Markdown, and exports. Use source view to edit the syntax itself. To hide the hints, turn off **Settings → Editor → Writing → Show Markdown markers**. The setting is on by default and persists on this device.

At the end of a document, press the right arrow key to leave bold, italic, strikethrough, or inline code and continue with plain text. The cursor moves past the closing hint without adding a space or changing your text. This also works when Markdown markers are hidden.

In GitHub Markdown, `- [ ]` and `- [x]` display as unchecked and checked tasks even without text after the marker. Type either marker followed by a space in Normal view to create a task. You can mix tasks with ordinary bullets and nest tasks inside bullet lists. Consecutive empty tasks stay in one list and can be indented with `Tab`. Indented continuation text belongs to the task. Checkboxes in numbered lists, such as `1. [ ]`, stay literal.

For footnotes in GitHub Markdown, write `text[^note]` and add a definition such as `[^note]: Reference text.` in Source view. Side-by-side view and HTML export place referenced notes at the end of the document. Notes with footnote definitions open without Normal view so their source stays intact.

Under **Settings → Appearance → Toolbar → Arrange toolbar actions**, drag actions or use the arrow controls to reorder them. By default, addon actions follow formatting actions. Select an action and choose **Show in toolbar**, **Menu only**, or **Hide**. Menu-only actions always stay in the **More** dropdown, even in a wide window. Hidden actions disappear from both the toolbar and its dropdown; their commands and shortcuts remain available. These choices are saved separately from the order, so **Reset order** keeps each action's placement.

You can also choose how toolbar buttons appear. The toolbar stays visible while you type unless you turn on **Hide toolbar while typing**. When it is hidden, pause or move the pointer to the top of the window to reveal it.

See [images and attachments](../editing/media-and-navigation.md#attachments) for adding media to your notes.

## Find text and commands

Press `Cmd/Ctrl+F` to find text in the document. Enter moves to the next match, Shift+Enter moves back, and Escape closes search. In side-by-side view, search uses the pane you last focused.

In source view, **Searching…** means match counts are still being checked against the current document. Editing or changing the query cancels outdated results. If find becomes unavailable, close and reopen it to retry; document editing and saving stay available.

Press `Cmd/Ctrl+K` to search commands and settings. Use arrow keys and Enter to choose a result. Some commands open another list of options; the pill beside the search field shows which list is open. Press Escape, press Backspace in an empty search field, or click the pill's × to return to the previous list. Escape closes the palette from the main list.

## Save and rename

Use **File → Save** (`Cmd/Ctrl+S`) or **Save as** (`Cmd/Ctrl+Shift+S`). New notes need a location before [autosave](settings.md#autosave) can work. If another app changes a file, Hibi asks before replacing it.

You can keep typing while saving. If you save again before the current save finishes, Hibi saves your latest edits afterward.

On Windows, Hibi briefly retries saving if another program temporarily locks the file. If the lock persists, the save fails and your edits stay unsaved.

Empty paragraphs are saved as blank lines without nonbreaking-space placeholders. Consecutive empty lines collapse to normal paragraph spacing in exported HTML.

When normal view rewrites Markdown, entity references such as `&copy;` can save as their decoded characters. Typed and pasted characters stay literal unless Markdown would change or discard them, such as literal line-break characters from entity references or tabs and nonbreaking spaces at paragraph line edges. Literal Markdown punctuation stays protected, and code keeps its literal text.

To rename a note, run **Rename document…** from the command palette or choose **Rename** in its workspace menu. Renaming keeps unsaved edits and does not replace another file.

Files must use UTF-8 and be no larger than 2 MiB. Save your work regularly: unsaved drafts can be lost in an app or machine crash. [Version history](../editing/version-history.md) stores previous saves.

## Optional writing tools

Enable **Mermaid** to edit `.mmd` diagrams and render Mermaid code blocks in Markdown. **BBCode** adds `.bbcode` and `.bbc` files with a preview and formatting toolbar. Both addons offer HTML export from side-by-side view.

Under **Settings → Addons**, enable **Word count** for word and character totals, or **Block dragging** to rearrange formatted text using a grip beside each block. The grip also offers **Move block up/down**, and moves support undo.

Enable **Writing suggestions** for workspace tag completions after `#`, note-path completions after `[[` in Source view, and a `;todo` text snippet in either editing view. Choose a suggestion with Enter or Tab; Escape leaves the text unchanged.

Enable **Dictionary and thesaurus** to look up definitions and synonyms for the word at the cursor in English, Chinese, Cantonese, Japanese, Filipino, or French, then replace it with a synonym. Looked-up words are sent to online services unless an offline pack answers, so the addon is off by default. Its readme in **Settings → Addons** describes which services it uses.

The **Frontmatter** addon adds editable [page properties](frontmatter.md). **Settings → Editor → Writing → Spell check** controls spelling underlines in formatted text. See [settings](settings.md) for other preferences.
