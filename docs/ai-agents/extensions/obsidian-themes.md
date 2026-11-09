# Obsidian themes addon

Technical notes for `src/addons/obsidian-themes/`. The user guide is the addon's `README.md`.

## Files and data

- `store.ts` (main process) reads the vault's configuration folder through `obsidianConfiguration`: `themes/<name>/` folders, one-file `themes/<name>.css` themes from before Obsidian 0.16, `snippets/*.css` and `appearance.json`. It never writes the vault, and it skips symlinks.
- Theme copies live in `<userData>/obsidian-themes/themes/<slug>-<hash12>/` (`theme.css`, `checked.css`, `assets.json`, `hibi-theme.json` with manifest, license text, hash and Style Settings). Snippet copies live in `snippets/<sha256>/`.
- Each vault's choice is `themes.json` in its `obsidianDataPath` overlay: theme, snippets, snippet hashes, Style Settings values and the previous choice. `pruneCopies` removes vault copies that no vault keeps or kept just before. Themes added from a folder stay until removed.
- On open, `active` re-hashes only the kept theme and snippets and copies them again when they changed.
- When `SANITIZER_VERSION` changes, `themeCss`/`snippetCss` check the stored original again.

## Community directory installs

`community.ts` (main process, node-testable) serves the host lane's directory UI through native `profileMethods`, called with `window.hibi.invokeAddonProfile`. The `invoke` channel runs inside the file operation queue, so a download there would hold every file operation and its cancel would wait behind it. Every request goes through `download()` from `src/main/download.ts` with `manualFetch` (Electron net, no cookies, manual redirects), the same bounded transport addon installs use.

- `installRepo({ repo, name, branch?, requestId })` reads `api.github.com/repos/<repo>/releases/latest`. When the release has `theme.css` and `manifest.json` assets under `github.com/<repo>/releases/download/`, those are used and `ref` is the tag. Otherwise it reads `manifest.json` and `theme.css` (or `obsidian.css`) from `raw.githubusercontent.com/<repo>/<branch or HEAD>/`, and records the commit sha from `commits/<branch>` when GitHub returns one. It also reads LICENSE, LICENSE.md or LICENSE.txt at the same version. The manifest name must match the directory name. Files go through a temporary folder in `incoming/` into `installTheme(..., 'community', { repository, ref, commit })`, so checks, hashes and attribution match folder installs. Nothing is applied, and `pruneCopies` never removes community copies.
- `screenshot({ repo, path, branch?, requestId })` returns a PNG, JPEG, GIF or WebP (checked by magic bytes) of at most 2 MiB as a data URL.
- `cancelInstall({ requestId })` aborts either call. The aborted call resolves `{ ok: false, code: 'cancelled' }`.
- Every hop must be HTTPS on api.github.com, github.com, raw.githubusercontent.com, objects.githubusercontent.com or release-assets.githubusercontent.com. Each request has a 30-second deadline and a 10-second stall limit. Size caps: CSS 5 MiB, manifest and license 64 KiB, release JSON 1 MiB.
- Failures are `{ ok: false, code, message }` with code `invalid`, `not-found`, `too-large`, `network`, `name-mismatch`, `unsafe` or `cancelled`. `parseCommunityThemes` validates `community-css-themes.json` entries for the host's directory cache.
- Tests (`tests/obsidian-themes-community.test.mjs`) use recorded GitHub answers through an injected fetch, so nothing goes to the network.

## Sanitizer

`sanitize.ts` tokenizes theme CSS as CSS Syntax Level 3 does, so escaped names such as `\75rl(` or `@\69mport` are seen as the browser sees them. Before the CSS is used, it:

- removes `@import`, `@charset`, `@namespace`, `@property` and unknown at-rules;
- removes any declaration that loads a remote, `file:`, `app:` or `javascript:` URL, a `data:` URL other than an image or font, `expression()`, `behavior` or `-moz-binding`;
- removes `var()`, `env()` and `attr()` inside image functions, typed `attr()`, URL-like strings in custom properties, and `url(#id)` outside SVG references such as `filter`;
- reads its own output back and drops any rule that would load something it did not write itself;
- removes properties that could hide, cover or move the whole page, such as `opacity`, `filter`, `transform`, `display` or `position`, from rules on `html` and `:root`;
- renames a theme's variables that share a name with Hibi's own, such as `--accent`, so they keep working for the theme without changing Hibi;
- checks stored copies again when the checks change;
- replaces images and fonts from the theme's own folder with copies inside the CSS, and removes references that leave the folder;
- refuses themes over 5 MB and snippets over 1 MB.

