# Quick note

Quick note captures a Markdown note while Hibi is running, even when another application has focus. Enable the addon in **Settings → Addons**. Its default global shortcut is `Cmd/Ctrl+Alt+N`. You can also choose **Quick note: capture** from the command palette.

In **Settings → Quick note**, choose the current workspace, a recent workspace, or use **Choose workspace…** to select another folder as a workspace. Then select its root or a folder. You can keep the default title, change it, or ask for a title each time. Set a different global shortcut using an Electron accelerator such as `CommandOrControl+Alt+N`, or clear the field to disable it. Press **Save settings** to apply your choices. If another application owns the shortcut, choose a different one; the command palette action remains available.

The capture window accepts Markdown text. Press **Save note** or `Cmd/Ctrl+Enter` to create a new `.md` file in the selected folder. Repeated titles receive a number so an existing note is never replaced. Closing the capture window leaves the workspace unchanged.

The shortcut works while Hibi is running. On macOS, it can reopen Hibi after you close its last window. Quitting Hibi releases the shortcut.
