# Slash commands

Slash commands insert Markdown syntax without leaving the keyboard. The addon is enabled by default; turn it on or off under **Settings → Addons**.

## Insert syntax

1. Start a paragraph or source line with `/`.
2. Type a command or keyword, such as `/h2`, `/todo`, or `/table`.
3. Choose a result with Up/Down Arrow, then press Enter or Tab. You can also click a result.

Escape or an outside click closes the menu and leaves your text unchanged. The menu follows enabled syntax under **Settings → Syntax**, including syntax added by addons. Some syntax, such as links and HTML, appears only in source view. Undo restores the previous text.

## Addon actions

Enabled addons can add commands. For example, Frontmatter adds `/frontmatter` when the note has no page properties. Actions that change a whole note can reset undo history in the formatted editor; source-view undo remains available.

## Where it works

Slash commands work in Markdown's normal, source, and side-by-side views, except inside code or frontmatter. With Vim enabled, use insert mode; `/` keeps its search meaning in Vim normal mode.
