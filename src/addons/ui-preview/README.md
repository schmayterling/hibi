# UI preview

Open **UI preview** from the command palette to inspect Hibi's buttons, fields, switches, and status colors. Edit the sample text to see how longer content fits. **Show red outlines** marks the preview elements so you can inspect their boundaries.

Enter CSS in **Custom CSS** and turn on **Enable custom CSS** to preview it across Hibi. Changes take effect as you type. Choose **Save CSS** to keep the CSS and its enabled state after restarting Hibi. Choose **Revert** or close the preview tab to discard unsaved changes. Saved CSS can be up to 64 KiB.

Custom CSS affects Hibi's renderer UI, not native menus, system dialogs, or OS window decorations. The loading screen uses Hibi's standard appearance until the addon starts.

If saved CSS makes the interface hard to use, choose **Disable custom CSS** from the native Addons menu. This turns off the saved stylesheet without deleting its text. You can reopen UI preview to edit and enable it again.

UI preview is enabled by default in development builds. In release builds, turn it on under **Settings → Addons**.
