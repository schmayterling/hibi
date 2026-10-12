# Settings

Open Settings from the command palette or top bar. Choose a page in the sidebar, or search below **Back to app** for a setting or enabled addon.

In the command palette, open **Edit keyboard shortcuts**, **Choose colorscheme**, **Markdown flavor**, or **Show sidebar view** to browse related commands. You can also search for a command inside these submenus by name from the main palette.

Use the sidebar button or `Cmd/Ctrl+/` to collapse or expand settings navigation. In a narrow window, it opens over the page and closes when you choose a page or search result. Press Escape or click outside to dismiss it.

## Editor and appearance

Use **Editor** for [tabs, default view, and spell check](editing.md). Use **Appearance** to change [colorschemes](colorschemes.md), the toolbar, and cursor style.

Under **Editor → Modal editing**, Hibi shows the current modal addon and explains how switching works. Hibi allows only one modal addon at a time. Enabling another modal addon asks before disabling the current one. Disabling a modal addon never enables another one automatically.

Turn on **Focus outlines** under **Appearance → Focus** if you want borders around focused buttons and navigation. To reduce animations, enable your system's reduced-motion setting.

Hover over a control briefly to see its compact help tooltip, or reach it with keyboard navigation. Moving away, clicking, typing, or hiding the control dismisses the hint.

**Lowercase interface** displays app text in lowercase without changing documents, typed values, code, or case-sensitive commands.

Under **Appearance → Window**, set **Status bar** to **Show**, **Auto-hide**, or **Hide**. Auto-hide reveals the bar when you move to the bottom edge of the editor or focus one of its controls.

The top bar and its document tabs stay visible while you type. Turn on **Hide top bar while typing** in the same section to fade it while you write; the bar returns when you pause or move the pointer to the top of the window.

**Zen mode** hides navigation, toolbars, and status while you write. Use **Enter zen mode** in the command palette or turn it on in Appearance. Leave with the exit button at the top or **Exit zen mode** in the palette. Your previous layout returns when you leave. You can assign a shortcut under Hotkeys.

## Running in the background

Under **About → General**, turn on **Keep Hibi running in the background** to keep your edits and enabled addons running when you close the main window. This setting is off by default on macOS, Windows, and Linux, and no menu bar or tray icon appears while it is off. With it off, closing behaves as before: Windows and Linux quit after the last window closes, and macOS keeps the app available from the Dock.

When enabled, closing hides the window without discarding unsaved text. Use **Open Hibi** in the menu bar or tray menu to restore the same window, or launch Hibi again. **New quick note** appears when the Quick note addon is enabled, and **Settings** opens the app settings. On Windows, clicking the notification-area icon opens Hibi; on macOS, clicking the menu bar icon opens its menu. Linux tray availability and clicks depend on your desktop environment and its indicator support.

Choose **Quit** from the tray or app menu to stop Hibi. Use `Cmd+Q` on macOS or `Ctrl+Q` on Linux. On Windows, `Ctrl+Q` is available only while background mode is enabled. Hibi still asks about unsaved changes and checks for external file changes when you save. Cancelling keeps Hibi and your edits open. Background mode does not open Hibi at login or hide its Dock icon. See [running in the background](../features/background.md) for more details.

## Autosave

Autosave is off by default. Enable it under **Editor** and choose how long to wait after typing stops. New notes and remote drafts need one manual save to choose a local destination.

Open files keep their autosave timers when you switch tabs. Each file saves after its own typing delay.

If another app changes the file, autosave pauses. Save manually to review the conflict.

## Keyboard shortcuts

Under **Hotkeys**, select a binding and press a new shortcut. Enter saves it and Escape cancels. You can clear individual shortcuts or reset them. Hibi rejects conflicts and reserved shortcuts; menus and the command palette show your current bindings.

## Sidebar views

The dropdown beside the sidebar button lists available views. Use its first item to pin or unpin a titlebar tab for the current view; you can pin up to three. **On this page** shows the document's headings and highlights your current section. See [workspaces](workspaces.md) for navigation and resizing.

The right sidebar starts collapsed with no view selected. Use **Toggle right sidebar**, then **Right sidebar views** to choose **On this page** or an enabled addon view. Choose **No view** to clear it. Its selection and width are saved separately from the left sidebar. You can assign **Toggle right sidebar** a shortcut under Hotkeys.

## Formats, syntax, and code highlighting

**Formats** lists Markdown, plain text, and enabled format addons. Open a format's settings to configure it or make Hibi its [default application](../features/file-associations.md).

Use **Syntax** to enable or disable formatting features, and **Code Highlight** to choose which programming languages receive highlighting.

## Addons

Enable or disable addons and themes in the alphabetical **Addons** list. Enabling a addon makes its settings and formats available. **Reset all** restores the default enabled addons without removing installed packages.

Enabling an addon can ask to enable its required addons too; disabling a provider leaves its consumers enabled but blocked, while documents stay editable under their existing syntax protections.

Choose a category above the list to show only features, formats, themes, or importers. Categories work together with the text filter; choose **All** to see every category. Categories without installed addons are hidden.

