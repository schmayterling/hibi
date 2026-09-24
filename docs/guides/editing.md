# Editing

Hibi opens on the welcome screen with no document tabs. Start typing to create an unsaved `untitled.md` tab, choose **Open a file…**, use **File → Open**, or select a recent workspace.

## Choose a view

**Normal** lets you format text without seeing Markdown markers. **Source view** shows the original text with syntax highlighting. **Side-by-side** places editable source next to a read-only formatted preview. You can select and copy preview text; switch to **Normal** to edit formatted text.

While you type in the source pane, the formatted pane may catch up shortly after you pause. Your changes are available to saving and undo immediately. Entering the formatted pane brings it up to date for reading and selection.

Choose your starting view under **Settings → Editor → Layout → Default view**. Only views supported by the current [format](../editing/formats.md) are available. You can switch from the toolbar or use a [keyboard shortcut](../editing/typing-and-shortcuts.md).

Switching views preserves your source. Normal view stays editable regardless of character count or word count. Hibi keeps untouched Markdown when you edit formatted text and rejects an edit if it cannot prove the resulting source is safe. Use Source view for syntax the formatted editor cannot preserve, including some raw HTML and reference definitions.

When you use an input method, choosing and revising candidates remains one undo step even if you pause between candidates. Each new composition starts a separate undo step in both source and formatted views.

## Work with tabs

Opening or creating a note adds a tab. Select one to return to its document, drag it to change its position, or press `Cmd/Ctrl+W` to close it. Closing the last document tab returns to the welcome screen. A dot marks unsaved changes. Hibi asks before discarding unsaved work.

With a tab focused, arrow keys and Home/End move between tabs. Use `Alt+Shift+Left/Right` to reorder them with the keyboard.

Addons can also open their own tabs. Select an addon tab to show its view, or close it with its close button or `Cmd/Ctrl+W`. Returning to a document tab keeps the addon tab available until you close it or turn off the addon.

To keep one file open at a time, turn off **Settings → Editor → Documents → Use tabs**. Hibi keeps the active note and asks what to do with other unsaved tabs. Turning tabs back on does not reopen closed notes. Open tabs are not restored after quitting Hibi.

## Format text

Select text, then choose a toolbar action. In side-by-side view, formatting actions are available while the source pane is focused. The toolbar offers tools for the current format, with extra buttons in the **More** menu. Within an editable formatted table, additional actions let you add or remove rows and columns.

In formatted view, the active text block shows subtle Markdown hints for heading levels, bold, italic, strikethrough, and inline code. They follow the cursor and disappear when focus leaves the formatted editor or you select several blocks. Code blocks keep their literal text without extra hints.

These markers are visual hints, not editable characters or a verbatim view of the original delimiters. They are excluded from copied text, saved Markdown, and exports. Use source view to edit the syntax itself. To hide the hints, turn off **Settings → Editor → Writing → Show Markdown markers**. The setting is on by default and persists on this device.

At the end of a document, press the right arrow key to leave bold, italic, strikethrough, or inline code and continue with plain text. The cursor moves past the closing hint without adding a space or changing your text. This also works when Markdown markers are hidden.

Under **Settings → Appearance → Toolbar → Arrange toolbar actions**, drag actions or use the arrow controls to reorder them. By default, addon actions follow formatting actions. Select an action and choose **Show in toolbar**, **Menu only**, or **Hide**. Menu-only actions always stay in the **More** dropdown, even in a wide window. Hidden actions disappear from both the toolbar and its dropdown; their commands and shortcuts remain available. These choices are saved separately from the order, so **Reset order** keeps each action's placement.

You can also choose how toolbar buttons appear. If the toolbar hides while typing, pause or move the pointer to the top of the window to reveal it.

See [images and attachments](../editing/media-and-navigation.md#attachments) for adding media to your notes.

## Find text and commands

Press `Cmd/Ctrl+F` to find text in the document. Enter moves to the next match, Shift+Enter moves back, and Escape closes search. In side-by-side view, search uses the pane you last focused.

In source view, **Searching…** means match counts are still being checked against the current document. Editing or changing the query cancels outdated results. If find becomes unavailable, close and reopen it to retry; document editing and saving stay available.

Press `Cmd/Ctrl+K` to search commands and settings. Use arrow keys and Enter to choose a result. Some commands open another list of options; the pill beside the search field shows which list is open. Press Escape, press Backspace in an empty search field, or click the pill's × to return to the previous list. Escape closes the palette from the main list.

## Save and rename

Use **File → Save** (`Cmd/Ctrl+S`) or **Save as** (`Cmd/Ctrl+Shift+S`). New notes need a location before [autosave](settings.md#autosave) can work. If another app changes a file, Hibi asks before replacing it.

To rename a note, run **Rename document…** from the command palette or choose **Rename** in its workspace menu. Renaming keeps unsaved edits and does not replace another file.

Files must use UTF-8 and be no larger than 2 MiB. Save your work regularly: unsaved drafts can be lost in an app or machine crash. [Version history](../editing/version-history.md) stores previous saves.

## Optional writing tools

Enable **Mermaid** to edit `.mmd` diagrams and render Mermaid code blocks in Markdown. **BBCode** adds `.bbcode` and `.bbc` files with a preview and formatting toolbar. Both addons offer HTML export from side-by-side view.

Under **Settings → Addons**, enable **Word count** for word and character totals, or **Block dragging** to rearrange formatted text using a grip beside each block. The grip also offers **Move block up/down**, and moves support undo.

The **Frontmatter** addon adds editable [page properties](frontmatter.md). **Settings → Editor → Writing → Spell check** controls spelling underlines in formatted text. See [settings](settings.md) for other preferences.
