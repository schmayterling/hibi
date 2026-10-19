# Manage workspace files

Open a file or folder's **More** menu to manage it. Right-click and `Shift+F10` open the same menu.

## Select multiple items

Click a file to select and open it, or a folder to select and expand it. Hold `Cmd` on macOS or `Ctrl` on Windows and Linux while clicking to add or remove items without opening them. Hold `Shift` while clicking to select every visible item between the last item you chose and the one you click; items inside collapsed folders are not included.

With the keyboard, the arrow keys move between items without changing the selection. Press `Space` to add or remove the focused item, hold `Shift` with the arrow keys, `Home`, or `End` to extend the selection, and press `Cmd+A` or `Ctrl+A` to select every visible item. Press Enter to open a file or expand a folder.

Opening the menu on a selected item applies its actions to the whole selection. Opening it on an item outside the selection selects only that item. Group menus offer **Open** when every item is a file and tabs are on, along with **Duplicate**, **Copy to**, **Move to**, **Copy relative paths**, and **Move to trash**. Actions for a single item, such as **Rename** and **New file**, appear only when one item is selected. If you select a folder and items inside it, file actions such as moving or trashing apply to the folder once, while **Copy relative paths** lists every selected item.

Group actions run one item at a time. If an item cannot be changed, for example because another item already uses its name in the destination, Hibi stops and reports how many items finished. Items already changed stay changed, and nothing is overwritten.

## Create and rename

Use the workspace controls or a folder's menu to create a note or folder. The name field receives keyboard focus so you can type immediately. Enter its name, including the extension, and press Enter or click outside the field to accept it. Press Escape to keep the original name. New notes use the current document's extension unless you change it. They stay in memory until you save them; new folders are created immediately.

Choose **Rename** to change an item's name. Renaming a file or its parent folder keeps unsaved edits and does not replace another file.

## Move, copy, and duplicate

Choose **Move to** or **Copy to** and enter a destination relative to the workspace, including the new name. For a group, enter the destination folder instead, or leave it empty for the workspace root; each item keeps its name. You can also drag an item onto a folder, or onto empty sidebar space to move it to the workspace root. Dragging a selected item moves the whole selection. Hibi checks for an existing item before moving or copying. If another app changes the workspace at the same time, review both locations before retrying.

**Copy to** and **Duplicate** use saved content from disk. Save your edits first to include them.

## Delete

**Move to trash** uses your system trash. Hibi asks before trashing a folder and checks any unsaved notes affected by the deletion. Choose Save, Discard, or Cancel when prompted.
