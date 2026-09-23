# Obsidian plugin loader

Enable this addon in **Settings → Addons**, then choose **Manage Obsidian plugins** from the command palette. Select a folder containing a compiled Obsidian plugin's `manifest.json` and `main.js`. The loader copies the files into Hibi's private application data; it does not change your Obsidian vault. Review the trust warning, then enable the installed plugin in the sidebar.

The loader supports browser-compatible plugins that use the available Obsidian API bridge. Plugins that require Node.js or Electron are rejected. A plugin may still rely on Obsidian interfaces Hibi does not provide; its load error appears beside the plugin. Disable or remove plugins from the same sidebar. Removal sends the installed copy and saved settings to Trash.

Supported plugins can register commands, notices, simple modals and settings, status items, toolbar actions, and source-editor extensions. They can list and read Markdown notes in the open workspace, create notes, and modify saved notes. Hibi rejects a write when the note has changed since the plugin read it or any open note has unsaved edits. Rename and trash actions follow Hibi's workspace safeguards.

The bridge also provides basic cached note metadata, including properties, headings, links, embeds, and tags. It reloads plugins when you switch workspaces. Obsidian pane views, Markdown postprocessors, Bases, direct filesystem adapters, Node.js, and Electron APIs are not available. Plugins that call these APIs show a named error instead of running partially.

Obsidian plugins run code in Hibi's renderer and can read or change your notes. Install only plugins you trust. Opening a workspace never installs or enables its plugins automatically.