Every removed rule is listed under the theme on the settings page.

## Page root guard and the way out

`bridge.ts` declares `@layer obsidian-guard, obsidian-compat;` before any theme CSS. For `!important`, any layer beats unlayered rules and the earliest layer beats later ones, so the guard's `!important` rules on `html`/`:root` (opacity, filter, transform, zoom, clip-path, mask, contain, content-visibility, display, visibility, pointer-events) always win. Theme layers are renamed `obsidian-theme-*`, so they can't nest inside the guard. The corner button is a top-layer popover with inline `!important` styles and a closed shadow root. The command is also in the native Addons menu and on a main-process shortcut.

## How themes reach Hibi's interface

All theme CSS goes into one stylesheet that is removed at once when you turn the theme off.

**Variables.** Obsidian themes set Obsidian's variables on `body`. The addon gives `body` Obsidian's default variables, taken from Hibi's current colours, and then reads Hibi's own colour, font and size tokens back from them (`bridge.ts`). A theme that only sets variables therefore recolours Hibi, and a variable a theme leaves alone keeps Hibi's look.

**Selectors.** `body` gets `theme-dark` or `theme-light`. Other Obsidian classes are rewritten to also match the Hibi element that plays the same part, for example `.HyperMD-header-1` becomes `:is(.HyperMD-header-1, .hibi-lp-h1)` (`SELECTOR_ALIASES` in `sanitize.ts`). Hibi's interface and editor redraw their own class names, so classes added to their elements would not last. Settings controls (`.checkbox-container`, `.vertical-tab-*`, `.setting-item`) are left unmatched on purpose so a theme cannot break the settings page.

### Coverage

Measured against the 47 themes that parsed in the 50 most downloaded community themes (`theme-survey`, 2026-10-27):

| Measure | Covered |
| --- | --- |
| Top 30 classes, by number of themes | 24 of 30; 85.8% of their uses |
| Top 50 classes | 40 of 50; 85.8% of their uses |
| Top 100 classes | 66 of 100; 76.3% of their uses |
| Every class use in the survey | 33.4% |
| Top 30 variables themes define | 27 of 30 |
| Top 30 variables themes refer to | 26 of 30 |
| Theme references to documented variables that resolve | 912 of 2,476 (36.8%) |

Covered classes include `.cm-line` and `.modal`, which Hibi already has, and Obsidian's state classes (`is-active`, `is-selected`, `mod-active`, `is-collapsed`), which match Hibi's ARIA and data attributes. While a theme is on, source editors also carry Obsidian's token classes (`.cm-header-N`, `.cm-strong`, `.cm-em`, `.cm-link`, `.cm-url`, `.cm-quote`, `.cm-hr`, `.cm-inline-code`, `.cm-formatting`). The most common classes left out have no Hibi equivalent: the ribbon and side docks (`workspace-ribbon`, `mod-left`, `mod-right`), task list lines, popovers and folder rows. Settings controls (`checkbox-container`, `dropdown`, `vertical-tab-*`) are left out on purpose, and `is-mobile` never matches. Variables left out are `--text-highlight-bg`, `--background-modifier-error`, `--tag-background`, `--header-height`, `--accent-h` and the cyan and orange palette colours. Selector coverage shows which rules can match; it does not measure how close a theme looks to Obsidian.

## Tests

- `tests/obsidian-themes-sanitize.test.mjs`, `obsidian-themes-hostile.test.mjs`, `obsidian-themes-style-settings.test.mjs`, `obsidian-themes-store.test.mjs`: node.
- `tests/obsidian-themes-app.test.mjs`: apply/reset colours, Style Settings, source token classes, re-copy, startup flag.
- `tests/obsidian-themes-security.test.mjs`: Chromium network log per hostile case, escape button and page root under hostile snippets, reset restores every computed style, menu and shortcut.
- Fixture themes are in `tests/obsidian/fixtures/{themes,snippets}` and are hand-written.
