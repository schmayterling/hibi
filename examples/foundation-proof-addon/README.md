# Foundation proof addon

This independently installed example exercises Hibi's public addon APIs. It uses the SDK factory supplied by Hibi and requires no Node access or source-tree imports.

Install this folder as an extension, enable it, then open a workspace and a note. Run **Capture foundation proof** from the Addons menu or command palette. The command captures the current document, creates `proof-note.md` only if that path is free, queries workspace backlinks and tags, and appends `#proof` to the captured document even if focus changes while an optional network request is pending. Results appear in a panel. The command has an in-app shortcut, `mod+alt+shift+f11`, which can be changed in Settings → Hotkeys.

The addon also suggests `[[proof-note]]` and `#proof` in source and rich editors. Selecting `#proof` offers an undoable **Capitalize proof tag** action. Hovering the tag shows a short explanation.

Global preferences use schema version 2. An older version 1 value with `endpoint`, `tag`, and `globalShortcut` migrates when the addon starts. The optional network URL must be an HTTPS address; Hibi asks for each destination and separately asks before accessing a local address. No fetched text is stored. A saved `globalShortcut: true` preference asks Hibi to register an optional OS-wide shortcut. Registration failure leaves the in-app command available. Workspace-scoped preferences and the last run result are retained across disablement; event subscriptions, providers, the panel, and shortcuts stop with the addon.

The command checks host credential availability. When the backend is unavailable or unprotected, it attempts to store a literal synthetic test value and records the expected denial code. It never retrieves stored plaintext or uses a real secret.
