# Keyboard shortcuts

Use `Cmd` on macOS and `Ctrl` on Windows and Linux where a shortcut says `Cmd/Ctrl`. Change app shortcuts under **Settings → Hotkeys**.

Letter shortcuts and punctuation on letter keys follow your active keyboard layout, including Dvorak. Digit-row shortcuts and other punctuation positions retain their physical bindings so existing defaults remain available on international keyboards. Characters outside the supported shortcut notation, including some Option-modified characters and non-Latin letters, retain their physical key bindings. Shortcut recording uses the same mapping.

## App shortcuts

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl+K` | Search commands and settings |
| `Cmd/Ctrl+F` | Find text in the current note |
| `Cmd/Ctrl+/` | Show or hide the sidebar |
| `Cmd/Ctrl+N` | New note |
| `Cmd/Ctrl+O` | Open a file |
| `Cmd/Ctrl+S` | Save |
| `Cmd/Ctrl+Z` | Undo |
| `Cmd/Ctrl+Shift+Z` | Redo |
| `Cmd/Ctrl+Shift+S` | Save as |
| `Cmd/Ctrl+W` | Close the current tab |
| `Cmd/Ctrl+Alt+Left` / `Right` | Previous / next tab |
| `Cmd/Ctrl+[` / `]` | Go back / forward |
| `Cmd/Ctrl+Shift+[` / `]` | Normal / Source view |
| `Cmd/Ctrl+Shift+\` | Side-by-side view |

## Undo and redo

Undo history is shared between source and formatted editing and survives switching tabs. Hibi limits the memory used by history; when it needs space, older edits in less recently used tabs may stop being undoable. This keeps your current text and saved files intact. Use [Version history](version-history.md) to restore an earlier saved version.

## Markdown formatting

These shortcuts work in source panes as well as the formatted editor. The toolbar shows the actions available for the current format.

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl+B` | Bold |
| `Cmd/Ctrl+I` | Italic |
| `Cmd/Ctrl+E` | Inline code |
| `Cmd/Ctrl+Shift+X` | Strikethrough |
| `Cmd/Ctrl+Alt+0` | Paragraph |
| `Cmd/Ctrl+Alt+1`–`6` | Heading level |
| `Cmd/Ctrl+Shift+7` | Numbered list |
| `Cmd/Ctrl+Shift+8` | Bullet list |
| `Cmd/Ctrl+Shift+9` | Task list |
| `Cmd/Ctrl+Shift+B` | Quote |
| `Cmd/Ctrl+Alt+C` | Code block |
| `Cmd/Ctrl+Enter` | Continue after a final formatted block |

Custom app bindings take precedence over formatting shortcuts. [Vim](../guides/vim.md) handles its own keys first in source mode.

Previous and next tab shortcuts wrap at either end of the tab strip and include addon tabs. Some Linux desktops reserve `Ctrl+Alt+Left/Right` for switching workspaces; choose another binding under **Settings → Hotkeys** if those keys do not reach Hibi.

In an editable formatted list, `Tab` indents an item and `Shift+Tab` outdents it. If an item cannot move farther, focus stays in the editor. Outside lists, `Tab` keeps its usual keyboard navigation behavior.

## Typing speed

Enable **Typing speed** under **Settings → Addons** to see estimated words or characters per minute while typing. For document totals instead, enable **Word count**.
