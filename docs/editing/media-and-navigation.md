# Media and navigation

## Files and folders

Drop a supported file onto Hibi to open it, or drop a folder to open a workspace. See [workspace file actions](explorer.md) for moving and organizing files in the sidebar.

## Attachments

Use the image toolbar button to choose an image or video, or drop one into the editor. An untitled note asks you to save first; canceling leaves it unchanged.

Hibi copies attachments into an `assets` folder beside the note and keeps the originals. Move the note and its assets together to keep media working. In Markdown source, edit the description in `![description](assets/image.png)` to give screen readers useful text.

### Supported media

Images can be PNG, JPEG, GIF, WebP, AVIF, or SVG, up to 8 MiB each. Videos can be MP4, MOV, WebM, or OGG/Theora, up to 512 MiB each, though playback depends on the codec. Hibi does not download remote media automatically.

[Documentation exports](../guides/exporting.md) have a 20 MiB total limit, so share large videos separately.

### Local paths

Relative paths start from the saved note's folder. Absolute paths and local `file:` URLs also work. Use percent encoding or angle brackets for spaces in Markdown paths. Missing media shows its description instead.

Obsidian `![[image.png]]` and `![[drawing.svg]]` embeds also display in the formatted editor. Hibi looks beside the note, at the vault root, and in the attachment folder named by Obsidian's `attachmentFolderPath` setting. Hibi reads that setting without changing `.obsidian` files. `![[Other note]]` shows a link to the note rather than embedding its content.

## Links and history

Shift-click a link to follow it. In Normal view, you can also hold Ctrl+Cmd while clicking a link. Web and email links open in your default app; local note links open in Hibi. Regular clicks keep editing.

Obsidian `[[Note]]`, `[[Note|Alias]]`, and links to headings or blocks open their note in the current workspace. A heading-only link in the current note jumps to that heading. Links to headings or blocks in another note open the note; Hibi does not yet scroll to the target within that note. Ambiguous note names do not open a guessed target.

In Markdown source, this also follows reference links such as `[guide][help]` with a `[help]: guide.md` definition elsewhere in the note. Labels ignore case, and the first matching definition wins. Definitions inside enabled frontmatter are excluded. This supports the built-in Markdown, GitHub Markdown and Text extras readers; addons with custom parsers or projections keep their existing link behavior.

Use `Cmd/Ctrl+[` to go back and `Cmd/Ctrl+]` to go forward through opened notes. In Settings, these shortcuts navigate settings pages instead. History lasts until you close the app.

## Open remote Markdown

Choose **File → Open from URL…** and enter a direct HTTP or HTTPS link to a text file. Hibi opens it as an editable draft. Save it locally to keep it; Hibi never writes back to the server.

The download must be UTF-8 text under 2 MiB, rather than a webpage. Relative attachment paths need matching local assets after you save.

## Continue after a formatted block

To type after a final table, code block, or list, press `Cmd/Ctrl+Enter` or click the blank editor area below it. Hibi adds a normal paragraph.
