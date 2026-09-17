# settings

## sidebar views

view shortcuts sit beside the window controls while the sidebar is expanded. the sidebar toggle always keeps its sidebar icon and sits at the right edge of the expanded sidebar. shortcuts that fit appear before it; the views dropdown keeps every view available at narrower widths. collapsing the sidebar hides the shortcuts and dropdown, leaving only the toggle.

the first dropdown item pins or unpins the current view. up to three pins are remembered and appear first in the shortcuts and dropdown. **In this page** nests headings by level and highlights the section containing the cursor in every editor mode.

## interface text

the interface uses sentence case by default. enable **Lowercase interface** under **Appearance** to display built-in screens, extension panels, tooltips, notifications, and app menus in lowercase. the preference persists across launches. document content, typed field values, code, and case-sensitive Vim commands keep their original spelling.

## autosave

editor settings include an autosave switch (off by default) and a delay from one to thirty seconds after typing stops. its status-bar pill opens those settings and shows off, save first, waiting, saving, saved, or paused. new and remote drafts need one manual save to choose a local destination. external file changes pause autosave; use manual save to review the conflict. autosave uses the same local-history snapshots as manual saves and never opens a file dialog or silently replaces external edits.

**hibi** is the first settings page and the initial selection. it shows the page icon, app name, version, and creator credit using hibi's shared panels and controls. app and Electron versions also remain in the sidebar footer.

**back to app** sits above the settings categories in its own unlabeled sidebar section. it returns to the current document and restores editor focus, like the top-bar back button.

**sponsor on github** opens [may's GitHub Sponsors page](https://github.com/sponsors/schmayterling) in your default browser. this action uses a fixed destination; workspace content and addons cannot supply arbitrary external URLs through it.

## syntax and code highlighting

**syntax** toggles markdown features individually, including each heading level and extension-provided formats. **code highlighting** toggles highlighting per language. both retain the original source. the compact filter/reset row is shared with hotkeys and addons. filtered-out settings remain discoverable in the command palette; navigating to one clears that page’s filter. see [markdown syntax](../extensions/markdown-syntax.md) and [code languages](../extensions/code-languages.md).

## addons

addons are grouped into **enabled** and **disabled**. their metadata identifies **built-in** addons shipped with hibi, **local** developer/folder packages, and **third-party** packages installed from a url. search by name, description, kind, author, or source. **reset all** restores addon enablement defaults without removing packages.

**hibi garden** opens [hibi.garden/addons](https://hibi.garden/addons). **install from url** accepts public https git repositories and addon zip packages. **open plugins folder** reveals the installed package directory. local-folder installation remains available through **install theme or extension…** in the command palette. see [sideloading](../extensions/sideloading.md).

## recovery screen

hibi → diagnostics → **preview explode screen** opens a dismissible preview of the recovery screen. escape or **back to settings** returns without unmounting the editor or changing the document.

when a renderer component fails, the real screen offers **reload hibi**, **save a copy** of the draft still held by the main process, and an **error details** modal with the full stack and a copy button. Escape or the close button returns to recovery, including when previewing it from settings. hibi does not claim unsent edits survived, and it never sends diagnostics automatically. native process crashes retain the operating system’s reload prompt.

## notifications

appearance → notifications controls notification placement (top/bottom, left/middle/right) and automatic dismissal (3, 5, 8, or 10 seconds, or never). **show preview** tries the current settings. notifications slide upward and fade in, with a bottom progress line. hover or keyboard focus pauses the countdown; leaving resumes it. the dismiss button always closes immediately with a short exit fade.

## open source licenses

the bottom section lists application dependencies, bundled colorscheme notices, and addon-provided third-party notices. each row shows the package version when available and license identifier. select a row to read its complete license/notice text in a shared dialog. escape, the close button, or clicking outside dismisses it and returns focus to the row. long text wraps inside the dialog.

the catalog is generated from installed runtime dependency manifests during desktop builds. build tools and Electron's binary installer dependencies are excluded; transitive application packages are included. different installed versions retain separate entries. notices are shipped locally in `out/licenses.json`, so viewing them works offline and no package text is fetched from the network. Electron's additional runtime notices are preserved separately in packaged resources at `licenses/electron-third-party.html`.

maintainers: `scripts/licenses.ts` owns collection and the build-tool exclusion list. missing package notice files fail the build. `src/shared/theme-licenses.ts` supplies the pinned colorscheme notices. package upgrades regenerate the catalog automatically.
