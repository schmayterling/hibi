# Settings

Open Settings from the command palette or top bar. Choose a page in the sidebar, or search below **Back to app** for a setting or enabled addon.

Use the sidebar button or `Cmd/Ctrl+/` to collapse or expand settings navigation. In a narrow window, it opens over the page and closes when you choose a page or search result. Press Escape or click outside to dismiss it.

## Editor and appearance

Use **Editor** for [tabs, default view, and spell check](editing.md). Use **Appearance** to change [colorschemes](colorschemes.md), the toolbar, and cursor style.

Under **Editor → Modal editing**, Hibi shows the current modal addon and explains how switching works. Hibi allows only one modal addon at a time. Enabling another modal addon asks before disabling the current one. Disabling a modal addon never enables another one automatically.

Turn on **Focus outlines** under **Appearance → Focus** if you want borders around focused buttons and navigation. To reduce animations, enable your system's reduced-motion setting.

Hover over a control briefly to see its compact help tooltip, or reach it with keyboard navigation. Moving away, clicking, typing, or hiding the control dismisses the hint.

**Lowercase interface** displays app text in lowercase without changing documents, typed values, code, or case-sensitive commands.

Under **Appearance → Window**, set **Status bar** to **Show**, **Auto-hide**, or **Hide**. Auto-hide reveals the bar when you move to the bottom edge of the editor or focus one of its controls.

**Zen mode** hides navigation, toolbars, and status while you write. Use **Enter zen mode** in the command palette or turn it on in Appearance. Leave with the exit button at the top or **Exit zen mode** in the palette. Your previous layout returns when you leave. You can assign a shortcut under Hotkeys.

## Autosave

Autosave is off by default. Enable it under **Editor** and choose how long to wait after typing stops. New notes and remote drafts need one manual save to choose a local destination.

If another app changes the file, autosave pauses. Save manually to review the conflict.

## Keyboard shortcuts

Under **Hotkeys**, select a binding and press a new shortcut. Enter saves it and Escape cancels. You can clear individual shortcuts or reset them. Hibi rejects conflicts and reserved shortcuts; menus and the command palette show your current bindings.

## Sidebar views

The dropdown beside the sidebar button lists available views. Use its first item to pin or unpin a titlebar tab for the current view; you can pin up to three. **On this page** shows the document's headings and highlights your current section. See [workspaces](workspaces.md) for navigation and resizing.

The right sidebar starts collapsed with no view selected. Use **Toggle right sidebar**, then **Right sidebar views** to choose **On this page** or an enabled addon view. Choose **No view** to clear it. Its selection and width are saved separately from the left sidebar. You can assign **Toggle right sidebar** a shortcut under Hotkeys.

## Formats, syntax, and code highlighting

**Formats** lists Markdown, plain text, and enabled format addons. Open a format's settings to configure it or make Hibi its [default application](../features/file-associations.md).

Use **Syntax** to enable or disable formatting features, and **Code highlighting** to choose which programming languages receive highlighting.

## Addons

Enable or disable addons and themes in the alphabetical **Addons** list. Enabling a addon makes its settings and formats available. **Reset all** restores the default enabled addons without removing installed packages.

Click anywhere on an addon row outside its controls to read its documentation. On a addon’s settings page, click its title. The row’s enable switch and remove button work separately.

### Install an addon

1. Choose **Hibi garden** to browse [available addons](https://hibi.garden/addons).
2. Choose **Install from URL** and enter a public HTTPS Git repository or addon ZIP URL. For a local package, run **Install addon…** from the command palette.
3. Review the package details and trust notice, then install it.
4. Enable the addon when you are ready to use it.

Only install addons you trust. Enabled addons can access your documents and workspace. Git installation requires Git on your computer; private repositories and packages that need a build are unsupported.

**Open addons folder** shows installed packages. Replacing a package starts the new version disabled; removing one moves it to the system trash.

## Notifications

Under **Appearance → Notifications**, choose where notices appear and how long they stay. **Show preview** lets you try the settings. Hovering over or focusing a notice pauses its timer.

## If the editor fails

Choose **Save a copy** on the recovery screen to keep the draft Hibi still has in memory, then try **Reload Hibi**. The recovered copy may not include your latest changes. **Error details** shows information you can copy when reporting a problem; Hibi does not send it automatically.

## App details and licenses

Under **Hibi → Updates**, choose **Recommended nightly** for the latest build that passed every required check, or **Nightly** to also receive builds with failed checks. Recommended nightly is the default. The choice applies across workspaces and stays saved after restarting.

While Hibi is open, installed builds check for updates every six hours by default. Use **Check frequency** to choose one, six, twelve, or twenty-four hours. **Check for updates on startup** also checks shortly after Hibi opens; it is on by default and can be turned off without changing the chosen frequency. **Check now** checks immediately. Choose **Download update** when a newer build is available, then **Restart and install** on macOS, Windows, or a Linux AppImage. Hibi asks you to save or discard unsaved edits before restarting; cancelling keeps the app open. Back up your documents before using a nightly.

On macOS, install Hibi in Applications once. Later updates replace the installed app when you choose **Restart and install**. Downloads are verified before installation. Development builds and Linux builds outside an AppImage cannot update themselves.

Switching channels does not downgrade your installed version. If no build is available yet, or a check or download fails, you can retry from this page.

The **Hibi** page shows the app version and creator. **Sponsor on GitHub** opens [may's sponsor page](https://github.com/sponsors/schmayterling). Open **Open source licenses** in the settings sidebar, then select an entry to read its full notice offline.
