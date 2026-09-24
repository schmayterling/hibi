# Workspaces

A workspace is an ordinary folder on your computer. Hibi keeps your files where they are.

## Open an Obsidian vault

Drop the vault folder onto Hibi or choose **Open a folder…**. Hibi opens the notes in place, keeps their folders, and ignores `.obsidian` while browsing. It does not change Obsidian's settings. Back up the vault before editing notes shared with Obsidian; Hibi shows this reminder when you first open the vault. If community plugins are enabled, the reminder also offers a link to Hibi's addons. Hibi does not run Obsidian plugins.

Wikilinks, frontmatter, nested tags, relative links, image and SVG embeds, highlights, and common callouts work without importing the vault. See [media and navigation](../editing/media-and-navigation.md) for link and attachment behavior.

## Open a folder

Choose **Open a folder…** in the sidebar, use **Open workspace…** in the command palette, or drop a folder onto Hibi. To reopen a workspace, choose **Open recent workspaces** in the command palette and select its path, or use the welcome screen. Opening a folder leaves your current note intact.

## Browse notes

To bring files from another folder or writing app, see [Import documents](importing.md).

Choose **Workspace** from the sidebar dropdown. Expand folders and select a file to open it. Arrow keys move focus, Left/Right collapse or expand a folder, and Enter opens a file.

Choose **Workspaces** from the sidebar views to see every folder you have opened in Hibi. Select a folder to open it. Each row's menu can pin it to the top or hide it until you open that folder again. **Delete workspace** asks for confirmation, then moves the folder and all its contents to system Trash. You can restore the folder from Trash.

Opening a file selects its existing tab or creates one. In single-file mode, Hibi asks what to do with unsaved changes first. Use each item's menu to [create, rename, copy, move, or delete files](../editing/explorer.md).

The tree updates when files change. By default, it shows supported documents and excludes hidden items, `node_modules`, and symbolic links. Turn on **Settings → Workspace → Show all files in sidebar** to include other file types and hidden files. Unsupported formats open in Source view, with Side-by-side and preview views disabled. Hidden folders, `node_modules`, symbolic links, and workspace ignore rules still apply. Files must be UTF-8 text no larger than 2 MiB to open in the editor. If Hibi reports that the folder is too large, open a smaller folder.

## Set up a Hibi workspace

In **Settings → Workspace**, turn on **Hibi workspace** to create `~/Documents/hibi`, or choose another folder. This is off by default. Changing the location assigns a different folder; **Relocate** moves the existing folder into the location you choose. When moving between disks, Hibi keeps the original copy.

Choose what opens **At startup**: the empty state, your Hibi workspace, or another folder. Files opened from Finder or another application take precedence.

## Name and configure a workspace

Open any folder and choose **Create manifest** in Settings → Workspace. Hibi stores workspace information in `.hibi/workspace.json`. Set a name, description, icon identifier, and optional default document. Renaming here changes the display name, leaving the folder path intact. The default document opens when Hibi starts in this workspace.

The **Ignore rules** field writes `.hibi/ignore`. It uses gitignore syntax: `drafts/` hides a folder, `*.tmp` hides matching files, and `!keep.tmp` includes an otherwise ignored file. To include a file within an ignored folder, include its parent folder too. Ignored documents stay on disk and are omitted from workspace browsing and export.

Older `.hibi.json` and `.hibiignore` files still work. Saving workspace settings writes the new files inside `.hibi/` and keeps the originals. The new files take precedence.

## Use the page outline

Choose **On this page** to browse the current note's headings. Select a heading to jump to it; the outline highlights the section containing your cursor.

Source view lists Markdown headings, including headings inside quotes and lists. Labels follow your syntax settings and resolve reference links. Confirmed top-level math blocks hide their contents from the outline. Unsupported addon syntax or math inside containers shows an unavailable message; switch to visual mode for those notes. Headings produced by embedded HTML appear in formatted views.

## Show and resize the sidebar

Press `Cmd/Ctrl+/` or use the sidebar button to show or hide it. Drag its right edge to resize it, drag farther past the minimum to collapse it, or double-click the edge to restore its default width.

With the resize edge focused, use Left/Right to adjust it, hold Shift for larger steps, and press Enter to reset it. Escape cancels a drag. Workspace and settings sidebars share your chosen width.

In a narrow window, the sidebar opens over the editor. Selecting a file or heading closes it so you can read the full-width note. Press Escape or click outside to dismiss it. Keyboard focus stays in the sidebar when its rows refresh, unless you move focus elsewhere. Widening the window restores your previous sidebar layout.

## Use the right sidebar

Use **Toggle right sidebar** at the top of the window or in the command palette. It starts collapsed with no view selected. Open **Right sidebar views** to choose the page outline or an enabled addon view, or choose **No view** to leave it empty. Workspace files remain in the left sidebar.

Drag the right sidebar's left edge to resize it. Drag toward the right past its minimum width to collapse it. Double-click the edge or press Enter while it is focused to reset the width. Its width and selected view are remembered independently; both document sidebars start collapsed when you reopen Hibi.

Both sidebars can stay open in a wide window. In narrow windows, opening one drawer closes the other. Settings and zen mode hide the right sidebar until you return to the editor.
