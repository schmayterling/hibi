# Markdown

Open `.md` and `.markdown` files to write in normal view, edit Markdown source, or see both side by side.

Markdown is always available. GitHub-style tables, task lists, strikethrough, automatic links, and callouts are included. Hibi also reads Obsidian wikilinks, image embeds, and `==highlights==` in place. Choose formatting features in **Settings → Syntax** and source colors in **Settings → Code highlighting**.

Add `-` directly after a callout's type to start it collapsed, or `+` to start it expanded:

```markdown
> [!note]- Optional details
> This body starts hidden.

> [!tip]+ More information
> This body starts visible.
```

In either formatted editor, use the chevron beside the title to fold or unfold the body. Focus the chevron and press Enter or Space to toggle it with the keyboard. Folding does not change the Markdown file. Callouts without `+` or `-` always show their bodies.

Each tab keeps the folds you set until you quit, also when you come back to it or its file changes on disk. At a folded callout, the arrow keys step over the hidden body in one press. Backspace or Delete next to the hidden body unfolds it instead of deleting text you cannot see; press the key again to delete.

Exports show these callouts as disclosures you can open and close: open for `+` and closed for `-`. PDFs and printed pages show every body.

Plain `.txt` files use Hibi's built-in text editor and do not need a addon.