**UI preview** is enabled when you run Hibi in development. In a release build, enable it under **Settings → Addons**, then choose **Open UI preview** from the command palette. Edit the sample text, turn on **Show red outlines** to inspect control boundaries, and enter CSS to preview changes across Hibi. Choose **Save CSS** to keep those rules after restart. If saved CSS obscures the interface, choose **Disable custom CSS** from the native Addons menu.

Click anywhere on an addon row outside its controls to read its documentation. On a addon’s settings page, click its title. The row’s enable switch and remove button work separately.

**Connects to** lists an addon's declared HTTPS hosts in its row and settings. Enabling it approves credential-free GET requests to those exact origins. Redirects outside the declared origins, requests with credentials, and requests to local or private addresses still prompt. Hibi only honors declarations in the manifest reviewed by its main process.

### Install an addon

1. Choose **Hibi garden** to browse [available addons](https://hibi.garden/addons).
2. Choose **Install from URL** and enter a public HTTPS Git repository or addon ZIP URL. For a local package, run **Install addon…** from the command palette.
3. Review the package details and trust notice. A single package uses the usual install confirmation. If Hibi finds several packages in nested folders, it lists them together with all installable packages selected. Invalid or blocked packages show a reason and cannot be selected.
4. In the review list, uncheck packages you do not want, then choose **Install selected**. Use `Tab` to move between controls and `Space` to toggle a checkbox.
5. For several packages, review each row's result and close the dialog. Enable successfully installed addons when you are ready to use them.

Required providers install before addons that depend on them. Required providers must already be installed or remain selected. Unchecking a missing provider makes its consumers unavailable with a reason; other selected packages can still install. Keep the review open to select remaining packages or retry failed rows without downloading again. A failed package does not undo successful installations. **Cancel** during installation stops pending work; closing the dialog or pressing `Escape` does the same. Completed installations remain disabled. See [sideloading and sharing](../development/addons/sideloading.md#discovery-and-package-limits) for discovery limits and package layout rules.

Only install addons you trust. Enabled addons can access your documents and workspace. Git installation requires Git on your computer; private repositories and packages that need a build are unsupported.

**Open addons folder** shows installed packages. Replacing a package starts the new version disabled; removing one moves it to the system trash.

## Notifications

Under **Appearance → Notifications**, choose where notices appear and how long they stay. **Show preview** lets you try the settings. Hovering over or focusing a notice pauses its timer.

Some notices lead to related settings. For example, clicking **A Hibi update is available** opens the update section in **About**. These notices show their destination as a button and highlight when you point at them. Clicking a notice follows it and closes the notice.

Run **Focus notifications** from the command palette to move keyboard focus to the newest notice. Press `Enter` to follow it or `Escape` to dismiss it; focus returns to where you were. Arrow keys and `Tab` move between notice buttons, and `Tab` past the last one also returns focus. Notices never take focus on their own, and `Tab` from elsewhere does not move into them. The command has no shortcut by default; assign one under **Hotkeys**.

## If the editor fails

Choose **Save a copy** on the recovery screen to keep the draft Hibi still has in memory, then try **Reload Hibi**. The recovered copy may not include your latest changes. **Error details** shows information you can copy when reporting a problem; Hibi does not send it automatically.

## App details and licenses

Under **About → Updates**, choose **Recommended nightly** for the latest build that passed every required check, or **Nightly** to also receive builds with failed checks. Recommended nightly is the default. The choice applies across workspaces and stays saved after restarting.

While Hibi is open, installed builds check for updates every six hours by default. Use **Check frequency** to choose one, six, twelve, or twenty-four hours. **Check for updates on startup** also checks shortly after Hibi opens; it is on by default and can be turned off without changing the chosen frequency. **Check now** checks immediately. Choose **Download update** when a newer build is available, then **Restart and install** on macOS, Windows, or a Linux AppImage. Hibi asks you to save or discard unsaved edits before restarting; cancelling keeps the app open. Back up your documents before using a nightly.

On macOS, install Hibi in Applications once. Later updates replace the installed app when you choose **Restart and install**. Downloads are verified before installation. Development builds and Linux builds outside an AppImage cannot update themselves.

Switching channels does not downgrade your installed version. If no build is available yet, or a check or download fails, you can retry from this page.

**Workspace settings** is pinned below search. **Editing**, **Interface**, **Addons**, and **Addon settings** each have their own section. Enabled addon pages appear under Addon settings by default; addons can place pages in another section. **About**, **Credits**, and **Diagnostics** (when enabled) follow in a section without a heading. App and Electron versions appear after the last page.

**About** shows the app version and creator. It links to the [documentation](https://docs.hibi.garden), [issue tracker](https://github.com/schmayterling/hibi/issues), [source repository](https://github.com/schmayterling/hibi), [Discord community](https://discord.gg/v9r4cABUP2), and [sponsor page](https://github.com/sponsors/schmayterling). Open **Credits**, then select a license to read its full notice offline. Type in the filter to find a license by package name, version, or license type. Clear the filter to restore the full list.
